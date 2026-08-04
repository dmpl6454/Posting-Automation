/**
 * Guard for channelGroup.setChannels — the batch add/remove behind the group
 * card's "Select all" / "Remove all" buttons (2026-08-04).
 *
 * Why the batch procedure exists: the group card toggles ONE channel per
 * mutation. This platform routinely has hundreds of channels on a single org
 * (387 Facebook Pages on the account that prompted this feature), so a
 * select-all built by looping `addChannel` would fire hundreds of tRPC
 * round-trips, trip the rate limiter, and half-populate the group. These tests
 * lock the three properties that make the batch safe:
 *   1. ONE write, not N (the whole point).
 *   2. The org-scoped IDOR guard covers the entire batch — a foreign channelId
 *      can never be connected to a group.
 *   3. A foreign/stale id is DROPPED, not fatal — one disconnected channel must
 *      not block a 300-channel select-all.
 *
 * Exercises the REAL channelGroupRouter through a tRPC caller with mocked prisma.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createCallerFactory } from "../trpc";
import { channelGroupRouter } from "../routers/channel-group.router";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const OTHER_ORG_ID = "org-2";

function session() {
  return { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: false } } as any;
}

/**
 * `ownedIds` models the org's real channels. The mocked findMany applies the
 * SAME org filter the procedure passes, so a test id that isn't owned comes
 * back empty exactly as it would from Postgres.
 */
function buildCaller(opts: { groupFound: boolean; ownedIds: string[]; existingMembers?: string[] }) {
  const groupFindFirst = vi.fn(async (_args: any) =>
    opts.groupFound ? { id: "group-1", organizationId: ORG_ID, name: "Demo" } : null
  );
  // Membership snapshot the procedure reads to compute `changed`.
  const groupFindUnique = vi.fn(async (_args: any) => ({
    channels: (opts.existingMembers ?? []).map((id) => ({ id })),
  }));
  const channelFindMany = vi.fn(async (args: any) => {
    if (args.where.organizationId !== ORG_ID) return [];
    const requested: string[] = args.where.id.in;
    return requested.filter((id) => opts.ownedIds.includes(id)).map((id) => ({ id }));
  });
  const groupUpdate = vi.fn(async (_args: any) => ({ id: "group-1", name: "Demo", channels: [] }));

  const prisma = {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: USER_ID, organizationId: ORG_ID, role: "OWNER" })),
    },
    // orgProcedure's planExpiresAt guard reads the org for non-superadmin actors.
    // We deliberately test as an ORDINARY member (isSuperAdmin: false) — the
    // stricter actor — so the org-scoping assertions below mean something.
    organization: {
      findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })),
      update: vi.fn(),
    },
    channelGroup: { findFirst: groupFindFirst, findUnique: groupFindUnique, update: groupUpdate },
    channel: { findMany: channelFindMany },
  } as any;

  const caller = createCallerFactory(channelGroupRouter)({
    prisma,
    session: session(),
    organizationId: ORG_ID,
  });
  return { caller, groupFindFirst, groupFindUnique, channelFindMany, groupUpdate };
}

describe("channelGroup.setChannels — batching", () => {
  beforeEach(() => vi.clearAllMocks());

  it("connects the whole batch in ONE update (not one per channel)", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `ch-${i}`);
    const { caller, groupUpdate } = buildCaller({ groupFound: true, ownedIds: ids });

    const res = await caller.setChannels({ groupId: "group-1", channelIds: ids, mode: "add" });

    // The whole point: a single write regardless of batch size.
    expect(groupUpdate).toHaveBeenCalledTimes(1);
    const arg = groupUpdate.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: "group-1" });
    expect(arg.data.channels.connect).toHaveLength(300);
    expect(arg.data.channels.disconnect).toBeUndefined();
    expect(res.changed).toBe(300);
  });

  it("disconnects in remove mode", async () => {
    const { caller, groupUpdate } = buildCaller({ groupFound: true, ownedIds: ["a", "b"] });
    await caller.setChannels({ groupId: "group-1", channelIds: ["a", "b"], mode: "remove" });

    const arg = groupUpdate.mock.calls[0]![0];
    expect(arg.data.channels.disconnect).toEqual([{ id: "a" }, { id: "b" }]);
    expect(arg.data.channels.connect).toBeUndefined();
  });

  it("counts rows actually ADDED, not ids submitted (idempotent re-add)", async () => {
    // 3 submitted, 2 already members => only 1 genuinely added.
    const { caller } = buildCaller({
      groupFound: true,
      ownedIds: ["a", "b", "c"],
      existingMembers: ["a", "b"],
    });
    const res = await caller.setChannels({
      groupId: "group-1",
      channelIds: ["a", "b", "c"],
      mode: "add",
    });
    expect(res.changed).toBe(1);
  });

  it("counts rows actually REMOVED, ignoring non-members", async () => {
    const { caller } = buildCaller({
      groupFound: true,
      ownedIds: ["a", "b", "c"],
      existingMembers: ["a"],
    });
    const res = await caller.setChannels({
      groupId: "group-1",
      channelIds: ["a", "b", "c"],
      mode: "remove",
    });
    expect(res.changed).toBe(1);
  });

  it("dedupes repeated ids before querying and writing", async () => {
    const { caller, channelFindMany, groupUpdate } = buildCaller({
      groupFound: true,
      ownedIds: ["a"],
    });
    await caller.setChannels({ groupId: "group-1", channelIds: ["a", "a", "a"], mode: "add" });

    expect(channelFindMany.mock.calls[0]![0].where.id.in).toEqual(["a"]);
    expect(groupUpdate.mock.calls[0]![0].data.channels.connect).toEqual([{ id: "a" }]);
  });
});

describe("channelGroup.setChannels — IDOR / org scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("org-scopes the group lookup and rejects a foreign group WITHOUT writing", async () => {
    const { caller, groupFindFirst, groupUpdate } = buildCaller({
      groupFound: false,
      ownedIds: ["a"],
    });

    await expect(
      caller.setChannels({ groupId: "group-other-org", channelIds: ["a"], mode: "add" })
    ).rejects.toThrow();

    expect(groupFindFirst.mock.calls[0]![0].where).toEqual({
      id: "group-other-org",
      organizationId: ORG_ID,
    });
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it("validates every channelId against the acting org before connecting", async () => {
    const { caller, channelFindMany } = buildCaller({ groupFound: true, ownedIds: ["mine"] });
    await caller.setChannels({ groupId: "group-1", channelIds: ["mine"], mode: "add" });

    // The batch guard must carry the org filter — this is what stops a
    // cross-org channel being attached to a group.
    expect(channelFindMany.mock.calls[0]![0].where.organizationId).toBe(ORG_ID);
  });

  it("silently DROPS foreign/stale ids but still applies the owned ones", async () => {
    const { caller, groupUpdate } = buildCaller({ groupFound: true, ownedIds: ["mine-1", "mine-2"] });

    const res = await caller.setChannels({
      groupId: "group-1",
      channelIds: ["mine-1", "foreign", "mine-2", "stale"],
      mode: "add",
    });

    // A single disconnected/foreign id must not fail a large select-all.
    expect(groupUpdate.mock.calls[0]![0].data.channels.connect).toEqual([
      { id: "mine-1" },
      { id: "mine-2" },
    ]);
    expect(res.changed).toBe(2);
  });

  it("throws when NONE of the ids belong to the org (no empty write)", async () => {
    const { caller, groupUpdate } = buildCaller({ groupFound: true, ownedIds: [] });

    await expect(
      caller.setChannels({ groupId: "group-1", channelIds: ["foreign-1", "foreign-2"], mode: "add" })
    ).rejects.toThrow(/No channels found/);
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it("cannot be called for another org's channels even with a valid own group", async () => {
    // ownedIds belongs to ORG_ID; ids from OTHER_ORG_ID are simply not returned.
    const { caller } = buildCaller({ groupFound: true, ownedIds: ["mine"] });
    await expect(
      caller.setChannels({
        groupId: "group-1",
        channelIds: [`${OTHER_ORG_ID}-channel`],
        mode: "add",
      })
    ).rejects.toThrow(/No channels found/);
  });
});

describe("channelGroup.setChannels — input validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an empty batch", async () => {
    const { caller } = buildCaller({ groupFound: true, ownedIds: ["a"] });
    await expect(
      caller.setChannels({ groupId: "group-1", channelIds: [], mode: "add" })
    ).rejects.toThrow();
  });

  it("rejects a batch over the 500 guardrail", async () => {
    const { caller } = buildCaller({ groupFound: true, ownedIds: [] });
    const tooMany = Array.from({ length: 501 }, (_, i) => `ch-${i}`);
    await expect(
      caller.setChannels({ groupId: "group-1", channelIds: tooMany, mode: "add" })
    ).rejects.toThrow();
  });
});
