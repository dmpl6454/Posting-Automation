/**
 * chat.sendMessage must org-scope attachmentMediaIds through assertMediaOwned
 * — the SAME guard the post-action paths already use (see chat.router.ts's
 * publish_now/schedule_post/bulk_schedule cases) — before creating the
 * ChatAttachment rows (security audit 2026-09-28, confirmed).
 *
 * Without it, a member of org A could reference a Media id belonging to ANY
 * other organization, and it would be attached and rendered inline in org A's
 * chat thread (the include selects url/thumbnailUrl/fileName) — leaking the
 * existence, URL and filename of a file that isn't theirs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@postautomation/queue", () => ({
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: vi.fn(async () => {}) },
  captionFanoutQueue: { add: vi.fn(async () => {}) },
}));
vi.mock("../lib/caption-fanout", () => ({
  planCaptionFanout: vi.fn(() => ({ enabled: false, pendingSchedule: false })),
  captionFanoutJobId: (id: string) => `caption-fanout-${id}`,
}));

const chatThreadFindFirst = vi.fn();
const chatThreadUpdate = vi.fn(async (_a: any) => ({}));
const chatMessageCreate = vi.fn(async (_a: any) => ({ id: "msg-1", attachments: [] as any[] }));
const mediaFindMany = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    chatThread: { findFirst: (a: any) => chatThreadFindFirst(a), update: (a: any) => chatThreadUpdate(a) },
    chatMessage: { create: (a: any) => chatMessageCreate(a) },
    media: { findMany: (a: any) => mediaFindMany(a) },
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
    organization: { findUnique: vi.fn(async () => null) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { chatRouter } from "../routers/chat.router";

function caller() {
  return createCallerFactory(chatRouter)({
    prisma: {
      chatThread: { findFirst: (a: any) => chatThreadFindFirst(a), update: (a: any) => chatThreadUpdate(a) },
      chatMessage: { create: (a: any) => chatMessageCreate(a) },
      media: { findMany: (a: any) => mediaFindMany(a) },
      organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
      organization: { findUnique: vi.fn(async () => null) },
    } as any,
    organizationId: "org-1",
    session: { user: { id: "u1", email: "u@x.com", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  chatThreadFindFirst.mockResolvedValue({ id: "t1", organizationId: "org-1", title: "New Chat" });
});

describe("chat.sendMessage — attachmentMediaIds", () => {
  it("refuses when an attached media id belongs to a different organization", async () => {
    mediaFindMany.mockResolvedValue([]); // none of the requested ids are in this org
    await expect(
      caller().sendMessage({ threadId: "t1", content: "hi", attachmentMediaIds: ["foreign-media"] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(chatMessageCreate).not.toHaveBeenCalled();
  });

  it("still sends normally when every attached media id is owned", async () => {
    mediaFindMany.mockResolvedValue([{ id: "own-media" }]);
    await expect(
      caller().sendMessage({ threadId: "t1", content: "hi", attachmentMediaIds: ["own-media"] })
    ).resolves.toBeDefined();
    expect(chatMessageCreate).toHaveBeenCalledTimes(1);
  });

  it("still sends normally with no attachments (unaffected)", async () => {
    await expect(caller().sendMessage({ threadId: "t1", content: "hi" })).resolves.toBeDefined();
    expect(mediaFindMany).not.toHaveBeenCalled();
    expect(chatMessageCreate).toHaveBeenCalledTimes(1);
  });
});
