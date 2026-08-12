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

  /**
   * ⚠️ UPDATED 2026-08-12 — this test previously asserted the UP-FRONT guard
   * `if (wantsScrape && scrapeBudget <= 0) continue;`, i.e. it encoded the bug
   * as the expectation.
   *
   * That guard predated FB_MEDIA_VIEW_METRICS_ENABLED. Once the feed capture
   * began carrying a real `post_media_view` number, skipping the row up-front
   * discarded a GOOD measurement to protect a fallback that was no longer
   * needed — and, combined with the breaker counting API successes as scrape
   * misses, it left 94.3% of FB reels unmeasured with the backlog growing.
   *
   * The protection it provided is preserved, but moved AFTER the capture where
   * it can be decided on evidence: defer only when the row wanted a view count,
   * no scrape was available, AND the API supplied no impressions either.
   */
  it("still refuses to stamp metricsSyncedAt on a valueless capture — now decided on evidence", () => {
    expect(src).toMatch(/shouldDeferUnmeasured\(/);
    // The decision must consider what actually came back, not just the budget.
    expect(src).toMatch(/analytics\.metricsAvailable\?\.impressions/);
    // …and the discarding up-front guard must NOT come back.
    expect(src).not.toMatch(/if \(wantsScrape && scrapeBudget <= 0\) continue;/);
  });

  it("has an env kill switch that defaults ON (fail-open)", () => {
    // A blocked IP degrades to today's behavior (impressions declared false ⇒
    // "—"), never to a wrong number — so ON is the safe default in code.
    expect(src).toMatch(/EXTERNAL_VIEW_SCRAPE_ENABLED !== "false"/);
  });

  /**
   * ⚠️ UPDATED 2026-08-12 — the `scrapeBudget = 0` assertion moved: the breaker
   * arithmetic now lives in the pure, unit-tested `stepScrapeBudget`
   * (apps/worker/src/lib/scrape-budget.ts), which returns `budget: 0` on the
   * tripping transition. Asserting the inline assignment here would forbid that
   * extraction. The BEHAVIOUR is locked far more precisely in
   * scrape-budget.test.ts, including the regression witness.
   */
  it("trips a circuit breaker after consecutive misses (soft IP ban)", () => {
    expect(src).toMatch(/SCRAPE_BREAKER_MISSES/);
    expect(src).toMatch(/consecutiveScrapeMisses/);
    expect(src).toMatch(/stepScrapeBudget\(/);
  });

  /**
   * 🔴 The regression this file exists to prevent, asserted at the source level:
   * budget/breaker accounting must key off whether a scrape ACTUALLY RAN, never
   * off `source !== "scrape"` — which is also a clean API success.
   */
  it("never re-derives a scrape miss from the source field", () => {
    // Comments are stripped first — the prohibition is on CODE. The explanatory
    // note above the fix necessarily quotes the banned expression.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(codeOnly).not.toMatch(/source\s*[!=]==?\s*["']scrape["']/);
    expect(codeOnly).toMatch(/allowScrape: scrapeAllowed/);
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
