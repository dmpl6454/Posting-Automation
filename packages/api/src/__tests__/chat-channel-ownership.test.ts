/**
 * Regression guard for the Super Agent cross-org IDOR fix (audit 2026-06-06).
 *
 * Bug: create_agent / schedule_post / bulk_schedule / publish_now passed
 * AI-supplied channelIds straight into Prisma with no org-ownership check, so a
 * user could target another org's channels. `assertChannelsOwned` now mirrors
 * the validation block in post.router.ts:create. These tests exercise the REAL
 * exported helper against a mocked prisma.
 */
import { describe, it, expect, vi } from "vitest";
import { assertChannelsOwned } from "../routers/chat.router";

function mockPrisma(ownedIds: string[]) {
  return {
    channel: {
      findMany: vi.fn().mockResolvedValue(ownedIds.map((id) => ({ id }))),
    },
  } as never;
}

describe("assertChannelsOwned (Super Agent IDOR guard)", () => {
  it("passes when every requested channel is owned by the org", async () => {
    await expect(
      assertChannelsOwned(mockPrisma(["a", "b"]), "org-1", ["a", "b"])
    ).resolves.toBeUndefined();
  });

  it("throws FORBIDDEN when a requested channel is foreign (findMany returns fewer)", async () => {
    await expect(
      assertChannelsOwned(mockPrisma(["a"]), "org-1", ["a", "foreign"])
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("throws BAD_REQUEST when no channels are supplied", async () => {
    await expect(
      assertChannelsOwned(mockPrisma([]), "org-1", [])
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("dedupes duplicate ids before counting (two 'a' still needs one owned 'a')", async () => {
    await expect(
      assertChannelsOwned(mockPrisma(["a"]), "org-1", ["a", "a"])
    ).resolves.toBeUndefined();
  });

  it("ignores empty/falsy ids and rejects if nothing real remains", async () => {
    await expect(
      assertChannelsOwned(mockPrisma([]), "org-1", ["", ""])
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
