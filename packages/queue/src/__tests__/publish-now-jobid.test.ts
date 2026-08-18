import { describe, it, expect } from "vitest";
import { PUBLISH_NOW_DEDUPE_WINDOW_MS, buildPublishNowJobId } from "../publish-now-jobid";

/**
 * `post.publishNow` — the Retry button — used to pass NO jobId at all, so BullMQ
 * assigned a fresh auto-increment id on every call. Verified in production Redis
 * during the 2026-08-13 post-mortem: target `cmsrxo9tr0008nq0im115u236` was
 * enqueued as jobs 1576349 and 1576351, 81 seconds apart, from two Retry clicks.
 * Each of those jobs carried `attempts: 3`, so two clicks bought up to six
 * platform writes.
 *
 * Deduplication was not "defeated" — it was structurally impossible. This id
 * makes it possible.
 */
describe("buildPublishNowJobId", () => {
  // Mid-bucket on purpose — see the boundary test below for why that matters.
  const MID_BUCKET = 29_777_522 * PUBLISH_NOW_DEDUPE_WINDOW_MS + 1_000;

  it("collapses repeated clicks on the same target inside one window", () => {
    expect(buildPublishNowJobId("tgt1", MID_BUCKET)).toBe(
      buildPublishNowJobId("tgt1", MID_BUCKET + 5_000)
    );
  });

  it("does NOT collapse a click pair that straddles a bucket boundary", () => {
    // Documented limitation, asserted rather than hidden: a fixed window has
    // edges, so two clicks seconds apart can still produce two jobs. That is
    // tolerable ONLY because dedup is a convenience here — the guarantee that a
    // duplicate JOB cannot become a duplicate POST is the worker's atomic claim
    // plus PostTarget.ambiguousAt. Never treat this id as the safety mechanism.
    const boundary = 29_777_523 * PUBLISH_NOW_DEDUPE_WINDOW_MS;
    expect(buildPublishNowJobId("tgt1", boundary - 1)).not.toBe(
      buildPublishNowJobId("tgt1", boundary + 1)
    );
  });

  it("still lets a deliberate retry through once the window has passed", () => {
    const later = MID_BUCKET + PUBLISH_NOW_DEDUPE_WINDOW_MS * 2;
    expect(buildPublishNowJobId("tgt1", MID_BUCKET)).not.toBe(buildPublishNowJobId("tgt1", later));
  });

  it("never collapses two different targets", () => {
    expect(buildPublishNowJobId("tgt1", MID_BUCKET)).not.toBe(buildPublishNowJobId("tgt2", MID_BUCKET));
  });

  it("has EXACTLY three colon-separated segments — BullMQ rejects other counts", () => {
    // Same constraint as sched:/atage:/avatar:/supertext: ids.
    const id = buildPublishNowJobId("cmsrxo9tr0008nq0im115u236", 1_786_651_375_968);
    expect(id.split(":")).toHaveLength(3);
    expect(id.startsWith("pubnow:")).toBe(true);
  });

  it("carries no raw timestamp — that is what made every id unique", () => {
    expect(buildPublishNowJobId("tgt1", MID_BUCKET)).not.toContain(String(MID_BUCKET));
  });

  it("the window is short enough that a human re-click is not silently swallowed for long", () => {
    expect(PUBLISH_NOW_DEDUPE_WINDOW_MS).toBeGreaterThanOrEqual(30_000);
    expect(PUBLISH_NOW_DEDUPE_WINDOW_MS).toBeLessThanOrEqual(120_000);
  });
});
