import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportableMetrics } from "../lib/platform-metrics";

/**
 * Locks the per-capture capability override INTO the only production caller.
 *
 * ⚠️ Why a source assertion rather than a procedure test. The defect (found
 * 2026-08-08) was a MISSING ARGUMENT:
 *
 *     reportableMetrics(orgChannels.map((c) => c.platform as string))
 *
 * `declaredAvailable` was never passed, so `analytics.engagement` consulted only
 * the static per-platform map. That map marks FACEBOOK impressions/reach
 * unavailable, so an org whose Facebook channels DO report video views had the
 * Impressions tile and the "Total Views" card dropped — while `perChannelStats`,
 * which DOES apply the override through `effectiveChannelUnavailable`, rendered
 * those same numbers in the table directly below. One page, two answers.
 *
 * The pure-function tests below already passed before the fix (the function was
 * always correct), which is exactly why they did not catch it — only the CALL
 * was wrong. And a mocked-Prisma procedure test cannot help either: this
 * codebase's standing rule is not to trust a mocked Prisma for anything touching
 * `fetchChannelStatRows`' raw SQL. So the wiring itself is asserted, mirroring
 * channel-soft-delete.test.ts.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("analytics.engagement passes the per-capture override", () => {
  const src = read("packages/api/src/routers/analytics.router.ts");

  it("never calls reportableMetrics with only the platform list", () => {
    // A single-argument call is the bug. Match the call and assert it spans a
    // second argument before its closing paren.
    const calls = [...src.matchAll(/reportableMetrics\(([\s\S]{0,240}?)\)\s*;/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) {
      expect(args).toMatch(/declaredAvailable/);
    }
  });

  it("feeds it from the SAME statRows the totals are summed from", () => {
    // Deriving capability from a different population than the numbers would
    // reintroduce the disagreement in the other direction.
    expect(src).toMatch(/statRows\.map\(\s*\(r\)\s*=>\s*r\.declaredAvailable\s*\)/);
  });
});

describe("reportableMetrics honors a capture-level override (pure)", () => {
  it("keeps impressions for a Facebook-only org when a capture reported views", () => {
    expect(reportableMetrics(["FACEBOOK"])).not.toContain("impressions");
    expect(reportableMetrics(["FACEBOOK"], [{ impressions: true }])).toContain("impressions");
  });

  it("ignores undefined entries from channels with no captures", () => {
    expect(reportableMetrics(["FACEBOOK"], [undefined, { impressions: true }])).toContain(
      "impressions"
    );
  });

  it("does NOT widen from a false declaration", () => {
    expect(reportableMetrics(["FACEBOOK"], [{ impressions: false }])).not.toContain("impressions");
  });
});
