import { describe, it, expect, vi } from "vitest";
import { runPlatformDelete, PlatformDeleteRetryError } from "./platform-delete";

/**
 * Delete-from-platform job (2026-11-05). The state machine is driven through a
 * fake prisma whose raw-SQL calls record what was written.
 */

type Opts = {
  claim?: number;
  target?: any;
  channel?: any;
  outcome?: any;
  throws?: boolean;
};

function harness(o: Opts = {}) {
  const writes: { patch: any; sql: string; params: unknown[] }[] = [];
  let first = true;
  const prisma: any = {
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      writes.push({ sql, params, patch: JSON.parse(String(params[1])) });
      if (first) {
        first = false;
        return o.claim ?? 1;
      }
      return 1;
    }),
    $queryRawUnsafe: vi.fn(),
    postTarget: {
      findUnique: vi.fn(async () =>
        o.target === undefined
          ? { id: "t1", status: "PUBLISHED", publishedId: "179", platformDeletedAt: null, metadata: null, channelId: "c1" }
          : o.target
      ),
    },
    channel: {
      findUnique: vi.fn(async () =>
        o.channel === undefined
          ? { id: "c1", platform: "INSTAGRAM", accessToken: "tok", refreshToken: null, isActive: true, disconnectedAt: null, metadata: null }
          : o.channel
      ),
    },
  };
  const deleteOnPlatform = vi.fn(async () => {
    if (o.throws) throw new Error("boom");
    return o.outcome ?? { kind: "deleted" };
  });
  const now = () => new Date("2026-11-05T10:00:00.000Z");
  return { prisma, deleteOnPlatform, writes, deps: { prisma, deleteOnPlatform, now } };
}

const last = (writes: any[]) => writes[writes.length - 1];

describe("runPlatformDelete", () => {
  it("claims queued → deleting, deletes, and stamps platformDeletedAt", async () => {
    const h = harness();
    expect(await runPlatformDelete(h.deps, "t1", { finalAttempt: false })).toBe("deleted");
    expect(h.writes[0]!.patch).toEqual({ status: "deleting" });
    expect(h.writes[0]!.sql).toContain("= ANY(");
    expect(h.writes[0]!.params[2]).toEqual(["queued", "deleting"]);
    expect(last(h.writes).patch.status).toBe("deleted");
    expect(last(h.writes).sql).toContain('"platformDeletedAt"');
    expect(last(h.writes).params).toContain("2026-11-05T10:00:00.000Z");
    expect(h.deleteOnPlatform).toHaveBeenCalledWith("INSTAGRAM", { accessToken: "tok", refreshToken: undefined }, "179");
  });

  it("a job whose claim fails (already finished, or never queued) does nothing", async () => {
    const h = harness({ claim: 0 });
    expect(await runPlatformDelete(h.deps, "t1", { finalAttempt: false })).toBe("skipped");
    expect(h.deleteOnPlatform).not.toHaveBeenCalled();
  });

  it("an unknown outcome is retried, and only the final attempt records a failure", async () => {
    const h = harness({ outcome: { kind: "retry", message: "not confirmed" } });
    await expect(runPlatformDelete(h.deps, "t1", { finalAttempt: false })).rejects.toBeInstanceOf(PlatformDeleteRetryError);
    expect(h.writes.some((w) => w.patch.status === "failed")).toBe(false);

    const h2 = harness({ outcome: { kind: "retry", message: "not confirmed" } });
    expect(await runPlatformDelete(h2.deps, "t1", { finalAttempt: true })).toBe("failed");
    expect(last(h2.writes).patch).toMatchObject({ status: "failed", message: "not confirmed" });
  });

  it("a provider that throws is treated as unknown, not as deleted", async () => {
    const h = harness({ throws: true });
    await expect(runPlatformDelete(h.deps, "t1", { finalAttempt: false })).rejects.toBeInstanceOf(PlatformDeleteRetryError);
  });

  it("not_found keeps the post un-deleted (no platformDeletedAt)", async () => {
    const h = harness({ outcome: { kind: "not_found", message: "gone?" } });
    expect(await runPlatformDelete(h.deps, "t1", { finalAttempt: false })).toBe("not_found");
    expect(last(h.writes).sql).not.toContain('"platformDeletedAt"');
  });

  it("a missing GRANTED scope fails without calling the platform", async () => {
    const h = harness({
      channel: { id: "c1", platform: "INSTAGRAM", accessToken: "t", isActive: true, disconnectedAt: null, metadata: { grantedScopes: ["instagram_basic"] } },
    });
    expect(await runPlatformDelete(h.deps, "t1", { finalAttempt: false })).toBe("failed");
    expect(h.deleteOnPlatform).not.toHaveBeenCalled();
    expect(last(h.writes).patch.message).toMatch(/permission/i);
  });

  it("a disconnected channel, an unpublished target, an unresolved IG story → failed without a call", async () => {
    const a = harness({ channel: { id: "c1", platform: "FACEBOOK", accessToken: "t", isActive: false, disconnectedAt: new Date(), metadata: null } });
    expect(await runPlatformDelete(a.deps, "t1", { finalAttempt: false })).toBe("failed");
    const b = harness({ target: { id: "t1", status: "FAILED", publishedId: null, platformDeletedAt: null, metadata: null, channelId: "c1" } });
    expect(await runPlatformDelete(b.deps, "t1", { finalAttempt: false })).toBe("failed");
    const c = harness({
      target: { id: "t1", status: "PUBLISHED", publishedId: "9", platformDeletedAt: null, metadata: { storyMediaUnresolved: true }, channelId: "c1" },
    });
    expect(await runPlatformDelete(c.deps, "t1", { finalAttempt: false })).toBe("failed");
    for (const h of [a, b, c]) expect(h.deleteOnPlatform).not.toHaveBeenCalled();
  });

  it("a non-Meta channel is never sent to a provider", async () => {
    const h = harness({ channel: { id: "c1", platform: "TIKTOK", accessToken: "t", isActive: true, disconnectedAt: null, metadata: null } });
    expect(await runPlatformDelete(h.deps, "t1", { finalAttempt: false })).toBe("failed");
    expect(h.deleteOnPlatform).not.toHaveBeenCalled();
  });
});
