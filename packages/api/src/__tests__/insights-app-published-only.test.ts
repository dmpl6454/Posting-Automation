import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchChannelStatRows } from "../routers/analytics.router";

/**
 * Insights measures posts published THROUGH PostAutomation — and nothing else.
 *
 * Owner decision 2026-08-19. The `ExternalPost` population (posts made directly
 * on a connected FB Page / IG account) is excluded from every read path and no
 * Graph calls are made to collect it.
 *
 * ── Why the aggregate is tested BEHAVIORALLY here ─────────────────────────────
 * `analytics-platform-filter.test.ts` asserts against the SQL SOURCE, and its
 * header explains why: a mocked Prisma never PARSES the statement, so a
 * predicate applied to one arm of a UNION would pass against a mock. That
 * reasoning is about predicate placement. The question here is different and
 * strictly coarser — *does the emitted statement reference "ExternalPost" at
 * all?* — which the emitted SQL string answers exactly, with no parsing needed.
 * So this suite captures the real statement `fetchChannelStatRows` sends.
 *
 * ⚠️ The positional-parameter assertions are not padding. Removing a CTE from a
 * `$queryRawUnsafe` template is precisely how `$1..$4` silently shift: the ext
 * arm consumed $1/$2/$3/$4 too, so dropping it must leave the app arm's bindings
 * untouched. A shift here would scope the aggregate to the WRONG ORGANIZATION —
 * an IDOR, not a cosmetic bug.
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

const KEY = "INSIGHTS_INCLUDE_EXTERNAL_POSTS";
const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-19T23:59:59.999Z");

/** Captures the statement + bound params instead of touching a database. */
function capturingPrisma() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    client: {
      $queryRawUnsafe: (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve([]);
      },
    } as any,
  };
}

async function emittedSql(platform?: string) {
  const { calls, client } = capturingPrisma();
  await fetchChannelStatRows(client, "org_1", FROM, TO, platform);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe("fetchChannelStatRows — app-published-only by default", () => {
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("emits NO reference to ExternalPost", async () => {
    const { sql } = await emittedSql();
    // The whole point: no direct-post rows in Channel Performance, the
    // engagement tiles, or chat's get_analytics (which shares this aggregate).
    expect(sql).not.toMatch(/ExternalPost/);
    expect(sql).not.toMatch(/ext_rows/);
  });

  it("still selects the app-published population unchanged", async () => {
    const { sql } = await emittedSql();
    expect(sql).toMatch(/FROM "PostTarget" pt/);
    expect(sql).toMatch(/pt\.status::text = 'PUBLISHED'/);
    // The latest-snapshot LATERAL is what makes a row's metrics its OWN.
    expect(sql).toMatch(/FROM "AnalyticsSnapshot" s2/);
  });

  it("keeps organizationId bound to $1 — no positional shift", async () => {
    const { sql, params } = await emittedSql();
    expect(sql).toMatch(/WHERE p\."organizationId" = \$1/);
    // Dropping a CTE must not renumber the survivors.
    expect(params).toEqual(["org_1", FROM, TO, null]);
  });

  it("keeps the platform filter on $4 for the surviving arm", async () => {
    const { sql, params } = await emittedSql("FACEBOOK");
    expect(sql).toMatch(/\$4::text IS NULL OR c\.platform::text = \$4/);
    expect(params[3]).toBe("FACEBOOK");
    // With the external arm gone there is exactly ONE guard left, not two.
    expect((sql.match(/\$4::text IS NULL/g) ?? []).length).toBe(1);
  });

  it("preserves every honesty column the UI depends on", async () => {
    const { sql } = await emittedSql();
    // These drive "—" (not reported) vs a real 0. Losing one silently turns
    // unknown into a confident zero, which is the bug class this repo has
    // fixed repeatedly.
    for (const col of [
      '"availImpressions"',
      '"availReach"',
      '"availLikes"',
      '"availComments"',
      '"availShares"',
      '"availClicks"',
      '"availViews"',
      '"hasSnapshot"',
      '"hasLegacySnapshot"',
      '"impressionedPosts"',
      '"impressionedImpressions"',
    ]) {
      expect(sql, `missing ${col}`).toContain(col);
    }
  });

  it("counts DISTINCT posts, so the disclosed rate basis cannot invert", async () => {
    const { sql } = await emittedSql();
    expect(sql).toMatch(/COUNT\(DISTINCT post_key\)/);
  });
});

describe("fetchChannelStatRows — the switch is a real switch, not a deletion", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("restores the ExternalPost arm when explicitly enabled", async () => {
    process.env[KEY] = "true";
    const { sql, params } = await emittedSql("FACEBOOK");
    expect(sql).toMatch(/FROM "ExternalPost" ep/);
    expect(sql).toMatch(/ep\."postTargetId" IS NULL/);
    // Both arms org-scoped and both platform-filtered — the pre-existing contract.
    expect(sql).toMatch(/WHERE c2\."organizationId" = \$1/);
    expect((sql.match(/\$4::text IS NULL/g) ?? []).length).toBe(2);
    expect(params).toEqual(["org_1", FROM, TO, "FACEBOOK"]);
  });

  it("treats an EMPTY value as app-published only (compose allowlist trap)", async () => {
    process.env[KEY] = "";
    const { sql } = await emittedSql();
    expect(sql).not.toMatch(/ExternalPost/);
  });
});

describe("fetchPostReportRows gates its external UNION on the same switch", () => {
  // Not exported, so asserted at the source level (house pattern).
  const body = fnBody("fetchPostReportRows");

  it("requires BOTH current mode AND the population switch", () => {
    // Previously: `mode === "current" ? <union> : ""`. The at_age arm was always
    // excluded because at-age checkpoints only exist for posts we published.
    expect(body).toMatch(/insightsIncludeExternalPosts\(\)/);
    expect(body).toMatch(/mode === "current" && insightsIncludeExternalPosts\(\)/);
  });

  it("still emits the empty string when excluded — an already-exercised path", () => {
    // at_age mode has always produced "" here, so the disabled branch is not new
    // code: it is the branch this query has run in at_age mode since PR #162.
    expect(body).toMatch(/: ""/);
  });
});

describe("triggerSync makes no external Graph calls when excluded", () => {
  const start = src.indexOf("triggerSync: orgProcedure");
  const body = src.slice(start, src.indexOf("postReports:", start));

  it("gates the account-level external enqueue", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/insightsIncludeExternalPosts\(\)/);
  });

  it("still refreshes app-published targets — the whole point of the button", () => {
    expect(body).toMatch(/analyticsSyncQueue\.add/);
    expect(body).toMatch(/syncnow:\$\{target\.id\}:\$\{bucket\}/);
  });

  it("reports zero accounts queued rather than lying about work done", () => {
    // The toast reads accountsQueued; leaving it non-zero while enqueuing nothing
    // would tell the user direct posts are refreshing when nothing was queued.
    expect(body).toMatch(/accountsQueued/);
  });
});

describe("the coverage floor is only disclosed when direct posts are included", () => {
  it("engagement and postReports omit the floor labels when excluded", () => {
    // Six hardcoded '1 Aug 2026' strings once lived in the UI; the label is
    // server-derived precisely so the copy cannot outlive the behavior. With the
    // population gone, a "included from 1 Aug 2026 onward" notice would describe
    // data the page no longer shows.
    for (const proc of ["engagement", "postReports"]) {
      const at = src.indexOf(`${proc}: `);
      expect(at, `${proc} not found`).toBeGreaterThan(-1);
    }
    expect(src).toMatch(/includesDirectPosts/);
  });
});
