/**
 * Comment sentiment for our OWN posts (2026-10-05).
 *
 * When a workspace switches it on, the comment sweep (comment-sweep.ts), which
 * already reads the first page of comments on recent published Facebook /
 * Instagram posts, also:
 *
 *   1. stores every comment (and embedded reply) not written by the account
 *      itself in CommentSentiment — once per comment, keyed by its id;
 *   2. scores the not-yet-scored ones in batches of SENTIMENT_BATCH_SIZE per
 *      model call, with the same prompt/parser social listening uses;
 *   3. sends ONE in-app alert to owners/admins when a run scores a burst of
 *      negative comments (with a cooldown).
 *
 * No extra Meta calls: the comments are the ones the sweep already read.
 * Only the AI calls are new, and they are capped per run.
 *
 * Honesty: a comment the model returned no verdict for stays UNSCORED
 * (sentiment NULL) and is retried on a later run, up to `maxAttempts` — it is
 * never written as a guessed NEUTRAL, which would read as a real verdict.
 */

import type { CommentPlatform, SocialComment } from "@postautomation/social";
import { decodeEntities } from "./listening-comments";

export type Sentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";

export const SENTIMENT_BATCH_SIZE = 20;
export const COMMENT_TEXT_MAX = 1000;

export interface CommentSentimentConfig {
  /** AI-scored comments per sweep run, across all workspaces. */
  maxScorePerRun: number;
  /** Scoring rounds without a verdict before a comment is left unscored. */
  maxAttempts: number;
  /** A run must score at least this many negative comments to alert… */
  negativeAlertMin: number;
  /** …and they must be at least this share of the comments it scored. */
  negativeAlertShare: number;
  /** At most one negative-comments alert per workspace in this window. */
  negativeAlertCooldownMs: number;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readCommentSentimentConfig(env: Record<string, string | undefined> = process.env): CommentSentimentConfig {
  return {
    maxScorePerRun: intEnv(env, "COMMENT_SENTIMENT_MAX_PER_RUN", 200, 0, 2000),
    maxAttempts: 3,
    negativeAlertMin: intEnv(env, "COMMENT_NEGATIVE_ALERT_MIN", 5, 1, 1000),
    negativeAlertShare: 0.4,
    negativeAlertCooldownMs: 6 * 60 * 60 * 1000,
  };
}

/** Graph timestamps end in "+0000"; make them strictly ISO before parsing. */
function parseGraphTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const t = Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(t) ? new Date(t) : null;
}

function labelOf(c: SocialComment, platform: CommentPlatform): string {
  if (platform === "INSTAGRAM") return c.author.username ? `@${c.author.username}` : "Instagram user";
  return c.author.name ?? "Facebook user";
}

export interface StoredCommentInput {
  commentId: string;
  commentText: string;
  authorLabel: string;
  isReply: boolean;
  commentedAt: Date | null;
}

/**
 * The comments worth scoring on one page: top-level comments and their
 * embedded replies, not written by the account itself, with some text
 * (an attachment-only comment has nothing to score).
 */
export function sentimentCandidates(comments: readonly SocialComment[], platform: CommentPlatform): StoredCommentInput[] {
  const out: StoredCommentInput[] = [];
  const add = (c: SocialComment, isReply: boolean) => {
    if (c.isOwn) return;
    const text = (c.text ?? "").trim();
    if (!text) return;
    out.push({
      commentId: c.id,
      commentText: text.slice(0, COMMENT_TEXT_MAX),
      authorLabel: labelOf(c, platform),
      isReply,
      commentedAt: parseGraphTime(c.createdAt),
    });
  };
  for (const c of comments) {
    add(c, false);
    for (const r of c.replies) add(r, true);
  }
  return out;
}

/**
 * YouTube (2026-10-06): the same rows from one `commentThreads.list` page
 * (part=snippet,replies) on one of our own videos — every top-level comment
 * and the replies YouTube embeds, minus those our channel wrote. No keyword
 * filter: everything on our own video is feedback. Reply ids look like
 * "{parentId}.{replyId}", which YouTube's `lc=` deep link accepts too.
 */
export function youtubeSentimentCandidates(body: unknown, ownChannelId: string | null): StoredCommentInput[] {
  const items: any[] = Array.isArray((body as any)?.items) ? (body as any).items : [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const out: StoredCommentInput[] = [];
  const add = (c: any, isReply: boolean) => {
    const s = c?.snippet ?? {};
    const id = str(c?.id);
    if (!id) return;
    if (ownChannelId && str(s.authorChannelId?.value) === ownChannelId) return;
    const text = decodeEntities(str(s.textOriginal) || str(s.textDisplay)).trim();
    if (!text) return;
    const at = Date.parse(str(s.publishedAt));
    out.push({
      commentId: id,
      commentText: text.slice(0, COMMENT_TEXT_MAX),
      authorLabel: str(s.authorDisplayName).trim().slice(0, 200) || "YouTube user",
      isReply,
      commentedAt: Number.isFinite(at) ? new Date(at) : null,
    });
  };
  for (const it of items) {
    add(it?.snippet?.topLevelComment, false);
    const replies: any[] = Array.isArray(it?.replies?.comments) ? it.replies.comments : [];
    for (const r of replies) add(r, true);
  }
  return out;
}

/**
 * LinkedIn (2026-10-06): the same rows from one page of
 * `GET /rest/socialActions/{post}/comments` on one of our own Page's posts —
 * minus the comments the Page itself wrote (actor = its organization URN).
 * The versioned API returns actors as URNs only (no names), so the label says
 * what kind of account commented. The id is the comment URN, unique across
 * posts.
 */
export function linkedinSentimentCandidates(body: unknown, ownOrgUrn: string | null): StoredCommentInput[] {
  const elements: any[] = Array.isArray((body as any)?.elements) ? (body as any).elements : [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const out: StoredCommentInput[] = [];
  for (const e of elements) {
    const object = str(e?.object);
    const id = str(e?.commentUrn) || (str(e?.id) && object ? `urn:li:comment:(${object},${str(e.id)})` : "");
    if (!id) continue;
    const actor = str(e?.actor) || str(e?.created?.actor);
    if (ownOrgUrn && actor === ownOrgUrn) continue;
    const text = str(e?.message?.text).trim();
    if (!text) continue;
    const at = Number(e?.created?.time);
    out.push({
      commentId: id,
      commentText: text.slice(0, COMMENT_TEXT_MAX),
      authorLabel: actor.startsWith("urn:li:organization:") ? "LinkedIn Page" : "LinkedIn member",
      isReply: !!str(e?.parentComment),
      commentedAt: Number.isFinite(at) && at > 0 ? new Date(at) : null,
    });
  }
  return out;
}

/**
 * X (2026-10-06): the same rows from one recent-search page of a tweet's
 * conversation — replies by anyone but the account itself. X prefixes a reply
 * with the handles it answers ("@acme @sam …"); those are stripped so the
 * score is about what the person wrote, and a reply that is only handles is
 * skipped. `isReply` marks a reply to a reply (not directly to our tweet).
 * No author objects are requested (billed separately), so the label is
 * generic. The id is the reply's tweet id.
 */
export function twitterSentimentCandidates(body: unknown, ownUserId: string | null, rootTweetId: string): StoredCommentInput[] {
  const tweets: any[] = Array.isArray((body as any)?.data) ? (body as any).data : [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const out: StoredCommentInput[] = [];
  for (const t of tweets) {
    const id = str(t?.id);
    if (!/^\d+$/.test(id) || id === rootTweetId) continue;
    if (ownUserId && str(t?.author_id) === ownUserId) continue;
    const text = decodeEntities(str(t?.text)).replace(/^(?:@\w{1,15}\s+)+/, "").trim();
    if (!text || /^(?:@\w{1,15}\s*)+$/.test(text)) continue;
    const repliedTo = Array.isArray(t?.referenced_tweets)
      ? str(t.referenced_tweets.find((r: any) => r?.type === "replied_to")?.id)
      : "";
    const at = Date.parse(str(t?.created_at));
    out.push({
      commentId: id,
      commentText: text.slice(0, COMMENT_TEXT_MAX),
      authorLabel: "X user",
      isReply: !!repliedTo && repliedTo !== rootTweetId,
      commentedAt: Number.isFinite(at) ? new Date(at) : null,
    });
  }
  return out;
}

/**
 * Interleave each workspace's pending comments (oldest first within a
 * workspace) round-robin, up to the cap — so one busy workspace cannot use
 * the whole run's AI budget.
 */
export function planScoring<T extends { organizationId: string }>(pendingByOrg: ReadonlyArray<readonly T[]>, cap: number): T[] {
  const out: T[] = [];
  for (let round = 0; out.length < cap; round++) {
    let added = false;
    for (const list of pendingByOrg) {
      const next = list[round];
      if (!next) continue;
      out.push(next);
      added = true;
      if (out.length >= cap) break;
    }
    if (!added) break;
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Should this run raise a "negative comments" alert for a workspace? */
export function shouldAlertNegative(p: {
  negative: number;
  scored: number;
  lastAlertAt: Date | null;
  now: Date;
  cfg: Pick<CommentSentimentConfig, "negativeAlertMin" | "negativeAlertShare" | "negativeAlertCooldownMs">;
}): boolean {
  if (p.negative < p.cfg.negativeAlertMin) return false;
  if (p.scored === 0 || p.negative / p.scored < p.cfg.negativeAlertShare) return false;
  if (p.lastAlertAt && p.now.getTime() - p.lastAlertAt.getTime() < p.cfg.negativeAlertCooldownMs) return false;
  return true;
}

export function negativeAlertCopy(
  negative: number,
  scored: number,
  sample: { text: string; authorLabel: string | null } | null
): { title: string; body: string } {
  const title = `${negative} negative ${negative === 1 ? "comment" : "comments"} on your posts`;
  const parts = [`${negative} of ${scored} new comments scored in the last check read as negative.`];
  if (sample) {
    const text = sample.text.replace(/\s+/g, " ").slice(0, 90);
    parts.push(`${sample.authorLabel ?? "Someone"}: “${text}${sample.text.length > 90 ? "…" : ""}”`);
  }
  return { title, body: parts.join(" ") };
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface ScoreDeps {
  prisma: any;
  /** One model call for up to SENTIMENT_BATCH_SIZE texts → verdict by index. Throws when every provider fails. */
  scoreBatch: (texts: string[]) => Promise<Map<number, { sentiment: Sentiment; score: number }>>;
  now?: () => Date;
  log?: Pick<Console, "log" | "warn">;
}

export interface OrgSentimentResult {
  scored: number;
  negative: number;
  /** Still waiting for a verdict after this run. */
  pending: number;
  alerted: boolean;
}

/**
 * Score pending comments for the given workspaces, then raise negative-burst
 * alerts. Never throws — a scoring failure leaves rows pending for next time.
 */
export async function scorePendingCommentSentiment(
  deps: ScoreDeps,
  organizationIds: readonly string[],
  cfg: CommentSentimentConfig = readCommentSentimentConfig()
): Promise<Record<string, OrgSentimentResult>> {
  const log = deps.log ?? console;
  const now = (deps.now ?? (() => new Date()))();
  const prisma = deps.prisma;
  const results: Record<string, OrgSentimentResult> = {};
  for (const id of organizationIds) results[id] = { scored: 0, negative: 0, pending: 0, alerted: false };
  if (organizationIds.length === 0) return results;

  const pendingByOrg: any[][] = [];
  for (const orgId of organizationIds) {
    try {
      const rows: any[] = await prisma.commentSentiment.findMany({
        where: { organizationId: orgId, sentiment: null, attempts: { lt: cfg.maxAttempts } },
        orderBy: { createdAt: "asc" },
        take: cfg.maxScorePerRun,
        select: { id: true, organizationId: true, commentText: true, authorLabel: true, attempts: true },
      });
      pendingByOrg.push(rows);
    } catch (err: any) {
      log.warn(`[CommentSentiment] pending read failed for org ${orgId}: ${String(err?.message ?? err).slice(0, 160)}`);
      pendingByOrg.push([]);
    }
  }

  const planned = planScoring(pendingByOrg, cfg.maxScorePerRun);
  const negativeSample = new Map<string, { text: string; authorLabel: string | null }>();

  for (const batch of chunk(planned, SENTIMENT_BATCH_SIZE)) {
    let verdicts = new Map<number, { sentiment: Sentiment; score: number }>();
    try {
      verdicts = await deps.scoreBatch(batch.map((r) => r.commentText));
    } catch (err: any) {
      log.warn(`[CommentSentiment] scoring unavailable for ${batch.length} comments: ${String(err?.message ?? err).slice(0, 160)}`);
    }
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]!;
      const v = verdicts.get(i);
      try {
        if (v) {
          await prisma.commentSentiment.update({
            where: { id: row.id },
            data: { sentiment: v.sentiment, sentimentScore: v.score, scoredAt: now },
          });
          const r = results[row.organizationId]!;
          r.scored++;
          if (v.sentiment === "NEGATIVE") {
            r.negative++;
            if (!negativeSample.has(row.organizationId)) {
              negativeSample.set(row.organizationId, { text: row.commentText, authorLabel: row.authorLabel ?? null });
            }
          }
        } else {
          await prisma.commentSentiment.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
        }
      } catch (err: any) {
        log.warn(`[CommentSentiment] write failed for ${row.id}: ${String(err?.message ?? err).slice(0, 160)}`);
      }
    }
  }

  for (const orgId of organizationIds) {
    const r = results[orgId]!;
    try {
      r.pending = await prisma.commentSentiment.count({
        where: { organizationId: orgId, sentiment: null, attempts: { lt: cfg.maxAttempts } },
      });
    } catch {
      /* the count is informational */
    }
    if (r.negative === 0) continue;
    try {
      const last = await prisma.notification.findFirst({
        where: { organizationId: orgId, type: "comment.negative" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!shouldAlertNegative({ negative: r.negative, scored: r.scored, lastAlertAt: last?.createdAt ?? null, now, cfg })) continue;
      const members: any[] = await prisma.organizationMember.findMany({
        where: { organizationId: orgId, role: { in: ["OWNER", "ADMIN"] } },
        select: { userId: true },
      });
      const { title, body } = negativeAlertCopy(r.negative, r.scored, negativeSample.get(orgId) ?? null);
      for (const m of members) {
        await prisma.notification.create({
          data: {
            organizationId: orgId,
            userId: m.userId,
            type: "comment.negative",
            title,
            body,
            link: "/dashboard/listening?view=comments",
            metadata: { negative: r.negative, scored: r.scored },
          },
        });
      }
      r.alerted = members.length > 0;
    } catch (err: any) {
      log.warn(`[CommentSentiment] negative alert failed for org ${orgId}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }

  const total = Object.values(results).reduce((t, r) => ({ s: t.s + r.scored, n: t.n + r.negative, p: t.p + r.pending }), { s: 0, n: 0, p: 0 });
  if (planned.length > 0 || total.p > 0) {
    log.log(`[CommentSentiment] orgs=${organizationIds.length} scored=${total.s} negative=${total.n} pending=${total.p}`);
  }
  return results;
}
