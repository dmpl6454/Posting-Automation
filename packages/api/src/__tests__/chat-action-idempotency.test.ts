/**
 * Regression guard for the Super Agent "publish_now" idempotency fix (A1/B4,
 * Phase 1 Task 6).
 *
 * Bugs:
 *   (A1) The action button only disabled while the mutation was pending — after
 *        it resolved it re-enabled and `msg.action` was still rendered, so a user
 *        could click "Publish now" repeatedly and create duplicate LIVE posts.
 *        There was no server-side idempotency either.
 *   (B4) `postPublishQueue.add(..., { delay: 0 })` had NO retry attempts, unlike
 *        compose (post.router.ts: attempts:3, exponential backoff 30000).
 *
 * Fix (server, tested here):
 *   - `executeAction` accepts an optional `clientActionId`.
 *   - Before creating a Post in publish_now/schedule_post/bulk_schedule, if a
 *     `clientActionId` is set we look for a ChatMessage in this thread whose
 *     metadata.executedActionId === clientActionId. If found → short-circuit with
 *     `{ type: "already_executed" }` and create NO new Post / queue NO jobs.
 *   - The result ChatMessage stores `executedActionId` in its metadata so the
 *     dedupe check finds it next time.
 *   - `postPublishQueue.add` now passes `attempts:3` + exponential backoff.
 *
 * Built via createCallerFactory(chatRouter) against a mocked prisma + queue,
 * with a superadmin actor (so the plan/usage gates short-circuit without a DB
 * read), following the conventions in chat-channel-ownership / chat-action-media.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Queue mock: capture postPublishQueue.add calls so we can assert options ── */
const postPublishAdd = vi.fn(async () => undefined);
vi.mock("@postautomation/queue", () => ({
  postPublishQueue: { add: (...a: any[]) => postPublishAdd(...a) },
  agentRunQueue: { add: vi.fn(async () => undefined) },
}));

/* ── Prisma mock. orgProcedure requires a real membership; superadmin actor
 *    skips the plan-expiry revert + plan-limit DB reads. ── */
const chatThreadFindFirst = vi.fn();
const chatMessageFindFirst = vi.fn();
const chatMessageCreate = vi.fn();
const postCreate = vi.fn();
const channelFindMany = vi.fn();
const mediaFindMany = vi.fn();
const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    chatThread: { findFirst: (...a: any[]) => chatThreadFindFirst(...a) },
    chatMessage: {
      findFirst: (...a: any[]) => chatMessageFindFirst(...a),
      create: (...a: any[]) => chatMessageCreate(...a),
    },
    post: { create: (...a: any[]) => postCreate(...a) },
    channel: { findMany: (...a: any[]) => channelFindMany(...a) },
    media: { findMany: (...a: any[]) => mediaFindMany(...a) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { chatRouter } from "../routers/chat.router";
import { prisma as prismaMock } from "@postautomation/db";

const ORG_ID = "org-1";
const THREAD_ID = "thread-1";
const CHANNEL_ID = "chan-1";

function makeCaller() {
  const createCaller = createCallerFactory(chatRouter);
  return createCaller({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: {
      user: { id: "user-1", email: "boss@example.com", isSuperAdmin: true },
      expires: "2099-01-01",
    } as any,
  });
}

function publishNowInput(extra: Record<string, unknown> = {}) {
  return {
    threadId: THREAD_ID,
    actionType: "publish_now" as const,
    payload: { content: "Hello world", channelIds: [CHANNEL_ID] },
    ...extra,
  };
}

beforeEach(() => {
  postPublishAdd.mockReset();
  chatThreadFindFirst.mockReset();
  chatMessageFindFirst.mockReset();
  chatMessageCreate.mockReset();
  postCreate.mockReset();
  channelFindMany.mockReset();
  mediaFindMany.mockReset();
  orgMemberFindUnique.mockReset();
  orgMemberFindFirst.mockReset();

  // orgProcedure membership gate — real membership required for every actor.
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });

  // Thread belongs to the org.
  chatThreadFindFirst.mockResolvedValue({ id: THREAD_ID, organizationId: ORG_ID, agentId: null });
  // Channel ownership check passes.
  channelFindMany.mockResolvedValue([{ id: CHANNEL_ID }]);
  mediaFindMany.mockResolvedValue([]);
  // Post create returns one published target.
  postCreate.mockResolvedValue({
    id: "post-1",
    targets: [{ id: "tgt-1", channelId: CHANNEL_ID, channel: { platform: "TWITTER", name: "X" } }],
  });
  chatMessageCreate.mockResolvedValue({ id: "sysmsg-1" });
});

describe("publish_now server idempotency (A1)", () => {
  it("short-circuits when a marker row for the same clientActionId already exists — no Post created", async () => {
    // Dedupe query finds an existing executed marker in this thread.
    chatMessageFindFirst.mockResolvedValue({ id: "prev", metadata: { type: "post_published", executedActionId: "m1" } });

    const caller = makeCaller();
    const res = await caller.executeAction(publishNowInput({ clientActionId: "m1" }));

    expect(res).toMatchObject({ type: "already_executed" });
    expect(postCreate).not.toHaveBeenCalled();
    expect(postPublishAdd).not.toHaveBeenCalled();
    // The dedupe query must be keyed on (thread + clientActionId).
    const dedupeArgs = chatMessageFindFirst.mock.calls[0][0];
    expect(dedupeArgs.where.threadId).toBe(THREAD_ID);
    expect(dedupeArgs.where.metadata).toMatchObject({ path: ["executedActionId"], equals: "m1" });
  });

  it("creates exactly one Post when no marker exists and stamps executedActionId into the result message metadata", async () => {
    chatMessageFindFirst.mockResolvedValue(null);

    const caller = makeCaller();
    const res = await caller.executeAction(publishNowInput({ clientActionId: "m1" }));

    expect(res).toMatchObject({ type: "post_published", postId: "post-1" });
    expect(postCreate).toHaveBeenCalledTimes(1);

    // The result ChatMessage must carry executedActionId so the next call dedupes.
    const sysMsgCreateArgs = chatMessageCreate.mock.calls[0][0];
    expect(sysMsgCreateArgs.data.metadata).toMatchObject({ type: "post_published", executedActionId: "m1" });
  });

  it("does NOT run the dedupe query when no clientActionId is supplied (legacy callers still work)", async () => {
    const caller = makeCaller();
    const res = await caller.executeAction(publishNowInput());

    expect(res).toMatchObject({ type: "post_published" });
    expect(chatMessageFindFirst).not.toHaveBeenCalled();
    expect(postCreate).toHaveBeenCalledTimes(1);
  });
});

describe("publish_now queue retries (B4)", () => {
  it("queues each target with attempts:3 + exponential backoff (matches compose)", async () => {
    chatMessageFindFirst.mockResolvedValue(null);

    const caller = makeCaller();
    await caller.executeAction(publishNowInput({ clientActionId: "m1" }));

    expect(postPublishAdd).toHaveBeenCalledTimes(1);
    const opts = postPublishAdd.mock.calls[0][2];
    expect(opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 30000 } });
  });
});
