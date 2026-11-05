import { describe, it, expect, vi } from "vitest";

vi.mock("@postautomation/queue", async (orig) => {
  const real: any = await orig();
  return { ...real, platformDeleteQueue: { add: vi.fn() } };
});

import { planPlatformDeleteRequest, requestPlatformDeletion, PLATFORM_DELETE_MAX_TARGETS } from "../lib/platform-delete-request";

/**
 * "Delete from Facebook / Instagram" requests (2026-11-05): org-scoped through
 * the parent post, only published FB/IG targets, never twice in flight.
 */

const NOW = new Date("2026-11-05T10:00:00.000Z");
const row = (o: any = {}) => ({
  id: "t1",
  status: "PUBLISHED",
  publishedId: "179",
  platformDeletedAt: null,
  metadata: null,
  channel: { platform: "INSTAGRAM" },
  ...o,
});

describe("planPlatformDeleteRequest", () => {
  it("sorts targets into eligible and the reasons they are not", () => {
    const { eligible, summary } = planPlatformDeleteRequest(
      [
        row({ id: "ok-ig" }),
        row({ id: "ok-fb", channel: { platform: "FACEBOOK" } }),
        row({ id: "x", channel: { platform: "TWITTER" } }),
        row({ id: "draft", status: "DRAFT", publishedId: null }),
        row({ id: "gone", platformDeletedAt: new Date() }),
        row({ id: "busy", metadata: { platformDelete: { status: "deleting", requestedAt: "2026-11-05T09:50:00.000Z" } } }),
        // A request lost 2 hours ago may be asked again.
        row({ id: "stale", metadata: { platformDelete: { status: "queued", requestedAt: "2026-11-05T08:00:00.000Z" } } }),
        // A finished failure may be retried.
        row({ id: "retry", metadata: { platformDelete: { status: "failed", requestedAt: "2026-11-05T09:59:00.000Z" } } }),
      ],
      NOW
    );
    expect(eligible).toEqual(["ok-ig", "ok-fb", "stale", "retry"]);
    expect(summary).toMatchObject({ unsupported: 1, notPublished: 1, alreadyDeleted: 1, inProgress: 1, overLimit: 0 });
  });

  it("caps one request and counts the rest", () => {
    const many = Array.from({ length: PLATFORM_DELETE_MAX_TARGETS + 5 }, (_, i) => row({ id: `t${i}` }));
    const { eligible, summary } = planPlatformDeleteRequest(many, NOW);
    expect(eligible).toHaveLength(PLATFORM_DELETE_MAX_TARGETS);
    expect(summary.overLimit).toBe(5);
  });
});

describe("requestPlatformDeletion", () => {
  function harness(targets: any[], claimedIds?: string[]) {
    const findMany = vi.fn(async (_a: any) => targets);
    const queryRaw = vi.fn(async (_sql: string, ids: string[]) => (claimedIds ?? ids).map((id) => ({ id })));
    const prisma: any = {
      postTarget: { findMany },
      $queryRawUnsafe: queryRaw,
      $executeRawUnsafe: vi.fn(async () => 1),
      auditLog: { create: vi.fn() },
    };
    const add = vi.fn(async () => ({}));
    return { prisma, findMany, queryRaw, add };
  }

  it("scopes by the parent post's organization and queues one spaced job per claimed target", async () => {
    const h = harness([row({ id: "a" }), row({ id: "b", channel: { platform: "FACEBOOK" } })]);
    const res = await requestPlatformDeletion(
      h.prisma,
      { organizationId: "org-1", userId: "u1", postIds: ["p1"] },
      { now: () => NOW, queue: { add: h.add } }
    );
    expect(h.findMany.mock.calls[0]![0].where.post).toEqual({ id: { in: ["p1"] }, organizationId: "org-1" });
    expect(res.queued).toBe(2);
    expect(h.add.mock.calls.map((c: any) => c[2].jobId)).toEqual([
      `pdelete:a:${NOW.getTime()}`,
      `pdelete:b:${NOW.getTime()}`,
    ]);
    for (const c of h.add.mock.calls as any[]) expect(String(c[2].jobId).split(":")).toHaveLength(3);
    expect((h.add.mock.calls as any[]).map((c) => c[2].delay)).toEqual([0, 1500]);
    // The claim marks them queued, PUBLISHED-only, not already deleted.
    const sql = h.queryRaw.mock.calls[0]![0] as string;
    expect(sql).toContain(`status::text = 'PUBLISHED'`);
    expect(sql).toContain(`"platformDeletedAt" IS NULL`);
  });

  it("limits to the given channels of a post", async () => {
    const h = harness([row({ id: "a" })]);
    await requestPlatformDeletion(h.prisma, { organizationId: "o", userId: null, postIds: ["p"], targetIds: ["a"] }, { now: () => NOW, queue: { add: h.add } });
    expect(h.findMany.mock.calls[0]![0].where.id).toEqual({ in: ["a"] });
  });

  it("a target another request claimed first is counted in progress, not queued twice", async () => {
    const h = harness([row({ id: "a" }), row({ id: "b" })], ["a"]);
    const res = await requestPlatformDeletion(h.prisma, { organizationId: "o", userId: null, postIds: ["p"] }, { now: () => NOW, queue: { add: h.add } });
    expect(res).toMatchObject({ queued: 1, inProgress: 1 });
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it("a queueing failure releases the target as failed instead of leaving it stuck 'queued'", async () => {
    const h = harness([row({ id: "a" })]);
    const add = vi.fn(async () => {
      throw new Error("redis down");
    });
    const res = await requestPlatformDeletion(h.prisma, { organizationId: "o", userId: null, postIds: ["p"] }, { now: () => NOW, queue: { add } });
    expect(res.queued).toBe(0);
    const [sql, id, patch, statuses] = h.prisma.$executeRawUnsafe.mock.calls[0];
    expect(id).toBe("a");
    expect(JSON.parse(patch).status).toBe("failed");
    expect(statuses).toEqual(["queued"]);
    expect(sql).toContain("platformDelete");
  });

  it("nothing eligible → no claim, no job", async () => {
    const h = harness([row({ id: "d", status: "DRAFT", publishedId: null })]);
    const res = await requestPlatformDeletion(h.prisma, { organizationId: "o", userId: null, postIds: ["p"] }, { now: () => NOW, queue: { add: h.add } });
    expect(res).toMatchObject({ queued: 0, notPublished: 1 });
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });
});
