/**
 * comment.automationSettings / updateAutomation / autoHideLog and the unhide
 * bookkeeping in comment.moderate (2026-10-05), through the REAL router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createAuditLog = vi.fn(async (_input: any) => {});
const igSetHidden = vi.fn(async () => {});

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return {
    ...actual,
    fetchMetaTokenWindow: vi.fn(async () => null),
    resolveMetaCredentials: vi.fn(() => null),
    getSocialProvider: vi.fn(() => ({ setCommentHidden: igSetHidden, getCommentMediaId: vi.fn(async () => "MEDIA_1") })),
  };
});
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, createAuditLog: (input: any) => createAuditLog(input) };
});

import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";
import { AUDIT_ACTIONS } from "../lib/audit";

const ORG = "org-1";

function build(opts: { role?: string; row?: any; channels?: any[]; actions?: any[]; targets?: any[] } = {}) {
  const automationUpsert = vi.fn(async (_a: any) => ({}));
  const actionUpdateMany = vi.fn(async (_a: any) => ({ count: 1 }));
  const channelFindMany = vi.fn(async (a: any) => {
    const all = opts.channels ?? [];
    const ids: string[] | undefined = a?.where?.id?.in;
    return ids ? all.filter((c) => ids.includes(c.id) && c.organizationId === a.where.organizationId) : all;
  });
  const prisma = {
    $executeRaw: vi.fn(async () => 1),
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: ORG, role: opts.role ?? "OWNER" })) },
    commentAutomation: { findUnique: vi.fn(async () => opts.row ?? null), upsert: automationUpsert },
    commentAutoAction: { findMany: vi.fn(async () => opts.actions ?? []), updateMany: actionUpdateMany },
    channel: {
      findMany: channelFindMany,
      findUnique: vi.fn(async () => ({
        id: "ch-ig", organizationId: ORG, platform: "INSTAGRAM", platformId: "IG", name: "Daily", username: "daily",
        avatar: null, disconnectedAt: null, accessToken: "T", refreshToken: null, metaAppId: null,
        metadata: { igUserId: "IG", grantedScopes: ["instagram_basic", "instagram_manage_comments"] },
      })),
    },
    postTarget: {
      findMany: vi.fn(async () => opts.targets ?? []),
      findUnique: vi.fn(async () => ({
        id: "t-1", status: "PUBLISHED", format: null, publishedId: "MEDIA_1", publishedUrl: null, channelId: "ch-ig",
        metadata: null, post: { organizationId: ORG },
      })),
    },
  } as any;
  const caller = createCallerFactory(commentRouter)({
    prisma,
    session: { user: { id: `u-${Math.random()}`, email: "u@example.com", isSuperAdmin: true } } as any,
    organizationId: ORG,
  });
  return { caller, prisma, automationUpsert, actionUpdateMany, channelFindMany };
}

const CHANNELS = [
  { id: "ch-ig", organizationId: ORG, platform: "INSTAGRAM", name: "Daily", username: "daily", avatar: null, isActive: true, metadata: { grantedScopes: ["instagram_basic", "instagram_manage_comments"] } },
  { id: "ch-fb", organizationId: ORG, platform: "FACEBOOK", name: "Page", username: null, avatar: null, isActive: true, metadata: { grantedScopes: ["pages_read_engagement", "pages_read_user_content"] } },
];

beforeEach(() => vi.clearAllMocks());

describe("comment.automationSettings", () => {
  it("returns all-off defaults when nothing was saved, and says who may edit", async () => {
    const { caller } = build({ role: "MEMBER", channels: CHANNELS });
    const res = await caller.automationSettings();
    expect(res.settings).toEqual({ autoHideEnabled: false, blockedWords: [], hideLinks: false, alertsEnabled: false, sentimentEnabled: false, channelIds: [] });
    expect(res.canEdit).toBe(false);
    expect(res.accounts.map((a) => [a.id, a.canModerate])).toEqual([["ch-ig", true], ["ch-fb", false]]);
    expect(JSON.stringify(res)).not.toContain("grantedScopes");
  });
});

describe("comment.updateAutomation", () => {
  it("owners save cleaned words and only their own FB/IG/YouTube channel ids; it is audited", async () => {
    const { caller, automationUpsert, channelFindMany } = build({ channels: [...CHANNELS, { id: "foreign", organizationId: "org-2", platform: "INSTAGRAM" }] });
    const res = await caller.updateAutomation({
      autoHideEnabled: true,
      blockedWords: ["  Scam ", "scam", "DM  me", ""],
      hideLinks: false,
      alertsEnabled: true,
      channelIds: ["ch-ig", "foreign", "ch-ig"],
    });
    expect(res).toEqual({ ok: true, blockedWords: ["scam", "dm me"], channelIds: ["ch-ig"] });
    const where = channelFindMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ organizationId: ORG, disconnectedAt: null, platform: { in: ["FACEBOOK", "INSTAGRAM", "YOUTUBE"] } });
    expect(automationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG },
        create: expect.objectContaining({ organizationId: ORG, blockedWords: ["scam", "dm me"], channelIds: ["ch-ig"] }),
      })
    );
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.COMMENT_AUTOMATION_UPDATED, metadata: expect.not.objectContaining({ blockedWords: expect.anything() }) })
    );
  });

  it("members cannot change it", async () => {
    const { caller, automationUpsert } = build({ role: "MEMBER" });
    await expect(
      caller.updateAutomation({ autoHideEnabled: false, blockedWords: [], hideLinks: false, alertsEnabled: true, channelIds: [] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(automationUpsert).not.toHaveBeenCalled();
  });

  it("refuses to switch auto-hide on with no rule at all", async () => {
    const { caller } = build();
    await expect(
      caller.updateAutomation({ autoHideEnabled: true, blockedWords: ["   "], hideLinks: false, alertsEnabled: false, channelIds: [] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("comment.autoHideLog", () => {
  it("lists the org's actions with channel and post looked up org-scoped", async () => {
    const { caller, prisma } = build({
      actions: [{ id: "a1", organizationId: ORG, postTargetId: "t-1", channelId: "ch-ig", platform: "INSTAGRAM", commentId: "c1", commentText: "scam", authorLabel: "@x", reason: "word:scam", status: "HIDDEN", createdAt: new Date() }],
      channels: CHANNELS,
      targets: [{ id: "t-1", publishedUrl: "https://ig/p/1", contentOverride: null, post: { content: "Trailer out" } }],
    });
    const res = await caller.autoHideLog({});
    expect(res.items[0]).toMatchObject({ commentId: "c1", channelName: "Daily", postCaption: "Trailer out", reason: "word:scam", status: "HIDDEN" });
    expect(prisma.commentAutoAction.findMany.mock.calls[0]![0].where).toEqual({ organizationId: ORG });
    expect(prisma.postTarget.findMany.mock.calls[0]![0].where.post).toEqual({ organizationId: ORG });
  });
});

describe("comment.moderate unhide marks the auto-hide log", () => {
  it("an unhide records UNHIDDEN for this org's log row; a hide does not touch it", async () => {
    const { caller, actionUpdateMany } = build();
    await caller.moderate({ targetId: "t-1", commentId: "17900000000000001", action: "unhide" });
    expect(actionUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, commentId: "17900000000000001" },
      data: { status: "UNHIDDEN" },
    });
    actionUpdateMany.mockClear();
    await caller.moderate({ targetId: "t-1", commentId: "17900000000000001", action: "hide" });
    expect(actionUpdateMany).not.toHaveBeenCalled();
  });
});
