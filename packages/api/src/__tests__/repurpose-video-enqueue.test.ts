/**
 * Phase 2b Task 3 — the repurpose mutation now ENQUEUES video generation
 * (reel / seedance_video) to `repurposeVideoQueue` instead of generating it
 * synchronously on the request thread. The worker (T2) consumes the job,
 * generates + uploads the video, and delivers the result over the progress SSE.
 *
 * This suite locks the pure `buildVideoJobData` helper that assembles the
 * RepurposeVideoJobData payload:
 *   - the enqueued `progressId` is the RAW client id (NOT scoped — the worker
 *     scopes it exactly once via scopedProgressId), and
 *   - the reel / seedance sub-shapes carry the fields the worker reads.
 *
 * `@postautomation/queue` is mocked so importing the router never opens a real
 * Redis/BullMQ connection at module load (mirrors chat-action-idempotency.test).
 */
import { describe, it, expect, vi } from "vitest";

/* ── Queue mock: capture repurposeVideoQueue.add calls + avoid a real connection ── */
const repurposeVideoAdd = vi.fn(async (..._a: any[]) => undefined);
vi.mock("@postautomation/queue", () => ({
  repurposeVideoQueue: { add: (...a: any[]) => repurposeVideoAdd(...a) },
  pushProgress: vi.fn(async () => undefined),
  finishProgress: vi.fn(async () => undefined),
  scopedProgressId: (userId: string, id: string) => `${userId}:${id}`,
}));

import { buildVideoJobData } from "../routers/repurpose.router";

describe("buildVideoJobData", () => {
  it("assembles a reel job with the RAW (unscoped) progressId and ordered slideUrls", () => {
    const job = buildVideoJobData({
      format: "reel",
      userId: "u1",
      organizationId: "o1",
      progressId: "rep-x",
      theme: "light",
      reel: { slideUrls: ["a", "b"], voiceOver: false, bgMusic: true },
    });

    expect(job.format).toBe("reel");
    expect(job.userId).toBe("u1");
    expect(job.organizationId).toBe("o1");
    expect(job.theme).toBe("light");
    // RAW progressId — the worker scopes it ONCE, so it must NOT be pre-scoped.
    expect(job.progressId).toBe("rep-x");
    expect(job.progressId).not.toContain("u1:rep-x");
    expect(job.reel?.slideUrls).toHaveLength(2);
    expect(job.reel?.slideUrls).toEqual(["a", "b"]);
    expect(job.reel?.voiceOver).toBe(false);
    expect(job.reel?.bgMusic).toBe(true);
    // No seedance block on a reel job.
    expect(job.seedance).toBeUndefined();
  });

  it("carries optional voiceType + voiceScript through on a reel job", () => {
    const job = buildVideoJobData({
      format: "reel",
      userId: "u1",
      organizationId: "o1",
      progressId: "rep-y",
      theme: "dark",
      reel: {
        slideUrls: ["s0"],
        voiceOver: true,
        bgMusic: false,
        voiceType: "nova",
        voiceScript: "narration text",
      },
    });
    expect(job.reel?.voiceType).toBe("nova");
    expect(job.reel?.voiceScript).toBe("narration text");
  });

  it("assembles a seedance job with scenes/title/description/duration", () => {
    const job = buildVideoJobData({
      format: "seedance_video",
      userId: "u1",
      organizationId: "o1",
      progressId: "rep-z",
      theme: "gradient",
      seedance: { scenes: ["s1"], title: "T", description: "D", duration: 8 },
    });

    expect(job.format).toBe("seedance_video");
    expect(job.progressId).toBe("rep-z");
    expect(job.theme).toBe("gradient");
    expect(job.seedance?.scenes).toEqual(["s1"]);
    expect(job.seedance?.title).toBe("T");
    expect(job.seedance?.description).toBe("D");
    expect(job.seedance?.duration).toBe(8);
    // No reel block on a seedance job.
    expect(job.reel).toBeUndefined();
  });
});
