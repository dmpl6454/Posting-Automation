import { describe, it, expect, vi, beforeEach } from "vitest";
import { __resetExternalSweepState, readYouTubeSentimentConfig, runCommentSweep, type SweepConfig } from "./comment-sweep";
import { youtubeSentimentCandidates } from "./comment-sentiment";

/**
 * YouTube comment sentiment (2026-10-06): the comment sweep reads comment
 * threads on the workspace's own app-published YouTube videos — sentiment
 * only, under its own daily YouTube unit cap.
 */

const CFG: SweepConfig = { maxPostsPerRun: 40, maxPostsPerOrg: 15, lookbackDays: 3, fbUsageCeiling: 75, maxHidesPerOrg: 50 };
const YT_CFG = { dailyUnits: 300, maxPostsPerRun: 20, minIntervalMs: 60 * 60 * 1000, lookbackDays: 7 };
const NOW = new Date("2026-10-06T12:00:00Z");

const thread = (id: string, text: string, over: Record<string, unknown> = {}, replies: any[] = []) => ({
  id,
  snippet: {
    totalReplyCount: replies.length,
    topLevelComment: {
      id,
      snippet: { textOriginal: text, authorDisplayName: "@fan_" + id, authorChannelId: { value: "UC_FAN" }, publishedAt: "2026-10-06T10:00:00Z", ...over },
    },
  },
  ...(replies.length ? { replies: { comments: replies } } : {}),
});
const reply = (id: string, text: string, author = "UC_FAN") => ({
  id,
  snippet: { textOriginal: text, authorDisplayName: "@r", authorChannelId: { value: author }, publishedAt: "2026-10-06T11:00:00Z" },
});

describe("youtubeSentimentCandidates", () => {
  it("top-level comments and embedded replies, minus our channel's own and empty ones", () => {
    const body = {
      items: [
        thread("C1", "Loved this &amp; more", {}, [reply("C1.R1", "same here"), reply("C1.R2", "Thanks!", "UC_OURS")]),
        thread("C2", "our pinned note", { authorChannelId: { value: "UC_OURS" } }),
        thread("C3", "   "),
        thread("C4", "meh", { authorDisplayName: "", publishedAt: "not a date" }),
      ],
    };
    const out = youtubeSentimentCandidates(body, "UC_OURS");
    expect(out).toEqual([
      { commentId: "C1", commentText: "Loved this & more", authorLabel: "@fan_C1", isReply: false, commentedAt: new Date("2026-10-06T10:00:00Z") },
      { commentId: "C1.R1", commentText: "same here", authorLabel: "@r", isReply: true, commentedAt: new Date("2026-10-06T11:00:00Z") },
      { commentId: "C4", commentText: "meh", authorLabel: "YouTube user", isReply: false, commentedAt: null },
    ]);
  });

  it("falls back to textDisplay, caps length, and tolerates garbage", () => {
    const body = { items: [thread("C1", "", { textDisplay: "x".repeat(1500) })] };
    expect(youtubeSentimentCandidates(body, null)[0]!.commentText).toHaveLength(1000);
    expect(youtubeSentimentCandidates(null, "UC")).toEqual([]);
    expect(youtubeSentimentCandidates({ error: { code: 403 } }, "UC")).toEqual([]);
  });
});

describe("readYouTubeSentimentConfig", () => {
  it("defaults, clamps, and treats compose's empty string as unset", () => {
    expect(readYouTubeSentimentConfig({})).toEqual(YT_CFG);
    expect(readYouTubeSentimentConfig({ COMMENT_SENTIMENT_YT_DAILY_UNITS: "" }).dailyUnits).toBe(300);
    expect(readYouTubeSentimentConfig({ COMMENT_SENTIMENT_YT_DAILY_UNITS: "0" }).dailyUnits).toBe(0);
    expect(readYouTubeSentimentConfig({ COMMENT_SENTIMENT_YT_INTERVAL_MIN: "1" }).minIntervalMs).toBe(15 * 60 * 1000);
    expect(readYouTubeSentimentConfig({ COMMENT_SENTIMENT_YT_LOOKBACK_DAYS: "99" }).lookbackDays).toBe(30);
  });
});

// ── the YouTube pass of runCommentSweep ─────────────────────────────────────

const YT = {
  id: "ch-yt", organizationId: "org-1", platform: "YOUTUBE", platformId: "UC_OURS", name: "Our Channel",
  accessToken: "DECRYPTED_YT", refreshToken: "r", tokenExpiresAt: new Date("2026-10-06T12:40:00Z"), metadata: null,
};
const ytTarget = (id: string, publishedId: string, checkedAt?: number) => ({
  id, channelId: "ch-yt", publishedId, publishedAt: new Date("2026-10-05T08:00:00Z"),
  metadata: checkedAt !== undefined ? { commentSweep: { checkedAt } } : null,
});

function setup(opts: { automation?: Record<string, unknown>; ytTargets?: any[]; channels?: any[]; existing?: string[] } = {}) {
  const created: any[] = [];
  const executeRaw: any[] = [];
  const notifications: any[] = [];
  const automation = {
    id: "auto", organizationId: "org-1", autoHideEnabled: true, alertsEnabled: true, sentimentEnabled: true,
    blockedWords: ["scam"], hideLinks: true, channelIds: [], ...opts.automation,
  };
  const prisma = {
    commentAutomation: { findMany: vi.fn(async () => [automation]), update: vi.fn(async () => ({})) },
    postTarget: {
      findMany: vi.fn(async (a: any) => (a.where.channel.platform === "YOUTUBE" ? (opts.ytTargets ?? []) : [])),
    },
    channel: { findMany: vi.fn(async () => opts.channels ?? [YT]) },
    commentAutoAction: { findMany: vi.fn(async () => []), create: vi.fn() },
    commentSentiment: {
      findMany: vi.fn(async (a: any) =>
        a.where.commentId ? (opts.existing ?? []).filter((id) => a.where.commentId.in.includes(id)).map((commentId) => ({ commentId })) : []
      ),
      createMany: vi.fn(async (a: any) => created.push(...a.data)),
      update: vi.fn(),
      count: vi.fn(async () => 0),
    },
    notification: { findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => notifications.push(a.data)) },
    organizationMember: { findMany: vi.fn(async () => [{ userId: "owner" }]) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => executeRaw.push({ sql: strings.join("?"), values })),
  };
  const responses: Record<string, { status: number; body: unknown }> = {};
  const readYouTubeComments = vi.fn(async (_token: string, videoId: string) => responses[videoId] ?? { status: 200, body: { items: [] } });
  const reserveYouTubeUnits = vi.fn(async (_units: number) => true);
  const hideComment = vi.fn(async () => {});
  const readComments = vi.fn(async () => ({ comments: [], nextCursor: null, totalCount: null }));
  const deps = {
    prisma, readComments, hideComment, facebookUsagePeak: () => 0, now: () => NOW,
    log: { log: vi.fn(), warn: vi.fn() },
    readYouTubeComments, reserveYouTubeUnits, youtubeConfig: YT_CFG,
  };
  return { prisma, deps, responses, created, executeRaw, notifications, readYouTubeComments, reserveYouTubeUnits, hideComment };
}

const VID_A = "dQw4w9WgXcQ";
const VID_B = "9bZkp7q19f0";

describe("runCommentSweep — YouTube comment sentiment", () => {
  beforeEach(() => __resetExternalSweepState());

  it("queries only the workspace's live YouTube channels in scope, over the YouTube look-back", async () => {
    const { prisma, deps } = setup({ automation: { channelIds: ["ch-yt", "ch-ig"] } });
    await runCommentSweep(deps as any, CFG);
    const ytCall = prisma.postTarget.findMany.mock.calls.find((c: any) => c[0].where.channel.platform === "YOUTUBE")![0] as any;
    expect(ytCall.where.channel).toEqual({
      organizationId: "org-1", disconnectedAt: null, isActive: true, platform: "YOUTUBE", id: { in: ["ch-yt", "ch-ig"] },
    });
    expect(ytCall.where.post).toEqual({ organizationId: "org-1" });
    expect(ytCall.where.publishedAt.gte.toISOString()).toBe("2026-09-29T12:00:00.000Z");
  });

  it("reads with the channel's token, stores new comments as YOUTUBE, stamps the video — and never hides or alerts", async () => {
    const { deps, responses, created, executeRaw, notifications, readYouTubeComments, hideComment } = setup({
      ytTargets: [ytTarget("t1", VID_A)],
      existing: ["OLD"],
    });
    responses[VID_A] = {
      status: 200,
      body: { items: [thread("OLD", "seen"), thread("NEW", "this is a scam!"), thread("MINE", "thanks all", { authorChannelId: { value: "UC_OURS" } })] },
    };
    const res = await runCommentSweep(deps as any, CFG);
    expect(readYouTubeComments).toHaveBeenCalledWith("DECRYPTED_YT", VID_A);
    expect(created).toEqual([
      expect.objectContaining({ organizationId: "org-1", postTargetId: "t1", channelId: "ch-yt", platform: "YOUTUBE", commentId: "NEW", commentText: "this is a scam!" }),
    ]);
    expect(hideComment).not.toHaveBeenCalled();
    expect(notifications.filter((n) => n.type === "comment.new")).toEqual([]);
    expect(res["org-1"]).toMatchObject({ youtubeVideosChecked: 1, sentimentStored: 1, errors: 0 });
    const stamp = executeRaw.find((e) => e.values.includes("t1"));
    expect(stamp.sql).toContain(`COALESCE("metadata", '{}'::jsonb) ||`);
    expect(JSON.parse(stamp.values[0])).toEqual({ commentSweep: { checkedAt: NOW.getTime() } });
  });

  it("skips non-video ids and videos read within the interval; reads never-checked first", async () => {
    const { deps, readYouTubeComments } = setup({
      ytTargets: [
        ytTarget("community", "UgkxCommunityPostId123"),
        ytTarget("fresh", VID_A, NOW.getTime() - 10 * 60 * 1000),
        ytTarget("due", VID_B, NOW.getTime() - 2 * 60 * 60 * 1000),
        ytTarget("never", "aaaaaaaaaaa"),
      ],
    });
    await runCommentSweep(deps as any, CFG);
    expect(readYouTubeComments.mock.calls.map((c) => c[1])).toEqual(["aaaaaaaaaaa", VID_B]);
  });

  it("spends one unit per video and stops when the daily cap (or its counter) says no", async () => {
    const { deps, readYouTubeComments, reserveYouTubeUnits } = setup({ ytTargets: [ytTarget("t1", VID_A), ytTarget("t2", VID_B)] });
    reserveYouTubeUnits.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await runCommentSweep(deps as any, CFG);
    expect(reserveYouTubeUnits.mock.calls.map((c) => c[0])).toEqual([1, 1]);
    expect(readYouTubeComments).toHaveBeenCalledTimes(1);
  });

  it("Google's quotaExceeded stops YouTube for the rest of the Pacific day", async () => {
    const { deps, responses, readYouTubeComments, executeRaw } = setup({ ytTargets: [ytTarget("t1", VID_A), ytTarget("t2", VID_B)] });
    responses[VID_A] = { status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } };
    await runCommentSweep(deps as any, CFG);
    expect(readYouTubeComments).toHaveBeenCalledTimes(1);
    expect(executeRaw).toEqual([]);
    await runCommentSweep(deps as any, CFG);
    expect(readYouTubeComments).toHaveBeenCalledTimes(1);
  });

  it("a refused token skips that channel's other videos, unstamped; an expired one is never called", async () => {
    const a = setup({ ytTargets: [ytTarget("t1", VID_A), ytTarget("t2", VID_B)] });
    a.responses[VID_A] = { status: 401, body: { error: { code: 401 } } };
    const res = await runCommentSweep(a.deps as any, CFG);
    expect(a.readYouTubeComments).toHaveBeenCalledTimes(1);
    expect(a.executeRaw).toEqual([]);
    expect(res["org-1"]).toMatchObject({ errors: 1 });

    const b = setup({ ytTargets: [ytTarget("t1", VID_A)], channels: [{ ...YT, tokenExpiresAt: new Date("2026-10-06T11:00:00Z") }] });
    await runCommentSweep(b.deps as any, CFG);
    expect(b.readYouTubeComments).not.toHaveBeenCalled();
    expect(b.reserveYouTubeUnits).not.toHaveBeenCalled();
  });

  it("a token without a YouTube read scope pauses that channel for a day instead of spending a unit every run", async () => {
    const { deps, responses, readYouTubeComments, executeRaw } = setup({
      ytTargets: [ytTarget("t1", VID_A), ytTarget("t2", VID_B)],
      channels: [{ ...YT, tokenExpiresAt: null }],
    });
    responses[VID_A] = { status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } };
    const res = await runCommentSweep(deps as any, CFG);
    expect(readYouTubeComments).toHaveBeenCalledTimes(1);
    expect(res["org-1"]).toMatchObject({ errors: 1 });
    expect(executeRaw).toEqual([]);
    await runCommentSweep(deps as any, CFG);
    await runCommentSweep({ ...deps, now: () => new Date(NOW.getTime() + 2 * 60 * 60 * 1000) } as any, CFG);
    expect(readYouTubeComments).toHaveBeenCalledTimes(1);
    // A day later it is tried again — one call, parked again while the scope is still missing.
    await runCommentSweep({ ...deps, now: () => new Date(NOW.getTime() + 25 * 60 * 60 * 1000) } as any, CFG);
    expect(readYouTubeComments).toHaveBeenCalledTimes(2);
  });

  it("comments switched off on a video is the video's state, not an error — it still rotates", async () => {
    const { deps, responses, executeRaw } = setup({ ytTargets: [ytTarget("t1", VID_A)] });
    responses[VID_A] = { status: 403, body: { error: { errors: [{ reason: "commentsDisabled" }] } } };
    const res = await runCommentSweep(deps as any, CFG);
    expect(res["org-1"]).toMatchObject({ errors: 0, youtubeVideosChecked: 1 });
    expect(executeRaw).toHaveLength(1);
  });

  it("does nothing on YouTube for a workspace without sentiment, or when the cap is 0", async () => {
    const off = setup({ automation: { sentimentEnabled: false }, ytTargets: [ytTarget("t1", VID_A)] });
    await runCommentSweep(off.deps as any, CFG);
    expect(off.readYouTubeComments).not.toHaveBeenCalled();
    expect(off.prisma.postTarget.findMany.mock.calls.some((c: any) => c[0].where.channel.platform === "YOUTUBE")).toBe(false);

    const zero = setup({ ytTargets: [ytTarget("t1", VID_A)] });
    await runCommentSweep({ ...zero.deps, youtubeConfig: { ...YT_CFG, dailyUnits: 0 } } as any, CFG);
    expect(zero.readYouTubeComments).not.toHaveBeenCalled();
  });

  it("never reads a channel belonging to another workspace", async () => {
    const { deps, readYouTubeComments } = setup({ ytTargets: [ytTarget("t1", VID_A)], channels: [{ ...YT, organizationId: "org-2" }] });
    await runCommentSweep(deps as any, CFG);
    expect(readYouTubeComments).not.toHaveBeenCalled();
  });
});
