/**
 * PR-5 — per-channel unique AI captions (PostTarget.contentOverride + async
 * caption-fanout worker). Locks the API-side contract:
 *
 *  1. planCaptionFanout matrix — the single decision helper both entry points
 *     (post.create + chat publish_now/schedule_post) use: fanout ONLY when
 *     uniqueCaptions === true AND >1 channel; pendingSchedule ONLY when the
 *     post would otherwise have been SCHEDULED.
 *  2. assertTargetEditable — the IDOR guard behind post.updateTargetContent:
 *     cross-org and missing targets are indistinguishable (NOT_FOUND, no
 *     existence leak); PUBLISHED targets are immutable.
 *  3. WIRING LOCKS (same style as app-role-gating.test.ts) — read the router
 *     sources and assert: uniqueCaptions=true parks the post as DRAFT and
 *     enqueues exactly one deduped caption-fanout job; false keeps today's
 *     path; chat publish_now SKIPS the direct per-target enqueue on the
 *     fanout path; and the pre-existing guard order (enforcePlanLimit →
 *     assertChannelsOwned → assertMediaOwned) is untouched. This repo has no
 *     full tRPC caller harness — source locks are the established pattern.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planCaptionFanout, captionFanoutJobId } from "../lib/caption-fanout";
import { assertTargetEditable } from "../routers/post.router";

describe("planCaptionFanout matrix", () => {
  it("enables fanout only for uniqueCaptions=true with >1 channel", () => {
    expect(planCaptionFanout({ uniqueCaptions: true, channelCount: 2, scheduledAt: new Date() })).toEqual({
      enabled: true,
      pendingSchedule: true,
    });
    expect(planCaptionFanout({ uniqueCaptions: true, channelCount: 60, scheduledAt: "2026-07-18T10:00:00.000Z" })).toEqual({
      enabled: true,
      pendingSchedule: true,
    });
  });

  it("single-channel and channel-less posts keep the shared path", () => {
    expect(planCaptionFanout({ uniqueCaptions: true, channelCount: 1, scheduledAt: new Date() })).toEqual({
      enabled: false,
      pendingSchedule: false,
    });
    expect(planCaptionFanout({ uniqueCaptions: true, channelCount: 0, scheduledAt: null })).toEqual({
      enabled: false,
      pendingSchedule: false,
    });
  });

  it("uniqueCaptions=false is always the existing path", () => {
    expect(planCaptionFanout({ uniqueCaptions: false, channelCount: 5, scheduledAt: new Date() })).toEqual({
      enabled: false,
      pendingSchedule: false,
    });
  });

  it("an unscheduled fanout post gets captions but no pending flip", () => {
    expect(planCaptionFanout({ uniqueCaptions: true, channelCount: 3, scheduledAt: null })).toEqual({
      enabled: true,
      pendingSchedule: false,
    });
    expect(planCaptionFanout({ uniqueCaptions: true, channelCount: 3, scheduledAt: undefined })).toEqual({
      enabled: true,
      pendingSchedule: false,
    });
  });

  it("captionFanoutJobId is the per-post dedupe key", () => {
    expect(captionFanoutJobId("post-1")).toBe("caption-fanout-post-1");
  });

  it("captionFanoutJobId is a BullMQ-5.70-safe custom id (no colon, or exactly 3 segments)", () => {
    // BullMQ >=5.70 throws "Custom Id cannot contain :" for a jobId that
    // contains a colon but does NOT split into exactly 3 segments. A
    // colon-free id is always safe. This locks the regression that broke
    // unique-caption publish ("Custom Id cannot contain :").
    const id = captionFanoutJobId("some-post-cuid");
    if (id.includes(":")) {
      expect(id.split(":").length).toBe(3);
    } else {
      expect(id.includes(":")).toBe(false);
    }
  });
});

describe("assertTargetEditable (IDOR guard)", () => {
  const prismaWith = (target: unknown) =>
    ({ postTarget: { findUnique: vi.fn(async () => target) } }) as any;

  it("throws NOT_FOUND for a missing target", async () => {
    await expect(assertTargetEditable(prismaWith(null), "org-1", "t-missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws NOT_FOUND for a cross-org target (no existence leak)", async () => {
    await expect(
      assertTargetEditable(
        prismaWith({ id: "t1", status: "DRAFT", post: { organizationId: "org-OTHER" } }),
        "org-1",
        "t1"
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws BAD_REQUEST for a PUBLISHED target", async () => {
    await expect(
      assertTargetEditable(
        prismaWith({ id: "t1", status: "PUBLISHED", post: { organizationId: "org-1" } }),
        "org-1",
        "t1"
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns the target for a same-org editable target", async () => {
    await expect(
      assertTargetEditable(
        prismaWith({ id: "t1", status: "SCHEDULED", post: { organizationId: "org-1" } }),
        "org-1",
        "t1"
      )
    ).resolves.toEqual({ id: "t1", status: "SCHEDULED" });
  });
});

// ── Wiring locks ─────────────────────────────────────────────────────────────
const routersDir = join(__dirname, "..", "routers");
const read = (f: string) => readFileSync(join(routersDir, f), "utf8");

describe("wiring lock — post.create unique-captions path", () => {
  it("input schema has uniqueCaptions defaulting to false", () => {
    expect(read("post.router.ts")).toMatch(/uniqueCaptions: z\.boolean\(\)\.default\(false\)/);
  });

  it("uniqueCaptions=true parks the post as DRAFT; false keeps today's status expression", () => {
    expect(read("post.router.ts")).toMatch(
      /const status = captionFanout\.enabled \? "DRAFT" : input\.scheduledAt \? "SCHEDULED" : "DRAFT";/
    );
  });

  it("exactly one fanout enqueue, guarded by the plan flag, with the deduping jobId", () => {
    const src = read("post.router.ts");
    const guard = src.indexOf("if (captionFanout.enabled) {");
    const add = src.indexOf("captionFanoutQueue.add(");
    expect(guard).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(guard);
    expect(src).toMatch(/\{ jobId: captionFanoutJobId\(post\.id\) \}/);
    // ONE producer call site in this router.
    expect(src.match(/captionFanoutQueue\.add\(/g)).toHaveLength(1);
  });

  it("updateTargetContent runs the IDOR guard before writing", () => {
    const src = read("post.router.ts");
    const mutation = src.indexOf("updateTargetContent: orgProcedure");
    const guard = src.indexOf("assertTargetEditable(ctx.prisma as any, ctx.organizationId, input.targetId)");
    expect(mutation).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(mutation);
  });
});

describe("wiring lock — chat unique-captions paths", () => {
  it("publish_now: fanout branch replaces the direct per-target enqueue; guard order unchanged", () => {
    const src = read("chat.router.ts");
    const block = src.slice(src.indexOf('case "publish_now"'), src.indexOf('case "update_agent"'));
    // Pre-existing guards, in their pre-existing order, before the fanout plan.
    const planLimit = block.indexOf("enforcePlanLimit(");
    const channels = block.indexOf("assertChannelsOwned(");
    const media = block.indexOf("assertMediaOwned(");
    const fanoutPlan = block.indexOf("planCaptionFanout(");
    expect(planLimit).toBeGreaterThan(-1);
    expect(channels).toBeGreaterThan(planLimit);
    expect(media).toBeGreaterThan(channels);
    expect(fanoutPlan).toBeGreaterThan(media);
    // if (fanout) → captionFanoutQueue.add … else → postPublishQueue.add loop.
    const ifFanout = block.indexOf("if (captionFanout.enabled) {");
    const fanoutAdd = block.indexOf("captionFanoutQueue.add(");
    const elseBranch = block.indexOf("} else {");
    const directAdd = block.indexOf("postPublishQueue.add(");
    expect(ifFanout).toBeGreaterThan(-1);
    expect(fanoutAdd).toBeGreaterThan(ifFanout);
    expect(elseBranch).toBeGreaterThan(fanoutAdd);
    expect(directAdd).toBeGreaterThan(elseBranch);
    // The user-facing message says captions are being generated.
    expect(block).toMatch(/unique captions/);
  });

  it("schedule_post: accepts p.uniqueCaptions and enqueues the fanout job", () => {
    const src = read("chat.router.ts");
    const block = src.slice(src.indexOf('case "schedule_post"'), src.indexOf('case "bulk_schedule"'));
    expect(block).toMatch(/p\.uniqueCaptions === true/);
    expect(block).toMatch(/captionFanoutQueue\.add\(/);
    expect(block).toMatch(/status: captionFanout\.enabled \? "DRAFT" : "SCHEDULED"/);
  });
});
