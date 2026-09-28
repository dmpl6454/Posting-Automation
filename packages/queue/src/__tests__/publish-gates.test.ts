import { describe, it, expect, vi } from "vitest";
import { pendingPublishGates, flipParkedPostIfReady } from "../publish-gates";

/**
 * "Held" (2026-09-28, owner decision): when unique captions fail for EVERY
 * channel, the post waits for a human instead of publishing the shared caption
 * everywhere. It must be a real gate — a super-text burn that finishes later
 * calls flipParkedPostIfReady, and without the gate that call would publish.
 */

function fakePrisma(post: Record<string, unknown> | null) {
  return {
    post: {
      findFirst: vi.fn(async () => post),
      update: vi.fn(async () => post),
    },
    postTarget: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
}

const parked = (captionFanout: Record<string, unknown>) => ({
  id: "p1",
  status: "DRAFT",
  scheduledAt: new Date("2026-09-28T14:55:00Z"),
  metadata: { captionFanout },
});

describe("pendingPublishGates", () => {
  it("a held fan-out is a gate", () => {
    expect(pendingPublishGates({ captionFanout: { requested: true, pendingSchedule: false, held: true } })).toEqual([
      "captionFanoutHeld",
    ]);
  });

  it("is unchanged for every pre-existing state", () => {
    expect(pendingPublishGates({ captionFanout: { requested: true, pendingSchedule: true } })).toEqual(["captionFanout"]);
    expect(pendingPublishGates({ captionFanout: { requested: true, pendingSchedule: false } })).toEqual([]);
    expect(pendingPublishGates({ superText: { pendingBurn: true } })).toEqual(["superText"]);
    expect(pendingPublishGates(null)).toEqual([]);
  });
});

describe("flipParkedPostIfReady", () => {
  it("NEVER flips a held post — even when the super-text burn has just finished", async () => {
    const prisma = fakePrisma(parked({ requested: true, pendingSchedule: false, held: true }));
    await expect(flipParkedPostIfReady(prisma, "p1", "org-1")).resolves.toBe(false);
    expect(prisma.postTarget.updateMany).not.toHaveBeenCalled();
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("flips once the hold is released (held false, nothing pending)", async () => {
    const prisma = fakePrisma(parked({ requested: true, pendingSchedule: false, held: false }));
    await expect(flipParkedPostIfReady(prisma, "p1", "org-1")).resolves.toBe(true);
    // Targets BEFORE the post: a SCHEDULED post with DRAFT targets enqueues nothing.
    const targetOrder = prisma.postTarget.updateMany.mock.invocationCallOrder[0]!;
    const postOrder = prisma.post.update.mock.invocationCallOrder[0]!;
    expect(targetOrder).toBeLessThan(postOrder);
  });
});
