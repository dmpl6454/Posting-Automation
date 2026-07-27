/**
 * Super-text burn — pure helpers + the shared publish-gate flip.
 *
 * These lock the two rules that keep the feature from ever damaging a post:
 *   1. the ffmpeg composite is an argv array (no shell) that copies audio and
 *      composites the pre-rendered strip at 0:0 — no user text ever reaches ffmpeg
 *   2. a truncated encode FAILS instead of publishing a silently-cut video
 * plus the gate coordination that stops a post being flipped to SCHEDULED (and
 * therefore published) while its strip is still being burned.
 */
import { describe, it, expect, vi } from "vitest";
import { buildSuperTextCompositeArgs, durationIntegrityOk } from "../super-text-burn";
import {
  pendingPublishGates,
  wasParkedForSchedule,
  flipParkedPostIfReady,
} from "../publish-gates";

describe("buildSuperTextCompositeArgs", () => {
  const args = buildSuperTextCompositeArgs({
    inputPath: "/tmp/in.mp4",
    overlayPngPath: "/tmp/strip.png",
    outputPath: "/tmp/out.mp4",
  });

  it("composites the strip at 0:0 over the source video", () => {
    expect(args.join(" ")).toContain("[0:v][1:v]overlay=0:0");
    expect(args).toContain("/tmp/in.mp4");
    expect(args).toContain("/tmp/strip.png");
  });

  it("copies audio rather than re-encoding it", () => {
    const i = args.indexOf("-c:a");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("copy");
  });

  it("produces a web-playable H.264 + faststart mp4 and writes output last", () => {
    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
    expect(args[0]).toBe("-y");
  });

  it("is a discrete argv array with no shell quoting (execFile contract)", () => {
    for (const a of args) {
      expect(typeof a).toBe("string");
      expect(a).not.toMatch(/^['"].*['"]$/);
    }
  });

  it("leaves a core free on the 4-core prod box", () => {
    const i = args.indexOf("-threads");
    expect(args[i + 1]).toBe("3");
  });
});

describe("durationIntegrityOk — never publish a truncated burn", () => {
  it("accepts an output within 2% of the source", () => {
    expect(durationIntegrityOk(60, 60)).toBe(true);
    expect(durationIntegrityOk(60, 59.2)).toBe(true);
    expect(durationIntegrityOk(18.388, 18.3)).toBe(true); // the real reference clip
  });

  it("rejects a truncated encode (the PR #144 failure mode)", () => {
    expect(durationIntegrityOk(63, 40)).toBe(false);
    expect(durationIntegrityOk(60, 58)).toBe(false);
  });

  it("fails OPEN when the source duration is unknown, CLOSED when the output is", () => {
    expect(durationIntegrityOk(undefined, 40)).toBe(true);
    expect(durationIntegrityOk(60, undefined)).toBe(false);
  });
});

describe("publish gates", () => {
  it("reports each pending gate", () => {
    expect(pendingPublishGates({ captionFanout: { pendingSchedule: true } })).toEqual(["captionFanout"]);
    expect(pendingPublishGates({ superText: { pendingBurn: true } })).toEqual(["superText"]);
    expect(
      pendingPublishGates({ captionFanout: { pendingSchedule: true }, superText: { pendingBurn: true } })
    ).toHaveLength(2);
  });

  it("reports no gates for cleared or absent metadata", () => {
    expect(pendingPublishGates({ superText: { pendingBurn: false } })).toEqual([]);
    expect(pendingPublishGates(null)).toEqual([]);
    expect(pendingPublishGates(undefined)).toEqual([]);
    expect(pendingPublishGates({})).toEqual([]);
  });

  it("knows whether a gate parked the schedule", () => {
    expect(wasParkedForSchedule({ superText: { parkedSchedule: true } })).toBe(true);
    expect(wasParkedForSchedule({ captionFanout: { requested: true } })).toBe(true);
    expect(wasParkedForSchedule({ superText: { parkedSchedule: false } })).toBe(false);
    expect(wasParkedForSchedule({})).toBe(false);
  });
});

describe("flipParkedPostIfReady", () => {
  function mkPrisma(post: any) {
    return {
      post: { findFirst: vi.fn(async () => post), update: vi.fn(async () => ({})) },
      postTarget: { updateMany: vi.fn(async () => ({ count: 2 })) },
    };
  }

  it("flips targets THEN the post when every gate is clear", async () => {
    const prisma = mkPrisma({
      id: "p1",
      status: "DRAFT",
      scheduledAt: new Date(),
      metadata: { superText: { parkedSchedule: true, pendingBurn: false } },
    });
    expect(await flipParkedPostIfReady(prisma as any, "p1", "org1")).toBe(true);
    expect(prisma.postTarget.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "SCHEDULED" } })
    );
    expect(prisma.post.update).toHaveBeenCalled();
  });

  it("does NOT flip while the burn is pending (would publish the un-burned video)", async () => {
    const prisma = mkPrisma({
      id: "p1",
      status: "DRAFT",
      scheduledAt: new Date(),
      metadata: { superText: { parkedSchedule: true, pendingBurn: true } },
    });
    expect(await flipParkedPostIfReady(prisma as any, "p1", "org1")).toBe(false);
    expect(prisma.postTarget.updateMany).not.toHaveBeenCalled();
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("does NOT flip while captions are still pending", async () => {
    const prisma = mkPrisma({
      id: "p1",
      status: "DRAFT",
      scheduledAt: new Date(),
      metadata: {
        superText: { parkedSchedule: true, pendingBurn: false },
        captionFanout: { requested: true, pendingSchedule: true },
      },
    });
    expect(await flipParkedPostIfReady(prisma as any, "p1", "org1")).toBe(false);
  });

  it("never flips a post the user meant to keep as a plain draft", async () => {
    const prisma = mkPrisma({ id: "p1", status: "DRAFT", scheduledAt: null, metadata: {} });
    expect(await flipParkedPostIfReady(prisma as any, "p1", "org1")).toBe(false);
  });

  it("is a no-op for an unknown / cross-org post id", async () => {
    const prisma = mkPrisma(null);
    expect(await flipParkedPostIfReady(prisma as any, "p1", "org1")).toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("is idempotent — a second call after the flip does nothing", async () => {
    const prisma = mkPrisma({
      id: "p1",
      status: "SCHEDULED", // already flipped
      scheduledAt: new Date(),
      metadata: { superText: { parkedSchedule: true, pendingBurn: false } },
    });
    expect(await flipParkedPostIfReady(prisma as any, "p1", "org1")).toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});
