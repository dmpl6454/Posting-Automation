import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-platform Insights view.
 *
 * ⚠️ Asserted against the SQL SOURCE, not through a mocked Prisma. Both
 * aggregates are `$queryRawUnsafe`, so a mock never parses the statement — a
 * predicate applied to only ONE arm of the UNION, or an off-by-one positional
 * parameter, would "pass" against a mock while silently returning the wrong
 * population in production. The real-Postgres coverage lives in the
 * `LIVE_E2E=1` suites.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const src = readFileSync(join(ROOT, "packages/api/src/routers/analytics.router.ts"), "utf8");

/** Body of a named async function, up to the next top-level `async function`. */
function fnBody(name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\nasync function ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("fetchChannelStatRows applies the platform filter to BOTH union arms", () => {
  const body = fnBody("fetchChannelStatRows");

  it("filters the app-published arm on c.platform", () => {
    expect(body).toMatch(/\$4::text IS NULL OR c\.platform::text = \$4/);
  });

  it("filters the external arm on c2.platform", () => {
    // Filtering only app_rows would leave every platform's DIRECT posts in the
    // totals — a "Facebook" view still summing Instagram reels.
    expect(body).toMatch(/\$4::text IS NULL OR c2\.platform::text = \$4/);
  });

  it("binds the platform as a PARAMETER, never interpolated", () => {
    expect(body).toMatch(/platform \?\? null/);
    // A template hole next to `platform` in the SQL string would be injection.
    expect(body).not.toMatch(/platform::text = '\$\{/);
  });

  it("keeps organizationId in the WHERE of both arms (IDOR history)", () => {
    expect(body).toMatch(/WHERE p\."organizationId" = \$1/);
    expect(body).toMatch(/WHERE c2\."organizationId" = \$1/);
  });

  it("defaults to EVERY platform when none is supplied", () => {
    // `$4::text IS NULL OR ...` is what makes the un-filtered call byte-identical
    // to the pre-2026-08-08 behavior.
    const guards = body.match(/\$4::text IS NULL/g) ?? [];
    expect(guards.length).toBe(2);
  });
});

describe("fetchPostReportRows applies it to both arms too", () => {
  const body = fnBody("fetchPostReportRows");

  it("computes the parameter index dynamically (at_age adds a param)", () => {
    // A hardcoded $4 would silently bind the LIMIT in at_age mode.
    expect(body).toMatch(/const platformIdx = params\.length/);
    expect(body).toMatch(/platformFilterApp = .*\$\$\{platformIdx\}|\$\{platformIdx\}/);
  });

  it("filters the app arm and the external arm", () => {
    expect(body).toMatch(/platformFilterApp/);
    expect(body).toMatch(/platformFilterExt/);
    expect(body).toMatch(/c\.platform::text = \$\$\{platformIdx\}|c\.platform::text = \$\{/);
    expect(body).toMatch(/c2\.platform::text = \$\$\{platformIdx\}|c2\.platform::text = \$\{/);
  });

  it("MUST filter server-side — the query is capped by limit", () => {
    // A client-side filter would drop a platform whose rows all sit past the
    // cap: a cap that changes a displayed value, which is a bug here.
    expect(body).toMatch(/LIMIT \$\$\{limitIdx\}|LIMIT \$\{limitIdx\}/);
    expect(body).toMatch(/params\.push\(platform \?\? null\)/);
  });
});

describe("procedure wiring", () => {
  it("groupStats accepts platform and DELIBERATELY ignores it", () => {
    const start = src.indexOf("groupStats: orgProcedure");
    const body = src.slice(start, start + 3000);
    expect(body).toMatch(/ACCEPTED AND DELIBERATELY IGNORED/);
    // A ChannelGroup may span platforms, so a filtered group is not that group.
    expect(body).not.toMatch(/fetchChannelStatRows\([^)]*input\.platform/s);
  });

  it("perChannelStats narrows the CHANNEL list with the same predicate", () => {
    const start = src.indexOf("perChannelStats: orgProcedure");
    const body = src.slice(start, start + 3000);
    // Filtering the stat rows but not the channel list would render empty rows
    // for the other platforms rather than removing them.
    expect(body).toMatch(/input\.platform \? \{ platform: input\.platform as any \} : \{\}/);
    expect(body).toMatch(/fetchChannelStatRows\(\s*ctx\.prisma,\s*ctx\.organizationId,\s*from,\s*to,\s*input\.platform/s);
  });

  it("platformsInWindow is UNFILTERED so the pills survive a selection", () => {
    const start = src.indexOf("platformsInWindow: orgProcedure");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 900);
    expect(body).toMatch(/distinct: \["platform"\]/);
    // Scoped to the org, but NOT to the selected platform or the date window.
    expect(body).toMatch(/organizationId: ctx\.organizationId/);
    expect(body).not.toMatch(/input\.platform/);
  });

  it("every platform-aware procedure stays orgProcedure (USER-readable)", () => {
    for (const name of ["engagement", "perChannelStats", "groupStats", "platformsInWindow"]) {
      expect(src).toMatch(new RegExp(`${name}: orgProcedure`));
    }
  });
});
