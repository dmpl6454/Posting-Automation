/**
 * comment.create (new top-level IG comment), comment.mentions / replyMention /
 * dismissMention, and the webhook mention store (2026-10-17). Real router,
 * mocked prisma + provider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const commentOnMedia = vi.fn();
const replyToMention = vi.fn();
const getMentionDetails = vi.fn();
const createAuditLog = vi.fn(async (_input: any) => {});

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return {
    ...actual,
    fetchMetaTokenWindow: vi.fn(async () => null),
    resolveMetaCredentials: vi.fn(() => ({ appId: "APP", clientId: "APP", clientSecret: "SECRET", legacy: true })),
    getSocialProvider: vi.fn(() => ({ commentOnMedia, replyToMention, getMentionDetails })),
  };
});
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, createAuditLog: (input: any) => createAuditLog(input) };
});
vi.mock("@postautomation/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/db")>();
  return { ...actual, prisma: {} };
});

import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";
import { storeInstagramMentions } from "../lib/instagram-mention-store";

const ORG = "org-1";
const UNCONFIRMED = "Instagram accepted the comment but did not confirm it. Refresh … it may already be posted.";

function channel(over: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    organizationId: ORG,
    platform: "INSTAGRAM",
    platformId: "17841400000000001",
    name: "Bollywood Daily",
    username: "bollywooddaily",
    avatar: null,
    disconnectedAt: null,
    accessToken: "DECRYPTED",
    refreshToken: null,
    metadata: { igUserId: "17841400000000001" },
    ...over,
  };
}

function build(opts: { target?: any; channel?: any; mention?: any; mentions?: any[] } = {}) {
  const target = {
    id: "t-1",
    status: "PUBLISHED",
    format: null,
    publishedId: "17890000000000001",
    publishedUrl: null,
    channelId: "ch-1",
    metadata: null,
    post: { organizationId: ORG },
    ...(opts.target ?? {}),
  };
  const ch = opts.channel === null ? null : channel(opts.channel ?? {});
  const mention =
    opts.mention === null
      ? null
      : {
          id: "m-1",
          organizationId: ORG,
          channelId: "ch-1",
          igUserId: "17841400000000001",
          mediaId: "17900000000000002",
          commentId: null,
          replyStatus: null,
          ...(opts.mention ?? {}),
        };
  const prisma: any = {
    $executeRaw: vi.fn(async () => 1),
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u", organizationId: ORG, role: "OWNER" })) },
    postTarget: { findUnique: vi.fn(async () => target) },
    channel: {
      findUnique: vi.fn(async () => ch),
      findMany: vi.fn(async () => (ch ? [ch] : [])),
    },
    instagramMention: {
      findFirst: vi.fn(async (args: any) => (mention && args.where.organizationId === ORG && args.where.id === mention.id ? mention : null)),
      findMany: vi.fn(async () => opts.mentions ?? []),
      count: vi.fn(async () => (opts.mentions ?? []).length),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const caller = createCallerFactory(commentRouter)({
    prisma,
    session: { user: { id: "u", email: "u@example.com", isSuperAdmin: true } } as any,
    organizationId: ORG,
  });
  return { caller, prisma };
}

beforeEach(() => {
  vi.clearAllMocks();
  commentOnMedia.mockReset();
  replyToMention.mockReset();
  getMentionDetails.mockReset();
});

describe("comment.create", () => {
  it("comments on the TARGET's own media with the decrypted token, and audits it", async () => {
    commentOnMedia.mockResolvedValue({ id: "c-9" });
    const { caller } = build();
    await expect(caller.create({ targetId: "t-1", message: "  First! " })).resolves.toEqual({ id: "c-9", platform: "INSTAGRAM" });
    expect(commentOnMedia).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED" }),
      "17890000000000001",
      "First!"
    );
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "comment.created" }));
  });

  it("refuses Facebook targets, stories, and other orgs' posts", async () => {
    await expect(build({ channel: { platform: "FACEBOOK" } }).caller.create({ targetId: "t-1", message: "x" })).rejects.toThrow(
      /Instagram posts only/
    );
    await expect(build({ target: { format: "STORY" } }).caller.create({ targetId: "t-1", message: "x" })).rejects.toThrow(/stories/);
    await expect(
      build({ target: { post: { organizationId: "other" } } }).caller.create({ targetId: "t-1", message: "x" })
    ).rejects.toThrow(/not found/i);
    expect(commentOnMedia).not.toHaveBeenCalled();
  });

  it("an unknown outcome is surfaced verbatim and still audited", async () => {
    commentOnMedia.mockRejectedValue(new Error(UNCONFIRMED));
    const { caller } = build();
    await expect(caller.create({ targetId: "t-1", message: "x" })).rejects.toThrow(/may already be posted/);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: "unconfirmed" }) })
    );
  });

  it("rejects over-long comments before any Graph call", async () => {
    const { caller } = build();
    await expect(caller.create({ targetId: "t-1", message: "x".repeat(2201) })).rejects.toThrow();
    expect(commentOnMedia).not.toHaveBeenCalled();
  });
});

describe("comment.replyMention", () => {
  it("replies with the stored ids and records SENT", async () => {
    replyToMention.mockResolvedValue({ id: "r-1" });
    const { caller, prisma } = build({ mention: { commentId: "17900000000000003" } });
    await caller.replyMention({ mentionId: "m-1", message: "Thanks!" });
    expect(replyToMention).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED" }),
      "17841400000000001",
      "17900000000000002",
      "17900000000000003",
      "Thanks!"
    );
    expect(prisma.instagramMention.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replyStatus: "SENT", replyId: "r-1" }) })
    );
  });

  it("is org-scoped", async () => {
    const { caller } = build();
    await expect(caller.replyMention({ mentionId: "m-other", message: "x" })).rejects.toThrow(/not found/i);
    expect(replyToMention).not.toHaveBeenCalled();
  });

  it("refuses a disconnected account and a channel from another org", async () => {
    await expect(build({ channel: { disconnectedAt: new Date() } }).caller.replyMention({ mentionId: "m-1", message: "x" })).rejects.toThrow(
      /disconnected/
    );
    await expect(build({ channel: { organizationId: "other" } }).caller.replyMention({ mentionId: "m-1", message: "x" })).rejects.toThrow(
      /not found/i
    );
  });

  it("an unknown outcome is recorded UNCONFIRMED, and a second reply needs `again`", async () => {
    replyToMention.mockRejectedValue(new Error("Instagram accepted the reply … it may already be posted."));
    const { caller, prisma } = build();
    await expect(caller.replyMention({ mentionId: "m-1", message: "x" })).rejects.toThrow(/may already be posted/);
    expect(prisma.instagramMention.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replyStatus: "UNCONFIRMED" }) })
    );

    const again = build({ mention: { replyStatus: "UNCONFIRMED" } });
    await expect(again.caller.replyMention({ mentionId: "m-1", message: "x" })).rejects.toThrow(/may already be live/);
    replyToMention.mockResolvedValue({ id: "r-2" });
    await expect(again.caller.replyMention({ mentionId: "m-1", message: "x", again: true })).resolves.toEqual({ id: "r-2" });
  });
});

describe("comment.mentions / dismissMention", () => {
  it("lists only this org's open mentions by default, never exposing the token", async () => {
    const { caller, prisma } = build({
      mentions: [{ id: "m-1", channelId: "ch-1", commentId: null, text: "hi @us", createdAt: new Date(), replyStatus: null }],
    });
    const res = await caller.mentions();
    const where = prisma.instagramMention.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({ organizationId: ORG, dismissedAt: null, replyStatus: null });
    expect(res.mentions[0]).toMatchObject({ id: "m-1", kind: "caption", account: { channelId: "ch-1", name: "Bollywood Daily" } });
    const select = prisma.channel.findMany.mock.calls[0]![0].select;
    expect(select.accessToken).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("DECRYPTED");
  });

  it("dismiss is org-scoped", async () => {
    const { caller, prisma } = build();
    prisma.instagramMention.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(caller.dismissMention({ mentionId: "m-x", dismissed: true })).rejects.toThrow(/not found/i);
    expect(prisma.instagramMention.updateMany.mock.calls[0]![0].where).toEqual({ id: "m-x", organizationId: ORG });
  });
});

describe("storeInstagramMentions", () => {
  const event = { igUserId: "17841400000000001", mediaId: "17900000000000002", commentId: null, sentAt: null };

  it("writes one row per connected channel of that account, then fills in the details", async () => {
    const createMany = vi.fn(async (args: any) => ({ count: args.data.length }));
    const updateMany = vi.fn(async (_a: any) => ({ count: 2 }));
    const findMany = vi.fn(async (_a: any) => [
      { id: "ch-1", organizationId: "org-1", platformId: event.igUserId, accessToken: "T1", metadata: null },
      { id: "ch-2", organizationId: "org-2", platformId: event.igUserId, accessToken: "T2", metadata: null },
    ]);
    const provider = {
      getMentionDetails: vi.fn(async () => ({
        text: "love @us",
        username: "fan",
        permalink: "https://www.instagram.com/p/x/",
        mediaType: "IMAGE",
        timestamp: "2026-10-17T10:00:00+0000",
      })),
    };
    const prisma = { channel: { findMany }, instagramMention: { createMany, updateMany } };
    vi.stubEnv("INSTAGRAM_CLIENT_ID", "APP");
    vi.stubEnv("INSTAGRAM_CLIENT_SECRET", "S");
    const r = await storeInstagramMentions([event, event], "APP", { prisma, provider });
    vi.unstubAllEnvs();

    expect(findMany.mock.calls[0]![0].where).toMatchObject({ platform: "INSTAGRAM", disconnectedAt: null });
    expect(createMany.mock.calls[0]![0]).toMatchObject({ skipDuplicates: true });
    expect(createMany.mock.calls[0]![0].data.map((d: any) => [d.organizationId, d.dedupKey])).toEqual([
      ["org-1", "17900000000000002:caption"],
      ["org-2", "17900000000000002:caption"],
      ["org-1", "17900000000000002:caption"],
      ["org-2", "17900000000000002:caption"],
    ]);
    // The duplicate event is looked up once.
    expect(provider.getMentionDetails).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { igUserId: event.igUserId, dedupKey: "17900000000000002:caption" },
      data: { text: "love @us", username: "fan", mentionedAt: new Date("2026-10-17T10:00:00Z") },
    });
    expect(r).toEqual({ stored: 4, lookedUp: 1 });
  });

  it("never throws, and records a failed lookup", async () => {
    const updateMany = vi.fn(async (_a: any) => ({ count: 1 }));
    const prisma = {
      channel: { findMany: vi.fn(async () => [{ id: "ch-1", organizationId: "o", platformId: event.igUserId, accessToken: "T", metadata: null }]) },
      instagramMention: { createMany: vi.fn(async () => ({ count: 1 })), updateMany },
    };
    const provider = { getMentionDetails: vi.fn(async () => { throw new Error("gone"); }) };
    await expect(storeInstagramMentions([event], "APP", { prisma, provider })).resolves.toEqual({ stored: 1, lookedUp: 1 });
    expect(updateMany.mock.calls[0]![0].data).toMatchObject({ detailsError: "gone" });

    const broken = { channel: { findMany: vi.fn(async () => { throw new Error("db"); }) } };
    await expect(storeInstagramMentions([event], "APP", { prisma: broken, provider })).resolves.toEqual({ stored: 0, lookedUp: 0 });
  });
});
