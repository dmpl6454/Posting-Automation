/**
 * Regression guard for F3: cross-org media IDOR in post.create.
 *
 * Before this fix, post.create attached mediaIds straight to the post with no
 * org-ownership check, so a user could attach another org's Media row to their
 * post. The fix calls assertMediaOwned (already used by chat.router) before the
 * Prisma create.
 *
 * These tests exercise assertMediaOwned directly (it's the exact same helper
 * now called from post.create) to confirm the guard behaviour.
 */
import { describe, it, expect, vi } from "vitest";
import { assertMediaOwned } from "../routers/chat.router";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockPrisma(ownedIds: string[]): any {
  return {
    media: {
      findMany: vi.fn().mockResolvedValue(ownedIds.map((id) => ({ id }))),
    },
  };
}

describe("assertMediaOwned (F3 — post.create media IDOR guard)", () => {
  it("passes when all mediaIds belong to the org", async () => {
    await expect(
      assertMediaOwned(mockPrisma(["m1", "m2"]), "org-1", ["m1", "m2"]),
    ).resolves.toBeUndefined();
  });

  it("throws FORBIDDEN when a mediaId belongs to a different org", async () => {
    // findMany returns only m1 — m2 is foreign
    await expect(
      assertMediaOwned(mockPrisma(["m1"]), "org-1", ["m1", "m2"]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is a no-op for empty mediaIds (no check needed)", async () => {
    const prisma = mockPrisma([]);
    await expect(assertMediaOwned(prisma, "org-1", [])).resolves.toBeUndefined();
    expect(prisma.media.findMany).not.toHaveBeenCalled();
  });

  it("deduplicates before counting (two identical ids count as one)", async () => {
    await expect(
      assertMediaOwned(mockPrisma(["m1"]), "org-1", ["m1", "m1"]),
    ).resolves.toBeUndefined();
  });
});
