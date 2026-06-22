/**
 * resolveChannelErrorsOnReconnect (2026-06-22) — when a user reconnects a channel
 * (fresh OAuth token / new app password), its OPEN token/auth ErrorLog rows are
 * the most common monitoring noise and are now self-healed: a fresh token means
 * the old "Access token expired. Please reconnect…" error is no longer actionable.
 *
 * Match: open `publish` errors for THIS channelId whose errorType is auth-related.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveChannelErrorsOnReconnect } from "../resolve-channel-errors";

function mockPrisma(count: number) {
  const updateMany = vi.fn(async (_args: { where: any; data: any }) => ({ count }));
  return { prisma: { errorLog: { updateMany } } as any, updateMany };
}

describe("resolveChannelErrorsOnReconnect", () => {
  it("auto-resolves open publish token/auth errors for the reconnected channel", async () => {
    const { prisma, updateMany } = mockPrisma(3);

    const result = await resolveChannelErrorsOnReconnect(prisma, "chan-123");

    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0]!;

    // only OPEN rows
    expect(arg.where.resolved).toBe(false);
    // scoped to the publish source
    expect(arg.where.source).toBe("publish");
    // scoped to THIS channel via the JSON metadata path
    expect(arg.where.metadata).toEqual({ path: ["channelId"], equals: "chan-123" });
    // only auth-class error types
    expect(arg.where.OR).toEqual([
      { metadata: { path: ["errorType"], equals: "token_expired" } },
      { metadata: { path: ["errorType"], equals: "auth_expired" } },
      { metadata: { path: ["errorType"], equals: "permission" } },
    ]);
    // flips to resolved with an audit note
    expect(arg.data.resolved).toBe(true);
    expect(arg.data.resolvedAt).toBeInstanceOf(Date);
    expect(typeof arg.data.resolvedNote).toBe("string");

    expect(result).toBe(3);
  });

  it("never throws even if the DB write fails (best-effort)", async () => {
    const prisma = { errorLog: { updateMany: vi.fn(async () => { throw new Error("db down"); }) } } as any;
    await expect(resolveChannelErrorsOnReconnect(prisma, "chan-x")).resolves.toBe(0);
  });
});
