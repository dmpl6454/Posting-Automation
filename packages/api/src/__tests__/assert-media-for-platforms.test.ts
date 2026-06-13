/**
 * Deferred Plan-1 media-required block, wired in Plan 3.
 *
 * `assertMediaForPlatforms` blocks a post that targets a media-required platform
 * (Instagram / Facebook) with NO media AND AI image generation OFF — a post that
 * can never publish (the worker only auto-generates when AI is on). It must be a
 * no-op by default (aiEnabled defaults true everywhere it's wired) and its channel
 * lookup must be org-scoped (IDOR-safe).
 */
import { describe, it, expect, vi } from "vitest";
import { assertMediaForPlatforms } from "../routers/chat.router";

function mockPrisma(platforms: string[]) {
  const findMany = vi.fn().mockResolvedValue(platforms.map((platform) => ({ platform })));
  return { prisma: { channel: { findMany } } as never, findMany };
}

describe("assertMediaForPlatforms (deferred media-required schedule block)", () => {
  it("blocks a media-less Instagram schedule when AI is OFF", async () => {
    const { prisma } = mockPrisma(["INSTAGRAM"]);
    await expect(
      assertMediaForPlatforms(prisma, "org-1", ["c1"], { hasMedia: false, aiEnabled: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does NOT block when AI is ON (worker auto-generates) — and skips the query", async () => {
    const { prisma, findMany } = mockPrisma(["INSTAGRAM"]);
    await expect(
      assertMediaForPlatforms(prisma, "org-1", ["c1"], { hasMedia: false, aiEnabled: true }),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does NOT block when media is attached — and skips the query", async () => {
    const { prisma, findMany } = mockPrisma(["INSTAGRAM"]);
    await expect(
      assertMediaForPlatforms(prisma, "org-1", ["c1"], { hasMedia: true, aiEnabled: false }),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does NOT block a non-media-required platform (Twitter) even with no media + AI off", async () => {
    const { prisma } = mockPrisma(["TWITTER"]);
    await expect(
      assertMediaForPlatforms(prisma, "org-1", ["c1"], { hasMedia: false, aiEnabled: false }),
    ).resolves.toBeUndefined();
  });

  it("IDOR: the channel lookup is org-scoped (where.organizationId set)", async () => {
    const { prisma, findMany } = mockPrisma(["INSTAGRAM"]);
    await assertMediaForPlatforms(prisma, "org-77", ["c1"], { hasMedia: false, aiEnabled: false }).catch(() => {});
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-77" }) }),
    );
  });

  it("no channels → no query, no block (channel-less drafts are exempt)", async () => {
    const { prisma, findMany } = mockPrisma(["INSTAGRAM"]);
    await expect(
      assertMediaForPlatforms(prisma, "org-1", [], { hasMedia: false, aiEnabled: false }),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });
});
