/**
 * Super Agent — a chat action must never post to TikTok (2026-10-28).
 *
 * TikTok's Content Sharing Guidelines require the USER to pick who can see each
 * post (no default) and to see the consent line. An LLM-emitted action has
 * neither, so schedule_post / bulk_schedule / publish_now refuse any TikTok
 * channel and point the user at Content Studio. Nothing is created.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const postPublishAdd = vi.fn(async (..._a: any[]) => undefined);
vi.mock("@postautomation/queue", () => ({
  postPublishQueue: { add: (...a: any[]) => postPublishAdd(...a) },
  agentRunQueue: { add: vi.fn(async () => undefined) },
  captionFanoutQueue: { add: vi.fn(async () => undefined) },
}));

const chatThreadFindFirst = vi.fn();
const chatMessageFindFirst = vi.fn();
const chatMessageCreate = vi.fn();
const postCreate = vi.fn();
const channelFindMany = vi.fn();
const mediaFindMany = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ id: "m1", userId: "user-1", organizationId: "org-1", role: "OWNER" })),
      findFirst: vi.fn(async () => ({ organizationId: "org-1" })),
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

const CHANNELS = [
  { id: "tt", platform: "TIKTOK" },
  { id: "ig", platform: "INSTAGRAM" },
];

function caller() {
  return createCallerFactory(chatRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "b@example.com", isSuperAdmin: true }, expires: "2099-01-01" } as any,
  });
}

const REFUSAL = "TikTok posts need their privacy settings chosen in Content Studio — schedule this one there.";

beforeEach(() => {
  vi.clearAllMocks();
  chatThreadFindFirst.mockResolvedValue({ id: "thread-1", organizationId: "org-1", agentId: null });
  chatMessageFindFirst.mockResolvedValue(null);
  chatMessageCreate.mockResolvedValue({ id: "msg" });
  mediaFindMany.mockResolvedValue([]);
  // Honours the where clause like Postgres would.
  channelFindMany.mockImplementation(async (args: any) => {
    const want: string[] = args?.where?.id?.in ?? [];
    return CHANNELS.filter((c) => want.includes(c.id) && (!args?.where?.platform || args.where.platform === c.platform));
  });
  postCreate.mockResolvedValue({ id: "post-1", content: "hi", scheduledAt: new Date(), targets: [] });
});

describe("chat actions refuse TikTok channels", () => {
  for (const actionType of ["schedule_post", "publish_now"] as const) {
    it(`${actionType}: refuses a TikTok channel and creates nothing`, async () => {
      await expect(
        caller().executeAction({ threadId: "thread-1", actionType, payload: { content: "hi", channelIds: ["ig", "tt"] } })
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: REFUSAL });
      expect(postCreate).not.toHaveBeenCalled();
      expect(postPublishAdd).not.toHaveBeenCalled();
    });

    it(`${actionType}: a non-TikTok post goes through as before`, async () => {
      await caller().executeAction({ threadId: "thread-1", actionType, payload: { content: "hi", channelIds: ["ig"] } });
      expect(postCreate).toHaveBeenCalledTimes(1);
    });
  }

  it("bulk_schedule: refuses an item with a TikTok channel", async () => {
    await expect(
      caller().executeAction({
        threadId: "thread-1",
        actionType: "bulk_schedule",
        payload: { posts: [{ content: "a", channelIds: ["ig"] }, { content: "b", channelIds: ["tt"] }] },
      })
    ).rejects.toMatchObject({ message: REFUSAL });
    // Checked for every item up front — the Instagram item was NOT created first.
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("checks ownership FIRST — a foreign id is refused as foreign, not as TikTok", async () => {
    await expect(
      caller().executeAction({ threadId: "thread-1", actionType: "schedule_post", payload: { content: "hi", channelIds: ["nope"] } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
