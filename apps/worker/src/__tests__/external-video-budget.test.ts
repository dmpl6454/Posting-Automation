import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The scrape budget and its safety properties, asserted against the worker
 * source.
 *
 * ⚠️ Why source assertions. The behavior under test is an ORDERING property of
 * a loop that also does Prisma writes and Graph I/O — "when the budget runs out,
 * STOP rather than fall through". Reproducing that through a mocked Prisma +
 * mocked provider would mostly test the mocks, while the thing that actually
 * breaks (someone deleting the `continue` and letting a feed-only capture set
 * metricsSyncedAt) is a two-line edit this catches directly. Mirrors
 * channel-soft-delete.test.ts.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const src = readFileSync(
  join(ROOT, "apps/worker/src/workers/external-post-sync.worker.ts"),
  "utf8"
);

describe("scrape budget", () => {
  it("is SEPARATE from METRICS_PER_RUN", () => {
    // A scrape costs ~2.1s vs ~0.3s for a Graph call; sharing one budget would
    // let 150 scrapes monopolise the box.
    expect(src).toMatch(/EXTERNAL_SCRAPE_PER_RUN/);
    expect(src).toMatch(/let scrapeBudget/);
  });

  it("STOPS processing video-like rows once exhausted — never falls through", () => {
    // ⚠️ The load-bearing line. A feed-only capture would set metricsSyncedAt,
    // and needsMetrics would then hide the post for a WEEK before its views
    // could be read. Leaving it unmeasured keeps it first in the next queue.
    expect(src).toMatch(/if \(wantsScrape && scrapeBudget <= 0\) continue;/);
  });

  it("has an env kill switch that defaults ON (fail-open)", () => {
    // A blocked IP degrades to today's behavior (impressions declared false ⇒
    // "—"), never to a wrong number — so ON is the safe default in code.
    expect(src).toMatch(/EXTERNAL_VIEW_SCRAPE_ENABLED !== "false"/);
  });

  it("trips a circuit breaker after consecutive misses (soft IP ban)", () => {
    expect(src).toMatch(/SCRAPE_BREAKER_MISSES/);
    expect(src).toMatch(/consecutiveScrapeMisses/);
    expect(src).toMatch(/scrapeBudget = 0/);
  });

  it("never spends budget on app-published rows", () => {
    // Read paths union only `postTargetId IS NULL`, so scraping an
    // app-published row buys nothing.
    expect(src).toMatch(/p\.postTargetId === null/);
  });

  it("only FACEBOOK takes the recovery path", () => {
    expect(src).toMatch(/platform === "FACEBOOK" &&/);
  });

  it("gates on the TOTAL predicate, not mediaType === 'video'", () => {
    // mediaType carries two Meta vocabularies (media_type ∪ status_type), so an
    // equality check silently skips every row labelled `added_video`.
    expect(src).toMatch(/isFacebookVideoLike\(\{/);
    expect(src).not.toMatch(/mediaType === "video"/);
  });
});

describe("listing must not demote a known video", () => {
  it("writes mediaType/productType only when the listing supplied them", () => {
    // The old unconditional `?? null` let ONE attachment-less listing response
    // null a known-video row, permanently removing it from the recovery path.
    expect(src).toMatch(/\.\.\.\(summary\.mediaType \? \{ mediaType: summary\.mediaType \} : \{\}\)/);
    expect(src).toMatch(/\.\.\.\(summary\.productType \? \{ productType: summary\.productType \} : \{\}\)/);
  });

  it("persists the resolved video id so the resolve never repeats", () => {
    expect(src).toMatch(/resolvedVideoId: summary\.videoId/);
    expect(src).toMatch(/videoResolvedAt: new Date\(\)/);
  });
});

describe("honesty is preserved end to end", () => {
  it("stores metricsAvailable EXACTLY as the provider declared it", () => {
    // An omitted key reads as AVAILABLE downstream.
    expect(src).toMatch(/metricsAvailable: \(analytics\.metricsAvailable \?\? null\) as any/);
  });

  it("an unmeasured post keeps metricsSyncedAt NULL (renders — not 0)", () => {
    // metricsSyncedAt is only ever written alongside a real capture.
    const writes = src.match(/metricsSyncedAt: new Date\(\)/g) ?? [];
    expect(writes.length).toBe(1);
  });
});
