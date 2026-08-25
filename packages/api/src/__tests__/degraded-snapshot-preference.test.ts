import { describe, it, expect } from "vitest";
import { fetchChannelStatRows } from "../routers/analytics.router";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A FAILED capture must never hide data we already hold.
 *
 * ── The production incident this fixes (measured 2026-08-25) ──────────────────
 * When a Graph call degrades (dead token, deleted media), the analytics worker
 * still writes an AnalyticsSnapshot — with every metric zero and `metadata.degraded`
 * set. Because every read path selects the LATEST snapshot per target, that zero row
 * becomes the displayed value and PERMANENTLY buries the real numbers captured
 * earlier. For a post that has since been deleted on the platform it can never be
 * re-measured, so the zeros are forever.
 *
 * Measured on prod: 64 Instagram targets carried a degraded latest snapshot; 25 of
 * them had previously captured real engagement. Preferring the last CLEAN snapshot
 * restores **68,276 views and 630 likes** that the page was rendering as 0.
 *
 * Live-probed to establish the cause rather than guess it: the accounts' tokens
 * answered fine (`archivebollywood` media_count=10,717) while the stored media ids
 * returned `#100/33 "Object ... does not exist"`. So the app's PERMISSIONS were never
 * the problem — the posts were removed on Instagram, and our own zero-write is what
 * erased the history from view.
 *
 * The ordering is `(degraded IS NULL) DESC, snapshotAt DESC`: clean captures first,
 * newest within each group. A target that has ONLY degraded captures still returns
 * its newest one, so `hasSnapshot` semantics are unchanged for it.
 */

const ROOT = join(__dirname, "..", "..", "..", "..");
const src = readFileSync(join(ROOT, "packages/api/src/routers/analytics.router.ts"), "utf8");

function capturingPrisma() {
  const calls: Array<{ sql: string }> = [];
  return {
    calls,
    client: {
      $queryRawUnsafe: (sql: string) => {
        calls.push({ sql });
        return Promise.resolve([]);
      },
    } as any,
  };
}

const PREFER_CLEAN = /ORDER BY\s+\(s2\.metadata->>'degraded'\s+IS NULL\)\s+DESC,\s*s2\."snapshotAt"\s+DESC/;

describe("fetchChannelStatRows prefers the last CLEAN snapshot", () => {
  it("orders the latest-snapshot LATERAL by clean-first", async () => {
    const { calls, client } = capturingPrisma();
    await fetchChannelStatRows(client, "org_1", new Date(0), new Date(), undefined);
    expect(calls[0]!.sql).toMatch(PREFER_CLEAN);
  });

  it("still selects exactly ONE snapshot per target", async () => {
    const { calls, client } = capturingPrisma();
    await fetchChannelStatRows(client, "org_1", new Date(0), new Date(), undefined);
    // The LIMIT 1 is what makes this a per-target pick rather than a fan-out.
    // Window is generous: the ordering carries a long explanatory comment.
    expect(calls[0]!.sql).toMatch(/FROM "AnalyticsSnapshot" s2[\s\S]{0,1200}LIMIT 1/);
  });
});

describe("fetchPostReportRows prefers the last CLEAN snapshot too", () => {
  it("applies the same ordering, so Reports and Channel Performance agree", () => {
    // Asserted at source level: the function is not exported. Reports and the
    // aggregate MUST pick the same row or the same post shows two different
    // numbers on one page — the class of same-page disagreement this repo has
    // fixed repeatedly.
    const start = src.indexOf("async function fetchPostReportRows(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\nexport const analyticsRouter", start));
    expect(body).toMatch(PREFER_CLEAN);
  });

  it("keeps the at-age windowTag filter intact", () => {
    const start = src.indexOf("async function fetchPostReportRows(");
    const body = src.slice(start, src.indexOf("\nexport const analyticsRouter", start));
    // at_age mode must still pin to its checkpoint row; the clean preference
    // applies WITHIN that filter, never instead of it.
    expect(body).toMatch(/windowTag' = \$3/);
  });
});
