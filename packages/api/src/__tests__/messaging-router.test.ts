/**
 * Private replies (comment.privateReply) + the Messages inbox (message.*),
 * 2026-10-05 — the REAL routers through a tRPC caller with mocked prisma and a
 * mocked Facebook provider (every messaging call runs on it, IG included).
 *
 * Locks: org scoping, the direct channel read (decrypt path), the grant gate,
 * the linked-Page lookup for Instagram, the recipient coming from the
 * conversation (never the client), the 24-hour window, and the
 * one-private-reply-per-comment bookkeeping including unknown outcomes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendPrivateReply = vi.fn();
const listConversations = vi.fn();
const getConversation = vi.fn();
const sendMessage = vi.fn();
const resolveInstagramPage = vi.fn();
const getCommentMediaId = vi.fn();
const fetchMetaTokenWindow = vi.fn();
const createAuditLog = vi.fn(async (_input: any) => {});

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return {
    ...actual,
    fetchMetaTokenWindow: (...args: any[]) => fetchMetaTokenWindow(...args),
    resolveMetaCredentials: vi.fn(() => ({ appId: "APP", clientId: "APP", clientSecret: "SECRET", legacy: true })),
    getSocialProvider: vi.fn((platform: string) =>
      platform === "FACEBOOK"
        ? { sendPrivateReply, listConversations, getConversation, sendMessage, resolveInstagramPage }
        : { getCommentMediaId }
    ),
  };
});

vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, createAuditLog: (input: any) => createAuditLog(input) };
});

import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";
import { messageRouter } from "../routers/message.router";
import { __resetMessagingAccessCache } from "../lib/meta-messaging-access";
import { MessagingError } from "@postautomation/social";

const ORG = "org-1";
const USER = "user-1";
const PAGE = "111";
const IG = "1784";
const FRESH = new Date().toISOString();
const FB_SCOPES = ["pages_messaging", "pages_manage_metadata", "pages_read_engagement"];
const IG_SCOPES = ["instagram_basic", "instagram_manage_comments", "pages_read_engagement", "instagram_manage_messages", "pages_manage_metadata"];

function fbChannel(over: Record<string, unknown> = {}) {
  return {
    id: "ch-fb",
    organizationId: ORG,
    platform: "FACEBOOK",
    platformId: PAGE,
    name: "My Page",
    username: null,
    avatar: null,
    disconnectedAt: null,
    accessToken: "PAGE_TOKEN",
    refreshToken: null,
    metaAppId: null,
    metadata: { pageId: PAGE, grantedScopes: FB_SCOPES, grantedScopesCheckedAt: FRESH },
    ...over,
  };
}

function igChannel(over: Record<string, unknown> = {}) {
  return {
    id: "ch-ig",
    organizationId: ORG,
    platform: "INSTAGRAM",
    platformId: IG,
    name: "insta",
    username: "insta",
    avatar: null,
    disconnectedAt: null,
    accessToken: "USER_TOKEN",
    refreshToken: null,
    metaAppId: null,
    metadata: { igUserId: IG, grantedScopes: IG_SCOPES, grantedScopesCheckedAt: FRESH },
    ...over,
  };
}

function build(channel: any, opts: { target?: any; existingReply?: any } = {}) {
  const target = opts.target ?? {
    id: "t-1",
    status: "PUBLISHED",
    format: null,
    publishedId: channel?.platform === "FACEBOOK" ? `${PAGE}_9` : "MEDIA_1",
    publishedUrl: null,
    channelId: channel?.id,
    metadata: null,
    post: { organizationId: ORG },
  };
  const upsert = vi.fn(async (_a: any) => ({}));
  const executeRaw = vi.fn(async () => 1);
  const prisma = {
    $executeRaw: executeRaw,
    organizationMember: { findUnique: vi.fn(async () => ({ userId: USER, organizationId: ORG, role: "OWNER" })) },
    postTarget: { findUnique: vi.fn(async () => target) },
    channel: { findUnique: vi.fn(async () => channel), findMany: vi.fn(async () => (channel ? [channel] : [])) },
    commentPrivateReply: {
      findUnique: vi.fn(async () => opts.existingReply ?? null),
      upsert,
      findMany: vi.fn(async () => []),
    },
  } as any;
  const ctx = { prisma, session: { user: { id: USER, email: "u@x", isSuperAdmin: true } } as any, organizationId: ORG };
  return {
    comment: createCallerFactory(commentRouter)(ctx),
    message: createCallerFactory(messageRouter)(ctx),
    prisma,
    upsert,
    executeRaw,
  };
}

const THREAD_OPEN = {
  id: "t_1",
  participant: { id: "PSID", name: "Asha", username: null },
  messages: [],
  lastInboundAt: "x",
  windowOpen: true,
  windowClosesAt: "y",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetMessagingAccessCache();
  for (const f of [sendPrivateReply, listConversations, getConversation, sendMessage, resolveInstagramPage, getCommentMediaId, fetchMetaTokenWindow]) {
    f.mockReset();
  }
  fetchMetaTokenWindow.mockResolvedValue(null);
  getCommentMediaId.mockResolvedValue("MEDIA_1");
  resolveInstagramPage.mockResolvedValue({ pageId: "555", pageToken: "LINKED_PAGE_TOKEN" });
});

describe("message.conversations", () => {
  it("Facebook: the channel's own (decrypted) token and Page id, read DIRECTLY", async () => {
    listConversations.mockResolvedValue({ conversations: [], nextCursor: null });
    const { message, prisma } = build(fbChannel());
    const out = await message.conversations({ channelId: "ch-fb" });
    expect(prisma.channel.findUnique).toHaveBeenCalledWith({ where: { id: "ch-fb" } });
    expect(listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "FACEBOOK", pageToken: "PAGE_TOKEN", pageId: PAGE, ownIds: [PAGE] })
    );
    expect(out.blocked).toBe(false);
    expect(out.capabilities.canUseInbox).toBe(true);
  });

  it("Instagram: finds the linked Page, uses ITS token, and remembers the Page id", async () => {
    listConversations.mockResolvedValue({ conversations: [], nextCursor: null });
    const { message, executeRaw } = build(igChannel());
    await message.conversations({ channelId: "ch-ig" });
    expect(resolveInstagramPage).toHaveBeenCalledWith("USER_TOKEN", IG, null);
    expect(listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "INSTAGRAM", pageToken: "LINKED_PAGE_TOKEN", pageId: "555", ownIds: [IG, "555"] })
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);

    // Second load: cached Page token, no second lookup.
    await message.conversations({ channelId: "ch-ig" });
    expect(resolveInstagramPage).toHaveBeenCalledTimes(1);
  });

  it("an Instagram account with no linked Page is an actionable error", async () => {
    resolveInstagramPage.mockResolvedValue(null);
    const { message } = build(igChannel());
    await expect(message.conversations({ channelId: "ch-ig" })).rejects.toThrow(/linked to this Instagram account/);
  });

  it("a known-missing grant answers without a Graph call", async () => {
    const { message } = build(fbChannel({ metadata: { grantedScopes: ["pages_read_engagement"], grantedScopesCheckedAt: FRESH } }));
    const out = await message.conversations({ channelId: "ch-fb" });
    expect(out.blocked).toBe(true);
    expect(out.capabilities.missingForInbox).toEqual(["pages_messaging", "pages_manage_metadata"]);
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("another org's channel is NOT_FOUND", async () => {
    const { message } = build(fbChannel({ organizationId: "other" }));
    await expect(message.conversations({ channelId: "ch-fb" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("a non-Meta channel is refused", async () => {
    const { message } = build(fbChannel({ platform: "TWITTER" }));
    await expect(message.conversations({ channelId: "ch-fb" })).rejects.toThrow(/Facebook Pages and Instagram/);
  });
});

describe("message.thread", () => {
  it("refuses a numeric node id before any call", async () => {
    const { message } = build(fbChannel());
    await expect(message.thread({ channelId: "ch-fb", conversationId: `${PAGE}_9` })).rejects.toThrow();
    await expect(message.thread({ channelId: "ch-fb", conversationId: "t_1/messages" })).rejects.toThrow();
    expect(getConversation).not.toHaveBeenCalled();
  });
});

describe("message.send", () => {
  it("sends to the participant read from the conversation, not a client value", async () => {
    getConversation.mockResolvedValue(THREAD_OPEN);
    sendMessage.mockResolvedValue({ messageId: "m_9" });
    const { message } = build(fbChannel());
    const out = await message.send({ channelId: "ch-fb", conversationId: "t_10001", text: "Thanks!" });
    expect(out).toEqual({ messageId: "m_9" });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE, pageToken: "PAGE_TOKEN", recipientId: "PSID", text: "Thanks!" })
    );
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "message.sent" }));
    // never the text in the audit trail
    expect(JSON.stringify(createAuditLog.mock.calls)).not.toContain("Thanks!");
  });

  it("an expired 24-hour window is explained without a send", async () => {
    getConversation.mockResolvedValue({ ...THREAD_OPEN, windowOpen: false });
    const { message } = build(fbChannel());
    await expect(message.send({ channelId: "ch-fb", conversationId: "t_10001", text: "hi" })).rejects.toThrow(/within 24 hours/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("Instagram's 1,000-byte limit", async () => {
    const { message } = build(igChannel());
    await expect(message.send({ channelId: "ch-ig", conversationId: "aWdf123", text: "é".repeat(600) })).rejects.toThrow(/1,000 bytes/);
    expect(getConversation).not.toHaveBeenCalled();
  });

  it("an unconfirmed send is audited and reported as possibly sent", async () => {
    getConversation.mockResolvedValue(THREAD_OPEN);
    sendMessage.mockRejectedValue(new MessagingError("Facebook didn't confirm that message. It may already have been sent", "unconfirmed"));
    const { message } = build(fbChannel());
    await expect(message.send({ channelId: "ch-fb", conversationId: "t_10001", text: "hi" })).rejects.toThrow(/may already have been sent/);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "unconfirmed" }) }));
  });
});

describe("comment.privateReply", () => {
  const FB_COMMENT = "9_42";

  it("Facebook: sends as the Page and records SENT", async () => {
    sendPrivateReply.mockResolvedValue({ messageId: "m_1", recipientId: "PSID" });
    const { comment, upsert } = build(fbChannel());
    const out = await comment.privateReply({ targetId: "t-1", commentId: FB_COMMENT, message: "DM'd you the details" });
    expect(out.status).toBe("SENT");
    expect(sendPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "FACEBOOK", senderId: PAGE, pageId: PAGE, pageToken: "PAGE_TOKEN", commentId: FB_COMMENT })
    );
    expect(upsert.mock.calls[0]![0].create).toMatchObject({ organizationId: ORG, commentId: FB_COMMENT, status: "SENT", messageId: "m_1" });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "comment.private_replied" }));
  });

  it("Instagram: sends AS the IG account with the linked Page's token", async () => {
    sendPrivateReply.mockResolvedValue({ messageId: "aWdf", recipientId: "IGSID" });
    const { comment } = build(igChannel());
    await comment.privateReply({ targetId: "t-1", commentId: "1790", message: "hi" });
    expect(sendPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "INSTAGRAM", senderId: IG, pageId: "555", pageToken: "LINKED_PAGE_TOKEN" })
    );
  });

  it("refuses a second private reply we already recorded, without calling Meta", async () => {
    const { comment } = build(fbChannel(), { existingReply: { status: "SENT" } });
    await expect(comment.privateReply({ targetId: "t-1", commentId: FB_COMMENT, message: "again" })).rejects.toThrow(/only one/);
    expect(sendPrivateReply).not.toHaveBeenCalled();
  });

  it("an UNCONFIRMED earlier attempt may be retried (Meta itself refuses a duplicate)", async () => {
    sendPrivateReply.mockResolvedValue({ messageId: "m_2", recipientId: null });
    const { comment } = build(fbChannel(), { existingReply: { status: "UNCONFIRMED" } });
    await expect(comment.privateReply({ targetId: "t-1", commentId: FB_COMMENT, message: "retry" })).resolves.toMatchObject({ status: "SENT" });
  });

  it("an unknown outcome is recorded UNCONFIRMED and reported as possibly sent", async () => {
    sendPrivateReply.mockRejectedValue(new MessagingError("Facebook didn't confirm the private reply. It may already have been sent", "unconfirmed"));
    const { comment, upsert } = build(fbChannel());
    await expect(comment.privateReply({ targetId: "t-1", commentId: FB_COMMENT, message: "x" })).rejects.toThrow(/may already have been sent/);
    expect(upsert.mock.calls[0]![0].create.status).toBe("UNCONFIRMED");
  });

  it("Meta saying one was already sent is recorded as SENT", async () => {
    sendPrivateReply.mockRejectedValue(new MessagingError("A private reply has already been sent", "already_sent"));
    const { comment, upsert } = build(fbChannel());
    await expect(comment.privateReply({ targetId: "t-1", commentId: FB_COMMENT, message: "x" })).rejects.toThrow(/already been sent/);
    expect(upsert.mock.calls[0]![0].create.status).toBe("SENT");
  });

  it("a comment that isn't on this post is refused before any send", async () => {
    const { comment } = build(fbChannel());
    await expect(comment.privateReply({ targetId: "t-1", commentId: `${PAGE}_77`, message: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sendPrivateReply).not.toHaveBeenCalled();
  });

  it("another org's post is NOT_FOUND", async () => {
    const { comment } = build(fbChannel(), {
      target: { id: "t-1", status: "PUBLISHED", format: null, publishedId: `${PAGE}_9`, channelId: "ch-fb", metadata: null, post: { organizationId: "other" } },
    });
    await expect(comment.privateReply({ targetId: "t-1", commentId: FB_COMMENT, message: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
