import { describe, it, expect, vi } from "vitest";
import {
  chunk,
  negativeAlertCopy,
  planScoring,
  readCommentSentimentConfig,
  scorePendingCommentSentiment,
  sentimentCandidates,
  shouldAlertNegative,
  type CommentSentimentConfig,
} from "./comment-sentiment";
import { runCommentSweep, type SweepConfig } from "./comment-sweep";

const NOW = new Date("2026-10-05T12:00:00Z");
const CFG: CommentSentimentConfig = {
  maxScorePerRun: 200,
  maxAttempts: 3,
  negativeAlertMin: 5,
  negativeAlertShare: 0.4,
  negativeAlertCooldownMs: 6 * 60 * 60 * 1000,
};

function comment(id: string, text: string, over: Record<string, unknown> = {}) {
  return {
    id, text, createdAt: "2026-10-05T11:00:00+0000",
    author: { id: "u" + id, name: "Asha", username: "asha_" + id },
    likeCount: 0, hidden: false, replyCount: 0, replies: [] as any[], isOwn: false, canReply: true,
    attachmentType: null, likedByAccount: null, canHide: true, canDelete: true, canLike: true, canEdit: false,
    ...over,
  } as any;
}

describe("config", () => {
  it("defaults and clamps", () => {
    expect(readCommentSentimentConfig({})).toEqual(CFG);
    expect(readCommentSentimentConfig({ COMMENT_SENTIMENT_MAX_PER_RUN: "99999", COMMENT_NEGATIVE_ALERT_MIN: "x" })).toMatchObject({
      maxScorePerRun: 2000,
      negativeAlertMin: 5,
    });
    // 0 = store only, score nothing (an emergency brake on AI spend).
    expect(readCommentSentimentConfig({ COMMENT_SENTIMENT_MAX_PER_RUN: "0" }).maxScorePerRun).toBe(0);
  });
});

describe("sentimentCandidates", () => {
  it("top-level + replies, never our own, never empty text; labels per platform; text capped", () => {
    const list = [
      comment("a", "Love it"),
      comment("own", "thanks!", { isOwn: true }),
      comment("img", "   "),
      comment("b", "x".repeat(1500), { replies: [comment("r1", "agreed"), comment("r-own", "ty", { isOwn: true })] }),
    ];
    const out = sentimentCandidates(list, "INSTAGRAM");
    expect(out.map((c) => [c.commentId, c.isReply, c.authorLabel])).toEqual([
      ["a", false, "@asha_a"],
      ["b", false, "@asha_b"],
      ["r1", true, "@asha_r1"],
    ]);
    expect(out[1]!.commentText).toHaveLength(1000);
    expect(out[0]!.commentedAt?.toISOString()).toBe("2026-10-05T11:00:00.000Z");
    expect(sentimentCandidates([comment("f", "hi", { author: { id: "1", name: null, username: null } })], "FACEBOOK")[0]!.authorLabel).toBe(
      "Facebook user"
    );
  });
});

describe("planScoring / chunk", () => {
  it("interleaves workspaces so one cannot take the whole budget", () => {
    const a = Array.from({ length: 10 }, (_, i) => ({ organizationId: "A", id: `a${i}` }));
    const b = [{ organizationId: "B", id: "b0" }, { organizationId: "B", id: "b1" }];
    expect(planScoring([a, b], 5).map((x) => x.id)).toEqual(["a0", "b0", "a1", "b1", "a2"]);
    expect(planScoring([a], 0)).toEqual([]);
  });
  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("shouldAlertNegative", () => {
  const base = { negative: 5, scored: 10, lastAlertAt: null, now: NOW, cfg: CFG };
  it("needs enough negatives AND a large enough share", () => {
    expect(shouldAlertNegative(base)).toBe(true);
    expect(shouldAlertNegative({ ...base, negative: 4 })).toBe(false);
    expect(shouldAlertNegative({ ...base, negative: 5, scored: 20 })).toBe(false);
  });
  it("respects the cooldown", () => {
    expect(shouldAlertNegative({ ...base, lastAlertAt: new Date(NOW.getTime() - 60 * 60 * 1000) })).toBe(false);
    expect(shouldAlertNegative({ ...base, lastAlertAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1000) })).toBe(true);
  });
  it("copy", () => {
    const c = negativeAlertCopy(6, 10, { text: "Worst service ever", authorLabel: "@fan" });
    expect(c.title).toBe("6 negative comments on your posts");
    expect(c.body).toContain("6 of 10");
    expect(c.body).toContain("@fan: “Worst service ever”");
  });
});

// ── scorePendingCommentSentiment with a fake database ──────────────────────

function fakePrisma(pending: Record<string, Array<{ id: string; commentText: string; authorLabel?: string }>>, lastAlert: Date | null = null) {
  const updates: any[] = [];
  const notifications: any[] = [];
  const prisma = {
    commentSentiment: {
      findMany: vi.fn(async (a: any) =>
        (pending[a.where.organizationId] ?? []).map((r) => ({ ...r, organizationId: a.where.organizationId, attempts: 0, authorLabel: r.authorLabel ?? null }))
      ),
      update: vi.fn(async (a: any) => updates.push(a)),
      count: vi.fn(async (a: any) => {
        const scoredIds = new Set(updates.filter((u) => u.data.sentiment).map((u) => u.where.id));
        return (pending[a.where.organizationId] ?? []).filter((r) => !scoredIds.has(r.id)).length;
      }),
    },
    notification: {
      findFirst: vi.fn(async () => (lastAlert ? { createdAt: lastAlert } : null)),
      create: vi.fn(async (a: any) => notifications.push(a.data)),
    },
    organizationMember: { findMany: vi.fn(async () => [{ userId: "owner" }, { userId: "admin" }]) },
  };
  return { prisma, updates, notifications };
}

const log = { log: vi.fn(), warn: vi.fn() };

describe("scorePendingCommentSentiment", () => {
  it("scores in batches of 20 and writes each verdict", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, commentText: `c${i}` }));
    const { prisma, updates } = fakePrisma({ A: rows });
    const scoreBatch = vi.fn(async (texts: string[]) => new Map(texts.map((_, i) => [i, { sentiment: "POSITIVE" as const, score: 0.8 }])));
    const res = await scorePendingCommentSentiment({ prisma, scoreBatch, now: () => NOW, log }, ["A"], CFG);
    expect(scoreBatch.mock.calls.map((c) => c[0].length)).toEqual([20, 5]);
    expect(updates).toHaveLength(25);
    expect(updates[0]).toEqual({ where: { id: "s0" }, data: { sentiment: "POSITIVE", sentimentScore: 0.8, scoredAt: NOW } });
    expect(res.A).toMatchObject({ scored: 25, negative: 0, pending: 0, alerted: false });
  });

  it("a missing verdict or a failed call leaves the comment UNSCORED (attempts+1), never a guessed NEUTRAL", async () => {
    const { prisma, updates } = fakePrisma({ A: [{ id: "x", commentText: "a" }, { id: "y", commentText: "b" }] });
    const scoreBatch = vi.fn(async () => new Map([[0, { sentiment: "NEGATIVE" as const, score: -0.7 }]]));
    const res = await scorePendingCommentSentiment({ prisma, scoreBatch, now: () => NOW, log }, ["A"], CFG);
    expect(updates[1]).toEqual({ where: { id: "y" }, data: { attempts: { increment: 1 } } });
    expect(res.A).toMatchObject({ scored: 1, negative: 1, pending: 1 });

    const failed = fakePrisma({ A: [{ id: "z", commentText: "c" }] });
    const boom = vi.fn(async () => {
      throw new Error("all providers failed");
    });
    await scorePendingCommentSentiment({ prisma: failed.prisma, scoreBatch: boom, now: () => NOW, log }, ["A"], CFG);
    expect(failed.updates).toEqual([{ where: { id: "z" }, data: { attempts: { increment: 1 } } }]);
  });

  it("only asks for comments still under the attempt limit", async () => {
    const { prisma } = fakePrisma({ A: [] });
    await scorePendingCommentSentiment({ prisma, scoreBatch: vi.fn(), now: () => NOW, log }, ["A"], CFG);
    expect(prisma.commentSentiment.findMany.mock.calls[0]![0].where).toEqual({ organizationId: "A", sentiment: null, attempts: { lt: 3 } });
  });

  it("alerts owners/admins on a burst of negative comments, once per cooldown", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, commentText: `bad ${i}`, authorLabel: "@angry" }));
    const negativeAll = vi.fn(async (texts: string[]) => new Map(texts.map((_, i) => [i, { sentiment: "NEGATIVE" as const, score: -0.9 }])));

    const fresh = fakePrisma({ A: rows });
    const res = await scorePendingCommentSentiment({ prisma: fresh.prisma, scoreBatch: negativeAll, now: () => NOW, log }, ["A"], CFG);
    expect(res.A!.alerted).toBe(true);
    expect(fresh.notifications.map((n) => [n.userId, n.type, n.link])).toEqual([
      ["owner", "comment.negative", "/dashboard/listening?view=comments"],
      ["admin", "comment.negative", "/dashboard/listening?view=comments"],
    ]);

    const recent = fakePrisma({ A: rows }, new Date(NOW.getTime() - 30 * 60 * 1000));
    await scorePendingCommentSentiment({ prisma: recent.prisma, scoreBatch: negativeAll, now: () => NOW, log }, ["A"], CFG);
    expect(recent.notifications).toHaveLength(0);
  });

  it("respects the per-run cap across workspaces", async () => {
    const { prisma } = fakePrisma({
      A: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, commentText: "x" })),
      B: Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, commentText: "x" })),
    });
    const scoreBatch = vi.fn(async (texts: string[]) => new Map(texts.map((_, i) => [i, { sentiment: "NEUTRAL" as const, score: 0 }])));
    const res = await scorePendingCommentSentiment({ prisma, scoreBatch, now: () => NOW, log }, ["A", "B"], { ...CFG, maxScorePerRun: 10 });
    expect(res.A!.scored + res.B!.scored).toBe(10);
    expect(res.A!.scored).toBe(5);
  });
});

// ── Sweep integration ──────────────────────────────────────────────────────

describe("runCommentSweep with comment sentiment on", () => {
  const SWEEP: SweepConfig = { maxPostsPerRun: 40, maxPostsPerOrg: 15, lookbackDays: 3, fbUsageCeiling: 75, maxHidesPerOrg: 50 };
  const IG = {
    id: "ch-ig", organizationId: "org-1", platform: "INSTAGRAM", platformId: "IG_USER", name: "Bollywood Daily",
    username: "bollywooddaily", accessToken: "DECRYPTED", refreshToken: null, metadata: { igUserId: "IG_USER" },
  };

  function setup(existing: string[] = []) {
    const created: any[] = [];
    const notifications: any[] = [];
    const prisma = {
      commentAutomation: {
        findMany: vi.fn(async (_a: any) => [
          { id: "auto", organizationId: "org-1", autoHideEnabled: false, alertsEnabled: false, sentimentEnabled: true, blockedWords: [], hideLinks: false, channelIds: [] },
        ]),
        update: vi.fn(async () => ({})),
      },
      postTarget: {
        findMany: vi.fn(async () => [{ id: "t1", channelId: "ch-ig", publishedId: "OBJ_t1", publishedAt: new Date("2026-10-05T08:00:00Z"), metadata: null }]),
      },
      channel: { findMany: vi.fn(async () => [IG]) },
      commentAutoAction: { findMany: vi.fn(async () => []), create: vi.fn() },
      commentSentiment: {
        findMany: vi.fn(async (a: any) =>
          a.where.commentId ? existing.filter((id) => a.where.commentId.in.includes(id)).map((commentId) => ({ commentId })) : []
        ),
        createMany: vi.fn(async (a: any) => created.push(...a.data)),
        update: vi.fn(),
        count: vi.fn(async () => 0),
      },
      notification: { findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => notifications.push(a.data)) },
      organizationMember: { findMany: vi.fn(async () => []) },
      $executeRaw: vi.fn(async () => 1),
    };
    const readComments = vi.fn(async () => ({
      comments: [comment("old", "seen before"), comment("new1", "Amazing!"), comment("own", "thanks", { isOwn: true })],
      nextCursor: null,
      totalCount: null,
    }));
    return { prisma, created, notifications, readComments };
  }

  it("a sentiment-only workspace is swept, stores only comments it hasn't seen, and scores them", async () => {
    const { prisma, created, readComments } = setup(["old"]);
    const scoreSentimentBatch = vi.fn(async () => new Map());
    const res = await runCommentSweep(
      { prisma, readComments, hideComment: vi.fn(), facebookUsagePeak: () => 0, now: () => NOW, log, scoreSentimentBatch } as any,
      SWEEP
    );
    expect(prisma.commentAutomation.findMany.mock.calls[0]![0].where.OR).toContainEqual({ sentimentEnabled: true });
    expect(readComments).toHaveBeenCalledTimes(1);
    expect(created.map((c) => [c.commentId, c.organizationId, c.postTargetId, c.channelId, c.platform])).toEqual([
      ["new1", "org-1", "t1", "ch-ig", "INSTAGRAM"],
    ]);
    expect(res["org-1"]).toMatchObject({ sentimentStored: 1, hidden: 0, newComments: 0 });
    // Scoring ran for the workspace (nothing pending in this fake → no model call).
    expect(prisma.commentSentiment.findMany.mock.calls.some((c: any[]) => c[0].where.sentiment === null)).toBe(true);
  });

  it("without the scorer the comments are still stored (scored on a later run)", async () => {
    const { prisma, created, readComments } = setup();
    await runCommentSweep({ prisma, readComments, hideComment: vi.fn(), facebookUsagePeak: () => 0, now: () => NOW, log } as any, SWEEP);
    expect(created.map((c) => c.commentId)).toEqual(["old", "new1"]);
  });
});
