/**
 * listening.mentions sort / minimum reach / period (2026-10-06) — the query it
 * sends, through the real router with a mocked prisma. The real-Postgres
 * behaviour (ties, cursor pages) is in listening-mentions-sort.e2e.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The router imports @postautomation/queue (BullMQ → Redis) at load time.
vi.mock("@postautomation/queue", () => ({ listeningSyncQueue: { add: vi.fn() } }));

import { createCallerFactory } from "../trpc";
import { listeningRouter, mentionsOrderBy } from "../routers/listening.router";

const ORG = "org-1";

function build(rows: any[] = []) {
  const findMany = vi.fn(async (_a: any) => rows);
  const prisma = {
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u", organizationId: ORG, role: "OWNER" })) },
    mention: { findMany },
  } as any;
  const caller = createCallerFactory(listeningRouter)({
    prisma,
    session: { user: { id: "u", email: "u@x", isSuperAdmin: true } } as any,
    organizationId: ORG,
  });
  return { caller, findMany };
}

beforeEach(() => vi.clearAllMocks());

describe("listening.mentions", () => {
  it("defaults to newest first with a total order, org-scoped, no reach or period filter", async () => {
    const { caller, findMany } = build();
    await caller.mentions({});
    const args = findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ listeningQuery: { organizationId: ORG } });
    expect(args.orderBy).toEqual([{ mentionedAt: "desc" }, { id: "desc" }]);
    expect(args.cursor).toBeUndefined();
  });

  it("reach sort, minimum reach and period go into the query; the cursor resumes after the last row", async () => {
    const { caller, findMany } = build();
    const before = Date.now();
    await caller.mentions({ queryId: "q1", sort: "reach", minReach: 10000, days: 7, limit: 20, cursor: "m-last" });
    const args = findMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({
      listeningQueryId: "q1",
      listeningQuery: { organizationId: ORG },
      reach: { gte: 10000 },
    });
    const since = args.where.mentionedAt.gte.getTime();
    expect(since).toBeGreaterThanOrEqual(before - 7 * 86400000 - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - 7 * 86400000 + 1000);
    expect(args.orderBy).toEqual(mentionsOrderBy("reach"));
    expect(args.orderBy).toEqual([{ reach: "desc" }, { mentionedAt: "desc" }, { id: "desc" }]);
    expect(args.cursor).toEqual({ id: "m-last" });
    expect(args.skip).toBe(1);
    expect(args.take).toBe(21);
  });

  it("an overall-sentiment filter combines with the others (2026-10-06)", async () => {
    const { caller, findMany } = build();
    await caller.mentions({ sentiment: "NEGATIVE", sort: "reach", minReach: 1000 });
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      listeningQuery: { organizationId: ORG },
      sentiment: "NEGATIVE",
      reach: { gte: 1000 },
    });
    await expect(caller.mentions({ sentiment: "ANGRY" as any })).rejects.toThrow();
  });

  it("a source filter is validated against MentionSource and combines with the others (2026-10-06)", async () => {
    const { caller, findMany } = build();
    await caller.mentions({ source: "YOUTUBE", sentiment: "NEGATIVE", minReach: 1000 });
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      listeningQuery: { organizationId: ORG },
      source: "YOUTUBE",
      sentiment: "NEGATIVE",
      reach: { gte: 1000 },
    });
    // Used to reach Prisma as-is (a 500); now a 400 before any query.
    await expect(caller.mentions({ source: "MYSPACE" as any })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("returns a next cursor only when there is another page", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}` }));
    const { caller } = build(rows);
    expect(await caller.mentions({ limit: 2 })).toEqual({ items: [{ id: "m0" }, { id: "m1" }], nextCursor: "m1" });
    const { caller: c2 } = build(rows.slice(0, 2));
    expect((await c2.mentions({ limit: 2 })).nextCursor).toBeUndefined();
  });

  it("rejects a negative minimum and an out-of-range period", async () => {
    const { caller } = build();
    await expect(caller.mentions({ minReach: -1 })).rejects.toThrow();
    await expect(caller.mentions({ days: 0 })).rejects.toThrow();
  });
});
