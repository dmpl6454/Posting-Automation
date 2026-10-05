import { describe, it, expect, vi } from "vitest";
import {
  alertCopy,
  hideCandidates,
  isCommentAutomationEnabled,
  newSinceWatermark,
  parseGraphTime,
  planSweepTargets,
  readSweepConfig,
  runCommentSweep,
  type SweepConfig,
} from "./comment-sweep";

const CFG: SweepConfig = { maxPostsPerRun: 40, maxPostsPerOrg: 15, lookbackDays: 3, fbUsageCeiling: 75, maxHidesPerOrg: 50 };
const NOW = new Date("2026-10-05T12:00:00Z");
const T = (iso: string) => iso.replace("Z", "+0000").replace(/\.\d{3}/, "");

function comment(id: string, text: string, over: Record<string, unknown> = {}) {
  return {
    id, text, createdAt: T("2026-10-05T11:00:00.000Z"),
    author: { id: "u" + id, name: "Asha", username: "asha_" + id },
    likeCount: 0, hidden: false, replyCount: 0, replies: [] as any[], isOwn: false, canReply: true,
    attachmentType: null, likedByAccount: null, canHide: true, canDelete: true, canLike: true, canEdit: false,
    ...over,
  } as any;
}

describe("config + switches", () => {
  it("defaults, clamps and ignores garbage", () => {
    expect(readSweepConfig({})).toEqual(CFG);
    expect(readSweepConfig({ COMMENT_SWEEP_MAX_POSTS: "9999", COMMENT_SWEEP_FB_USAGE_CEILING: "abc" })).toMatchObject({
      maxPostsPerRun: 200,
      fbUsageCeiling: 75,
    });
  });
  it("the kill switch is only an explicit false (workspaces opt in individually)", () => {
    expect(isCommentAutomationEnabled({})).toBe(true);
    expect(isCommentAutomationEnabled({ COMMENT_AUTOMATION_ENABLED: "" })).toBe(true);
    expect(isCommentAutomationEnabled({ COMMENT_AUTOMATION_ENABLED: "false" })).toBe(false);
  });
  it("parses Graph's +0000 timestamps", () => {
    expect(parseGraphTime("2026-10-05T11:00:00+0000")).toBe(Date.parse("2026-10-05T11:00:00Z"));
    expect(parseGraphTime("")).toBeNull();
    expect(parseGraphTime("nonsense")).toBeNull();
  });
});

describe("planSweepTargets", () => {
  const c = (id: string, org: string, checkedAt: number | null, publishedAt = "2026-10-05T00:00:00Z") => ({
    id, organizationId: org, channelId: "ch", checkedAt, publishedAt: new Date(publishedAt),
  });
  it("never-checked first, then stalest; newest post wins a tie", () => {
    const out = planSweepTargets(
      [c("old", "A", 5), c("fresh", "A", null, "2026-10-04T00:00:00Z"), c("newer", "A", null, "2026-10-05T00:00:00Z"), c("recent", "A", 9)],
      CFG
    );
    expect(out.map((x) => x.id)).toEqual(["newer", "fresh", "old", "recent"]);
  });
  it("caps per workspace and interleaves workspaces so one cannot starve another", () => {
    const many = Array.from({ length: 30 }, (_, i) => c(`a${i}`, "A", null));
    const out = planSweepTargets([...many, c("b0", "B", null), c("b1", "B", null)], { ...CFG, maxPostsPerRun: 6, maxPostsPerOrg: 15 });
    expect(out.map((x) => x.id)).toEqual(["a0", "b0", "a1", "b1", "a2", "a3"]);
    expect(planSweepTargets(many, { ...CFG, maxPostsPerOrg: 4 })).toHaveLength(4);
  });
});

describe("hideCandidates / newSinceWatermark / alertCopy", () => {
  it("never hides our own, already-hidden or un-hideable comments; includes embedded replies", () => {
    const list = [
      comment("own", "x", { isOwn: true }),
      comment("hid", "x", { hidden: true }),
      comment("no", "x", { canHide: false }),
      comment("ok", "x", { replies: [comment("r-ok", "y"), comment("r-own", "y", { isOwn: true })] }),
    ];
    expect(hideCandidates(list).map((c) => c.id)).toEqual(["ok", "r-ok"]);
  });

  it("first look sets the watermark and announces nothing", () => {
    const res = newSinceWatermark([comment("a", "hi")], null);
    expect(res.fresh).toEqual([]);
    expect(res.nextWatermark).toBe(Date.parse("2026-10-05T11:00:00Z"));
  });

  it("later looks announce only newer, visible, non-own comments not just hidden", () => {
    const wm = Date.parse("2026-10-05T10:00:00Z");
    const list = [
      comment("old", "x", { createdAt: T("2026-10-05T09:00:00.000Z") }),
      comment("new", "x"),
      comment("mine", "x", { isOwn: true }),
      comment("spam", "x"),
    ];
    const res = newSinceWatermark(list, wm, new Set(["spam"]));
    expect(res.fresh.map((c) => c.id)).toEqual(["new"]);
    expect(res.nextWatermark).toBe(Date.parse("2026-10-05T11:00:00Z"));
  });

  it("alert copy names the commenter and summarises the rest", () => {
    const one = alertCopy([{ comment: comment("a", "Love it"), channelName: "Bollywood Daily", platform: "INSTAGRAM" }], 1, 0);
    expect(one).toEqual({ title: "New comment on Bollywood Daily", body: "@asha_a: “Love it”" });
    const many = alertCopy(
      [
        { comment: comment("a", "Love it"), channelName: "P", platform: "FACEBOOK" },
        { comment: comment("b", "x"), channelName: "P", platform: "FACEBOOK" },
      ],
      2,
      3
    );
    expect(many.title).toBe("2 new comments");
    expect(many.body).toBe("Asha: “Love it” and 1 more across 2 posts. 3 comments were hidden by your rules.");
  });
});

// ── runCommentSweep with a fake database ────────────────────────────────────

function fakePrisma(opts: { automation: any; targets: any[]; channels: any[]; existingActions?: string[] }) {
  const calls = { executeRaw: [] as any[], actions: [] as any[], notifications: [] as any[], automationUpdates: [] as any[] };
  const prisma = {
    commentAutomation: {
      findMany: vi.fn(async () => [opts.automation]),
      update: vi.fn(async (a: any) => calls.automationUpdates.push(a)),
    },
    postTarget: { findMany: vi.fn(async (_a: any) => opts.targets) },
    channel: { findMany: vi.fn(async (_a: any) => opts.channels) },
    commentAutoAction: {
      findMany: vi.fn(async (a: any) =>
        (opts.existingActions ?? []).filter((id) => a.where.commentId.in.includes(id)).map((commentId) => ({ commentId }))
      ),
      create: vi.fn(async (a: any) => calls.actions.push(a.data)),
    },
    organizationMember: { findMany: vi.fn(async () => [{ userId: "owner-1" }, { userId: "admin-1" }]) },
    notification: { create: vi.fn(async (a: any) => calls.notifications.push(a.data)) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => calls.executeRaw.push({ sql: strings.join("?"), values })),
  };
  return { prisma, calls };
}

const IG = {
  id: "ch-ig", organizationId: "org-1", platform: "INSTAGRAM", platformId: "IG_USER", name: "Bollywood Daily",
  username: "bollywooddaily", accessToken: "DECRYPTED", refreshToken: null,
  metadata: { igUserId: "IG_USER", grantedScopes: ["instagram_basic", "instagram_manage_comments"] },
};
const FB = { ...IG, id: "ch-fb", platform: "FACEBOOK", platformId: "PAGE_1", name: "Contents", metadata: { pageId: "PAGE_1" } };

const target = (id: string, channelId: string, sweep?: any) => ({
  id, channelId, publishedId: `OBJ_${id}`, publishedAt: new Date("2026-10-05T08:00:00Z"),
  metadata: sweep ? { resolvedPostId: "keep", commentSweep: sweep } : null,
});

function deps(prisma: any, pages: Record<string, any[]>, over: Partial<Parameters<typeof runCommentSweep>[0]> = {}) {
  const hideComment = vi.fn(async (..._a: any[]) => {});
  const readComments = vi.fn(async (_p: any, _t: any, objectId: string) => ({ comments: pages[objectId] ?? [], nextCursor: null, totalCount: null }));
  return {
    d: { prisma, readComments, hideComment, facebookUsagePeak: () => 0, now: () => NOW, log: { log: vi.fn(), warn: vi.fn() }, ...over },
    hideComment,
    readComments,
  };
}

describe("runCommentSweep", () => {
  const automation = {
    id: "auto-1", organizationId: "org-1", autoHideEnabled: true, alertsEnabled: true,
    blockedWords: ["scam"], hideLinks: true, channelIds: [],
  };

  it("does nothing when no workspace switched anything on", async () => {
    const prisma = { commentAutomation: { findMany: vi.fn(async () => []) } };
    const { d } = deps(prisma, {});
    expect(await runCommentSweep(d as any, CFG)).toEqual({});
  });

  it("scopes the post query to the workspace's live FB/IG channels, published non-story posts in the window", async () => {
    const { prisma } = fakePrisma({ automation: { ...automation, channelIds: ["ch-ig"] }, targets: [], channels: [] });
    const { d } = deps(prisma, {});
    await runCommentSweep(d as any, CFG);
    const where = prisma.postTarget.findMany.mock.calls[0]![0].where;
    expect(where.post).toEqual({ organizationId: "org-1" });
    expect(where.OR).toEqual([{ format: null }, { format: { not: "STORY" } }]);
    expect(where.channel).toEqual({
      organizationId: "org-1", disconnectedAt: null, isActive: true,
      platform: { in: ["FACEBOOK", "INSTAGRAM"] }, id: { in: ["ch-ig"] },
    });
    expect(where.publishedAt.gte.toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });

  it("hides matching comments once, logs them, and skips comments already acted on (manual unhide sticks)", async () => {
    const { prisma, calls } = fakePrisma({
      automation,
      targets: [target("t1", "ch-ig", { checkedAt: 1, lastSeenAt: Date.parse("2026-10-05T10:00:00Z") })],
      channels: [IG],
      existingActions: ["c-unhidden-before"],
    });
    const { d, hideComment } = deps(prisma, {
      OBJ_t1: [
        comment("c-scam", "total SCAM"),
        comment("c-link", "free followers at bit.ly/x"),
        comment("c-ok", "Love this"),
        comment("c-unhidden-before", "scam again"),
        comment("c-own", "scam", { isOwn: true }),
      ],
    });
    const res = await runCommentSweep(d as any, CFG);
    expect(hideComment.mock.calls.map((c) => c[2])).toEqual(["c-scam", "c-link"]);
    expect(hideComment.mock.calls[0]![1]).toMatchObject({ accessToken: "DECRYPTED" });
    expect(calls.actions.map((a) => [a.commentId, a.reason, a.status])).toEqual([
      ["c-scam", "word:scam", "HIDDEN"],
      ["c-link", "link", "HIDDEN"],
    ]);
    expect(res["org-1"]).toMatchObject({ postsChecked: 1, hidden: 2, newComments: 2 });
    // Alert: only the visible new ones (c-ok, c-unhidden-before), not the two just hidden.
    expect(calls.notifications).toHaveLength(2);
    expect(calls.notifications[0]).toMatchObject({ userId: "owner-1", type: "comment.new", link: "/dashboard/comments?view=unanswered" });
    expect(calls.notifications[0].body).toContain("2 comments were hidden by your rules");
  });

  it("does not try to hide when the channel's recorded grant lacks the write permission — it reports it instead", async () => {
    const noWrite = { ...FB, metadata: { pageId: "PAGE_1", grantedScopes: ["pages_read_engagement", "pages_read_user_content"] } };
    const { prisma } = fakePrisma({ automation, targets: [target("t1", "ch-fb")], channels: [noWrite] });
    const { d, hideComment } = deps(prisma, { OBJ_t1: [comment("c", "scam")] });
    const res = await runCommentSweep(d as any, CFG);
    expect(hideComment).not.toHaveBeenCalled();
    expect(res["org-1"]!.hidePermissionMissing).toEqual(["Contents"]);
  });

  it("first look at a post sets the watermark (atomic jsonb merge) and sends no alert", async () => {
    const { prisma, calls } = fakePrisma({ automation: { ...automation, autoHideEnabled: false }, targets: [target("t1", "ch-ig")], channels: [IG] });
    const { d } = deps(prisma, { OBJ_t1: [comment("a", "hello")] });
    await runCommentSweep(d as any, CFG);
    expect(calls.notifications).toHaveLength(0);
    expect(calls.executeRaw).toHaveLength(1);
    expect(calls.executeRaw[0].sql).toMatch(/COALESCE\("metadata", '\{\}'::jsonb\) \|\| \?::jsonb/);
    expect(JSON.parse(calls.executeRaw[0].values[0])).toEqual({
      commentSweep: { checkedAt: NOW.getTime(), lastSeenAt: Date.parse("2026-10-05T11:00:00Z") },
    });
  });

  it("stops reading Facebook once Meta's app usage reaches the ceiling, keeps Instagram going", async () => {
    const { prisma } = fakePrisma({
      automation,
      targets: [target("f1", "ch-fb"), target("i1", "ch-ig")],
      channels: [{ ...FB, metadata: { pageId: "PAGE_1" } }, IG],
    });
    const { d, readComments } = deps(prisma, {}, { facebookUsagePeak: () => 80 });
    const res = await runCommentSweep(d as any, CFG);
    expect(readComments.mock.calls.map((c) => c[0])).toEqual(["INSTAGRAM"]);
    expect(res["org-1"]!.skippedForQuota).toBe(1);
  });

  it("a read failure is counted, the post still rotates, and the run continues", async () => {
    const { prisma, calls } = fakePrisma({ automation, targets: [target("t1", "ch-ig"), target("t2", "ch-ig")], channels: [IG] });
    const { d, readComments } = deps(prisma, { OBJ_t2: [] });
    readComments.mockRejectedValueOnce(new Error("This post is no longer available on Instagram"));
    const res = await runCommentSweep(d as any, CFG);
    expect(res["org-1"]).toMatchObject({ postsChecked: 2, errors: 1 });
    expect(calls.executeRaw).toHaveLength(2);
    expect(calls.automationUpdates[0]).toMatchObject({ where: { id: "auto-1" }, data: { lastRunAt: NOW } });
  });

  it("caps hides per workspace per run", async () => {
    const { prisma } = fakePrisma({ automation, targets: [target("t1", "ch-ig")], channels: [IG] });
    const many = Array.from({ length: 10 }, (_, i) => comment(`s${i}`, "scam"));
    const { d, hideComment } = deps(prisma, { OBJ_t1: many });
    await runCommentSweep(d as any, { ...CFG, maxHidesPerOrg: 3 });
    expect(hideComment).toHaveBeenCalledTimes(3);
  });

  it("never reads a channel belonging to another workspace", async () => {
    const { prisma } = fakePrisma({ automation, targets: [target("t1", "ch-ig")], channels: [{ ...IG, organizationId: "org-2" }] });
    const { d, readComments } = deps(prisma, {});
    await runCommentSweep(d as any, CFG);
    expect(readComments).not.toHaveBeenCalled();
  });
});
