import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __resetExternalSweepState,
  classifyTwitterRead,
  readTwitterSentimentConfig,
  runCommentSweep,
  type SweepConfig,
} from "./comment-sweep";
import { twitterSentimentCandidates } from "./comment-sentiment";

/**
 * X reply sentiment (2026-10-06): the comment sweep reads replies to tweets
 * the app published via recent search (`conversation_id:`), paying per post
 * read — so it only asks for replies newer than the last one seen and budgets
 * in posts returned. Shapes follow X API v2 recent search.
 */

const CFG: SweepConfig = { maxPostsPerRun: 40, maxPostsPerOrg: 15, lookbackDays: 3, fbUsageCeiling: 75, maxHidesPerOrg: 50 };
const X_CFG = { dailyUnits: 100, maxPostsPerRun: 10, minIntervalMs: 180 * 60 * 1000, lookbackDays: 6 };
const NOW = new Date("2026-10-06T12:00:00Z");
const OWN = "1500000000000000001"; // our account's user id
const ROOT = "1840000000000000001"; // our tweet

const tweet = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  id,
  text,
  author_id: "999",
  conversation_id: ROOT,
  created_at: "2026-10-06T10:00:00.000Z",
  referenced_tweets: [{ type: "replied_to", id: ROOT }],
  ...over,
});
const page = (data: any[], newest?: string) => ({
  data,
  meta: { result_count: data.length, ...(data.length ? { newest_id: newest ?? data[0].id, oldest_id: data[data.length - 1].id } : {}) },
});

describe("twitterSentimentCandidates", () => {
  it("strips the leading @handles, skips our own replies and handle-only ones, flags replies to replies", () => {
    const out = twitterSentimentCandidates(
      page([
        tweet("1840000000000000010", "@acme @sam This is brilliant &amp; overdue"),
        tweet("1840000000000000011", "@acme thanks for the kind words!", { author_id: OWN }),
        tweet("1840000000000000012", "@acme @sam"),
        tweet("1840000000000000013", "@sam totally agree", { referenced_tweets: [{ type: "replied_to", id: "1840000000000000010" }] }),
        tweet(ROOT, "our own tweet in its conversation"),
        tweet("1840000000000000014", "no date", { created_at: undefined, referenced_tweets: undefined }),
      ]),
      OWN,
      ROOT
    );
    expect(out).toEqual([
      { commentId: "1840000000000000010", commentText: "This is brilliant & overdue", authorLabel: "X user", isReply: false, commentedAt: new Date("2026-10-06T10:00:00Z") },
      { commentId: "1840000000000000013", commentText: "totally agree", authorLabel: "X user", isReply: true, commentedAt: new Date("2026-10-06T10:00:00Z") },
      { commentId: "1840000000000000014", commentText: "no date", authorLabel: "X user", isReply: false, commentedAt: null },
    ]);
    expect(twitterSentimentCandidates({ meta: { result_count: 0 } }, OWN, ROOT)).toEqual([]);
    expect(twitterSentimentCandidates(null, OWN, ROOT)).toEqual([]);
  });
});

describe("X helpers", () => {
  it("classifies: spent credits / usage cap / an app without access stop X for the day", () => {
    expect(classifyTwitterRead({ status: 402, body: { title: "CreditsDepleted" } })).toMatchObject({ kind: "quotaExhausted" });
    expect(classifyTwitterRead({ status: 429, body: { title: "UsageCapExceeded", detail: "Usage cap exceeded: Monthly product cap" } })).toMatchObject({ kind: "quotaExhausted" });
    expect(classifyTwitterRead({ status: 403, body: { reason: "client-not-enrolled", type: "https://api.twitter.com/2/problems/client-forbidden" } })).toMatchObject({ kind: "quotaExhausted" });
    expect(classifyTwitterRead({ status: 429, body: { title: "Too Many Requests" } })).toEqual({ kind: "rateLimited" });
    expect(classifyTwitterRead({ status: 401, body: null })).toEqual({ kind: "tokenRefused" });
    expect(classifyTwitterRead({ status: 403, body: { title: "Forbidden" } })).toEqual({ kind: "scopeMissing" });
    expect(classifyTwitterRead({ status: 200, body: page([]) })).toEqual({ kind: "ok", found: [] });
    expect(classifyTwitterRead({ status: 400, body: { title: "Invalid Request" } })).toEqual({ kind: "failed", detail: 'HTTP 400 "Invalid Request"' });
  });

  it("config: cheap defaults; look-back can't pass recent search's 7 days; empty env = default", () => {
    expect(readTwitterSentimentConfig({})).toEqual(X_CFG);
    expect(readTwitterSentimentConfig({ COMMENT_SENTIMENT_X_DAILY_READS: "" }).dailyUnits).toBe(100);
    expect(readTwitterSentimentConfig({ COMMENT_SENTIMENT_X_DAILY_READS: "0" }).dailyUnits).toBe(0);
    expect(readTwitterSentimentConfig({ COMMENT_SENTIMENT_X_LOOKBACK_DAYS: "30" }).lookbackDays).toBe(7);
  });
});

// ── the X pass of runCommentSweep ───────────────────────────────────────────

const X_CH = {
  id: "ch-x", organizationId: "org-1", platform: "TWITTER", platformId: OWN, name: "Acme on X",
  accessToken: "OAUTH_TOKEN", refreshToken: "OAUTH_SECRET", tokenExpiresAt: null, metadata: null,
};
const xTarget = (id: string, publishedId: string, sweep?: Record<string, unknown>) => ({
  id, channelId: "ch-x", publishedId, publishedAt: new Date("2026-10-05T08:00:00Z"),
  metadata: sweep ? { commentSweep: sweep } : null,
});

function setup(opts: { xTargets?: any[]; channels?: any[]; sentimentEnabled?: boolean } = {}) {
  const created: any[] = [];
  const executeRaw: any[] = [];
  const automation = {
    id: "auto", organizationId: "org-1", autoHideEnabled: false, alertsEnabled: true, sentimentEnabled: opts.sentimentEnabled ?? true,
    blockedWords: [], hideLinks: false, channelIds: [],
  };
  const prisma = {
    commentAutomation: { findMany: vi.fn(async () => [automation]), update: vi.fn(async () => ({})) },
    postTarget: { findMany: vi.fn(async (a: any) => (a.where.channel.platform === "TWITTER" ? (opts.xTargets ?? []) : [])) },
    channel: { findMany: vi.fn(async () => opts.channels ?? [X_CH]) },
    commentAutoAction: { findMany: vi.fn(async () => []), create: vi.fn() },
    commentSentiment: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async (a: any) => created.push(...a.data)),
      update: vi.fn(),
      count: vi.fn(async () => 0),
    },
    notification: { findFirst: vi.fn(async () => null), create: vi.fn() },
    organizationMember: { findMany: vi.fn(async () => [{ userId: "owner" }]) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => executeRaw.push({ sql: strings.join("?"), values })),
  };
  const responses: Record<string, { status: number; body: unknown }> = {};
  const readTwitterReplies = vi.fn(async (_tokens: any, tweetId: string, _opts: any) => responses[tweetId] ?? { status: 200, body: page([]) });
  let balance = 0;
  const reserveTwitterReads = vi.fn(async (n: number) => {
    balance += n;
    return true;
  });
  const refundTwitterReads = vi.fn(async (n: number) => {
    balance -= n;
  });
  const deps = {
    prisma, readComments: vi.fn(), hideComment: vi.fn(), facebookUsagePeak: () => 0, now: () => NOW,
    log: { log: vi.fn(), warn: vi.fn() },
    readTwitterReplies, reserveTwitterReads, refundTwitterReads, twitterConfig: X_CFG,
  };
  const stampOf = (targetId: string) => {
    const row = executeRaw.find((e) => e.values.includes(targetId));
    return row ? JSON.parse(row.values[0]) : null;
  };
  return { prisma, deps, responses, created, executeRaw, readTwitterReplies, reserveTwitterReads, refundTwitterReads, stampOf, spent: () => balance };
}

describe("runCommentSweep — X reply sentiment", () => {
  beforeEach(() => __resetExternalSweepState());

  it("queries the workspace's X channels over a 6-day window", async () => {
    const { prisma, deps } = setup();
    await runCommentSweep(deps as any, CFG);
    const call = prisma.postTarget.findMany.mock.calls.find((c: any) => c[0].where.channel.platform === "TWITTER")![0] as any;
    expect(call.where.channel).toEqual({ organizationId: "org-1", disconnectedAt: null, isActive: true, platform: "TWITTER" });
    expect(call.where.publishedAt.gte.toISOString()).toBe("2026-09-30T12:00:00.000Z");
  });

  it("first read: signs as the channel, stores replies as TWITTER, keeps newest_id as the cursor, spends what was returned", async () => {
    const t = setup({ xTargets: [xTarget("t1", ROOT)] });
    t.responses[ROOT] = { status: 200, body: page([tweet("1840000000000000020", "@acme love it"), tweet("1840000000000000019", "@acme meh, too pricey")]) };
    const res = await runCommentSweep(t.deps as any, CFG);
    expect(t.readTwitterReplies).toHaveBeenCalledWith({ accessToken: "OAUTH_TOKEN", tokenSecret: "OAUTH_SECRET" }, ROOT, { sinceId: null, maxResults: 25 });
    expect(t.created.map((c) => [c.platform, c.commentId, c.commentText])).toEqual([
      ["TWITTER", "1840000000000000020", "love it"],
      ["TWITTER", "1840000000000000019", "meh, too pricey"],
    ]);
    expect(t.stampOf("t1")).toEqual({ commentSweep: { checkedAt: NOW.getTime(), cursor: "1840000000000000020" } });
    expect(t.spent()).toBe(2);
    expect(res["org-1"]).toMatchObject({ twitterPostsChecked: 1, sentimentStored: 2, errors: 0 });
  });

  it("later reads ask only for newer replies; an empty poll still costs 1 and keeps the cursor", async () => {
    const t = setup({ xTargets: [xTarget("t1", ROOT, { checkedAt: NOW.getTime() - 4 * 3600_000, cursor: "1840000000000000020" })] });
    await runCommentSweep(t.deps as any, CFG);
    expect(t.readTwitterReplies.mock.calls[0]![2]).toEqual({ sinceId: "1840000000000000020", maxResults: 25 });
    expect(t.spent()).toBe(1);
    expect(t.stampOf("t1")).toEqual({ commentSweep: { checkedAt: NOW.getTime(), cursor: "1840000000000000020" } });
  });

  it("a failed read keeps the cursor (never starts over and pays again)", async () => {
    const t = setup({ xTargets: [xTarget("t1", ROOT, { checkedAt: NOW.getTime() - 4 * 3600_000, cursor: "1840000000000000020" })] });
    t.responses[ROOT] = { status: 503, body: { title: "Service Unavailable" } };
    const res = await runCommentSweep(t.deps as any, CFG);
    expect(res["org-1"]).toMatchObject({ errors: 1 });
    expect(t.stampOf("t1")).toEqual({ commentSweep: { checkedAt: NOW.getTime(), cursor: "1840000000000000020" } });
    expect(t.spent()).toBe(1);
  });

  it("re-reads a post only every 3 hours; skips non-tweet ids", async () => {
    const t = setup({
      xTargets: [
        xTarget("fresh", "1840000000000000101", { checkedAt: NOW.getTime() - 60 * 60 * 1000 }),
        xTarget("bad", "not-a-tweet"),
        xTarget("due", "1840000000000000102", { checkedAt: NOW.getTime() - 4 * 3600_000 }),
      ],
    });
    await runCommentSweep(t.deps as any, CFG);
    expect(t.readTwitterReplies.mock.calls.map((c) => c[1])).toEqual(["1840000000000000102"]);
  });

  it("stops when the daily read cap says no; out of credits stops X until the UTC day turns", async () => {
    const a = setup({ xTargets: [xTarget("t1", ROOT), xTarget("t2", "1840000000000000002")] });
    a.reserveTwitterReads.mockResolvedValueOnce(false);
    await runCommentSweep(a.deps as any, CFG);
    expect(a.readTwitterReplies).not.toHaveBeenCalled();
    expect(a.refundTwitterReads).not.toHaveBeenCalled();

    const b = setup({ xTargets: [xTarget("t1", ROOT), xTarget("t2", "1840000000000000002")] });
    b.responses[ROOT] = { status: 402, body: { title: "CreditsDepleted" } };
    await runCommentSweep(b.deps as any, CFG);
    expect(b.readTwitterReplies).toHaveBeenCalledTimes(1);
    expect(b.executeRaw).toEqual([]);
    await runCommentSweep(b.deps as any, CFG);
    expect(b.readTwitterReplies).toHaveBeenCalledTimes(1);
    await runCommentSweep({ ...b.deps, now: () => new Date("2026-10-07T00:10:00Z") } as any, CFG);
    expect(b.readTwitterReplies).toHaveBeenCalledTimes(2);
  });

  it("nothing on X without sentiment on, or when the cap is 0; never another workspace's channel", async () => {
    const off = setup({ xTargets: [xTarget("t1", ROOT)], sentimentEnabled: false });
    await runCommentSweep(off.deps as any, CFG);
    expect(off.readTwitterReplies).not.toHaveBeenCalled();

    const zero = setup({ xTargets: [xTarget("t1", ROOT)] });
    await runCommentSweep({ ...zero.deps, twitterConfig: { ...X_CFG, dailyUnits: 0 } } as any, CFG);
    expect(zero.readTwitterReplies).not.toHaveBeenCalled();

    const foreign = setup({ xTargets: [xTarget("t1", ROOT)], channels: [{ ...X_CH, organizationId: "org-2" }] });
    await runCommentSweep(foreign.deps as any, CFG);
    expect(foreign.readTwitterReplies).not.toHaveBeenCalled();
  });
});
