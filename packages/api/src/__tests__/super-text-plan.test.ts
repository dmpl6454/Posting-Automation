/**
 * Super-text create-time planner.
 *
 * The single most important case here is the LAST one: with no super-text config
 * the plan is inert, which is what keeps ordinary posting (the overwhelming
 * majority of posts) on exactly the pre-feature code path.
 */
import { describe, it, expect } from "vitest";
import { planSuperText, superTextJobId, SUPER_TEXT_MAX_SOURCE_BYTES } from "../lib/super-text";
import type { SuperTextConfig } from "@postautomation/super-text";

const cfg: SuperTextConfig = {
  version: 1,
  segments: [{ text: "hello" }, { text: "world", color: "#EF4444" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

const video = (id: string, size = 1_000_000) => ({ id, fileType: "video/mp4", fileSize: size });
const image = (id: string) => ({ id, fileType: "image/png", fileSize: 1000 });

describe("planSuperText", () => {
  it("is inert when no config is supplied — normal posting is untouched", () => {
    expect(
      planSuperText({ superText: undefined, mediaRows: [video("a")], scheduledAt: new Date() })
    ).toEqual({ enabled: false, parkedSchedule: false, byMediaId: {}, oversized: [] });

    expect(
      planSuperText({ superText: null, mediaRows: [video("a")], scheduledAt: null })
    ).toEqual({ enabled: false, parkedSchedule: false, byMediaId: {}, oversized: [] });
  });

  it("applies only to VIDEO media actually attached to this post", () => {
    const plan = planSuperText({
      superText: { a: cfg, b: cfg, ghost: cfg },
      // `b` is an image; `ghost` is not attached at all.
      mediaRows: [video("a"), image("b")],
      scheduledAt: null,
    });
    expect(Object.keys(plan.byMediaId)).toEqual(["a"]);
    expect(plan.enabled).toBe(true);
  });

  it("parks the schedule only when the post would have been SCHEDULED", () => {
    expect(
      planSuperText({ superText: { a: cfg }, mediaRows: [video("a")], scheduledAt: new Date() })
        .parkedSchedule
    ).toBe(true);
    // A plain draft still burns, but there is no schedule to park.
    const draft = planSuperText({
      superText: { a: cfg },
      mediaRows: [video("a")],
      scheduledAt: null,
    });
    expect(draft.enabled).toBe(true);
    expect(draft.parkedSchedule).toBe(false);
  });

  it("flags an oversized source instead of silently enabling a huge re-encode", () => {
    const plan = planSuperText({
      superText: { a: cfg },
      mediaRows: [video("a", SUPER_TEXT_MAX_SOURCE_BYTES + 1)],
      scheduledAt: null,
    });
    expect(plan.enabled).toBe(false);
    expect(plan.oversized).toEqual(["a"]);
  });

  it("accepts a source exactly at the cap", () => {
    const plan = planSuperText({
      superText: { a: cfg },
      mediaRows: [video("a", SUPER_TEXT_MAX_SOURCE_BYTES)],
      scheduledAt: null,
    });
    expect(plan.enabled).toBe(true);
    expect(plan.oversized).toEqual([]);
  });

  it("supports several videos in one post", () => {
    const plan = planSuperText({
      superText: { a: cfg, b: cfg },
      mediaRows: [video("a"), video("b"), image("c")],
      scheduledAt: new Date(),
    });
    expect(Object.keys(plan.byMediaId).sort()).toEqual(["a", "b"]);
  });
});

describe("superTextJobId", () => {
  it("is exactly 3 colon segments (BullMQ >=5.70 rejects other colon counts)", () => {
    const id = superTextJobId("post-123");
    expect(id).toBe("supertext:post-123:v1");
    expect(id.split(":")).toHaveLength(3);
  });

  it("is deterministic so a re-submit dedupes instead of double-burning", () => {
    expect(superTextJobId("p")).toBe(superTextJobId("p"));
  });
});
