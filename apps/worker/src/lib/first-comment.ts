import {
  readFirstCommentsPlan,
  readFirstCommentRecord,
  summarizeFirstComments,
  type FirstCommentItemRecord,
  type FirstCommentRecord,
} from "@postautomation/social";

/**
 * Automatic first comments on a freshly published post — e.g. hashtags kept
 * out of the caption. 2026-10-17: one comment, Instagram, immediately.
 * 2026-11-03: up to five comments, Instagram AND Facebook Pages, optionally
 * after a delay (see packages/social/src/utils/first-comments.ts).
 *
 * 🔴 NEVER THROWS. The post is already live; an escaping error would fail the
 * publish job and BullMQ would re-run the publish — a duplicate post (the
 * 2026-08-18 class). Every outcome is recorded on PostTarget.metadata.firstComment.
 *
 * 🔴 Posted at most once per target, enforced by an ATOMIC CLAIM in SQL:
 *   - immediately: no record → `posting`
 *   - delayed: no record → `scheduled` (publish worker), then
 *     `scheduled` → `posting` (first-comment worker)
 * Only the caller that wins the claim posts. A record stuck at `posting`
 * means a worker died mid-run: the outcome is unknown, so it is never retried
 * automatically (the cron marks it unconfirmed — see
 * markStaleFirstCommentsUnconfirmed). Creating a comment is not idempotent.
 *
 * Comments are posted in order; the first one that does not post stops the
 * run and the rest are recorded as skipped — an unknown outcome might be a
 * live comment, and posting the next ones would scramble the order.
 *
 * Skipped for stories (no comments edge) and for platforms other than
 * Instagram and Facebook.
 */
export interface FirstCommentArgs {
  platform: string;
  isStoryTarget: boolean;
  postMetadata: unknown;
  targetId: string;
  /** Target metadata as just written (to see an earlier outcome). */
  targetMetadata: unknown;
  /** The published media / post id (Instagram media id, Facebook post or video id). */
  mediaId: string | null | undefined;
  tokens: { accessToken: string; refreshToken?: string; metadata?: Record<string, unknown> };
  /** Facebook Page id — for the Page-aware Graph throttle. */
  pageId?: string | null;
}

export type CommentPoster = (
  platform: string,
  tokens: FirstCommentArgs["tokens"],
  objectId: string,
  message: string,
  pageId?: string | null
) => Promise<{ id: string }>;

export interface FirstCommentDeps {
  prisma: { $executeRaw: (...args: any[]) => Promise<unknown> };
  comment: CommentPoster;
  /** Queue the delayed run. May throw — the cron re-queues overdue `scheduled` records. */
  enqueueDelayed?: (targetId: string, delayMs: number) => Promise<void>;
  /** Pause between comments, so they land in order. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const FIRST_COMMENT_GAP_MS = 1500;

function eligible(a: Pick<FirstCommentArgs, "platform" | "isStoryTarget" | "mediaId" | "postMetadata">) {
  if (a.isStoryTarget || !a.mediaId) return null;
  const plan = readFirstCommentsPlan(a.postMetadata);
  if (!plan || !plan.platforms.includes(a.platform)) return null;
  return plan;
}

/** Called by the publish worker right after a target is marked PUBLISHED. */
export async function postFirstComment(deps: FirstCommentDeps, a: FirstCommentArgs): Promise<FirstCommentRecord | null> {
  try {
    const plan = eligible(a);
    if (!plan) return null;
    if (readFirstCommentRecord(a.targetMetadata)) return null;
    const now = deps.now?.() ?? new Date();

    if (plan.delayMinutes > 0 && deps.enqueueDelayed) {
      const dueAt = new Date(now.getTime() + plan.delayMinutes * 60_000).toISOString();
      const scheduled: FirstCommentRecord = {
        status: "scheduled",
        at: now.toISOString(),
        dueAt,
        // The count lets the post page say "First comments" before they run.
        ...(plan.comments.length > 1 ? { total: plan.comments.length } : {}),
      };
      if (!(await claimFresh(deps, a.targetId, scheduled))) return null;
      try {
        await deps.enqueueDelayed(a.targetId, plan.delayMinutes * 60_000);
      } catch (err: any) {
        // The record says `scheduled`; the cron re-queues overdue ones.
        console.error(`[FirstComment] could not queue the delayed run for ${a.targetId}:`, err?.message ?? err);
      }
      console.log(`[FirstComment] ${a.targetId}: scheduled for ${dueAt}`);
      return scheduled;
    }

    const posting: FirstCommentRecord = { status: "posting", at: now.toISOString() };
    if (!(await claimFresh(deps, a.targetId, posting))) return null;
    return await runComments(deps, a, plan.comments);
  } catch (err: any) {
    console.error(`[FirstComment] unexpected error for ${a.targetId}:`, err?.message ?? err);
    return null;
  }
}

/**
 * Called by the first-comment worker when a delay ends. `a.targetMetadata`
 * is ignored — the claim reads the row itself.
 */
export async function postScheduledFirstComment(deps: FirstCommentDeps, a: FirstCommentArgs): Promise<FirstCommentRecord | null> {
  try {
    const plan = eligible(a);
    if (!plan) {
      // The post changed since it was scheduled (comments removed, now a story…).
      // Close the record rather than leave it `scheduled` for the sweep to chase.
      await abandonScheduledFirstComment(deps.prisma, a.targetId, "The first comments were no longer set on this post, so none were posted.", deps.now?.());
      return null;
    }
    const posting: FirstCommentRecord = { status: "posting", at: (deps.now?.() ?? new Date()).toISOString() };
    const patch = JSON.stringify({ firstComment: posting });
    const won = await deps.prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${a.targetId} AND "metadata"->'firstComment'->>'status' = 'scheduled'`;
    if (Number(won) !== 1) return null;
    return await runComments(deps, a, plan.comments);
  } catch (err: any) {
    console.error(`[FirstComment] unexpected error for ${a.targetId}:`, err?.message ?? err);
    return null;
  }
}

/** No record yet → `record`. True only for the caller that wrote it. */
async function claimFresh(deps: FirstCommentDeps, targetId: string, record: FirstCommentRecord): Promise<boolean> {
  const patch = JSON.stringify({ firstComment: record });
  const won = await deps.prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${targetId} AND ("metadata" IS NULL OR "metadata"->'firstComment' IS NULL)`;
  return Number(won) === 1;
}

async function runComments(deps: FirstCommentDeps, a: FirstCommentArgs, comments: string[]): Promise<FirstCommentRecord> {
  const items: FirstCommentItemRecord[] = [];
  let stopped = false;
  for (let i = 0; i < comments.length; i++) {
    if (stopped) {
      items.push({ status: "skipped" });
      continue;
    }
    if (i > 0) await (deps.sleep ?? defaultSleep)(FIRST_COMMENT_GAP_MS);
    try {
      const res = await deps.comment(a.platform, a.tokens, a.mediaId!, comments[i]!, a.pageId);
      items.push({ status: "posted", commentId: res.id });
    } catch (err: any) {
      const message = String(err?.message ?? "The platform couldn't post the first comment.").slice(0, 300);
      items.push(/may already be posted/i.test(message) ? { status: "unconfirmed", error: message } : { status: "failed", error: message });
      stopped = true;
    }
  }
  const record = summarizeFirstComments(items, (deps.now?.() ?? new Date()).toISOString());

  // Atomic jsonb merge — never a whole-column rewrite (the publish result's
  // metadata, e.g. the story checkpoint, lives in the same column).
  const patch = JSON.stringify({ firstComment: record });
  try {
    await deps.prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${a.targetId}`;
  } catch (dbErr: any) {
    console.error(`[FirstComment] could not record the outcome for ${a.targetId}:`, dbErr?.message ?? dbErr);
  }
  console.log(
    `[FirstComment] ${a.platform} ${a.targetId}: ${record.status}` +
      (record.total ? ` (${record.posted}/${record.total})` : record.commentId ? ` (${record.commentId})` : "")
  );
  return record;
}

function defaultSleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** `scheduled` → `failed` with a reason; does nothing when the record moved on. */
export async function abandonScheduledFirstComment(
  prisma: { $executeRaw: (...args: any[]) => Promise<unknown> },
  targetId: string,
  reason: string,
  now: Date = new Date()
): Promise<boolean> {
  const record: FirstCommentRecord = { status: "failed", error: reason, at: now.toISOString() };
  const patch = JSON.stringify({ firstComment: record });
  const n = await prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${targetId} AND "metadata"->'firstComment'->>'status' = 'scheduled'`;
  return Number(n) === 1;
}

/** How long a delayed run may be overdue before the cron re-queues it. */
export const FIRST_COMMENT_REQUEUE_AFTER_MS = 5 * 60_000;
/** Past this, an overdue delayed run is abandoned instead of re-queued. */
export const FIRST_COMMENT_GIVE_UP_AFTER_MS = 48 * 60 * 60_000;
/** A run still `posting` after this died mid-way. */
export const FIRST_COMMENT_POSTING_STALE_MS = 30 * 60_000;

export const STALE_POSTING_MESSAGE =
  "Posting the first comments was interrupted, so it isn't known which ones went out — they may already be posted. Check the post before adding any by hand.";

export interface FirstCommentSweepDeps {
  prisma: {
    $queryRaw: (...args: any[]) => Promise<unknown>;
    $executeRaw: (...args: any[]) => Promise<unknown>;
  };
  requeue: (targetId: string, jobId: string) => Promise<void>;
  now?: () => Date;
}

/**
 * The cron's safety net (every 10 min):
 * - a `scheduled` record overdue by 5 min (its delayed job was lost or failed
 *   before claiming) is re-queued under a fresh, bucketed job id — the claim
 *   makes a duplicate harmless; overdue by 48h it is abandoned;
 * - a `posting` record older than 30 min (the worker died mid-run) becomes
 *   `unconfirmed`. It is NEVER re-posted: some comments may be live.
 */
export async function sweepFirstComments(deps: FirstCommentSweepDeps): Promise<{ requeued: number; abandoned: number; stale: number }> {
  const now = deps.now?.() ?? new Date();
  const requeueBefore = new Date(now.getTime() - FIRST_COMMENT_REQUEUE_AFTER_MS);
  const giveUpBefore = new Date(now.getTime() - FIRST_COMMENT_GIVE_UP_AFTER_MS);
  const staleBefore = new Date(now.getTime() - FIRST_COMMENT_POSTING_STALE_MS);
  const bucket = Math.floor(now.getTime() / (10 * 60_000));
  let requeued = 0;
  let abandoned = 0;
  let stale = 0;

  const overdue = (await deps.prisma.$queryRaw`SELECT "id", ("metadata"->'firstComment'->>'dueAt') AS "dueAt" FROM "PostTarget" WHERE "metadata"->'firstComment'->>'status' = 'scheduled' AND ("metadata"->'firstComment'->>'dueAt')::timestamptz < ${requeueBefore} ORDER BY ("metadata"->'firstComment'->>'dueAt') LIMIT 200`) as Array<{ id: string; dueAt: string }>;
  for (const row of overdue) {
    try {
      if (new Date(row.dueAt) < giveUpBefore) {
        if (await abandonScheduledFirstComment(deps.prisma, row.id, "The first comments could not be posted in time and were cancelled.", now)) abandoned++;
        continue;
      }
      // Exactly three colon segments (BullMQ's rule).
      await deps.requeue(row.id, `fcomment:${row.id}:r${bucket}`);
      requeued++;
    } catch (err: any) {
      console.error(`[FirstComment] sweep could not handle ${row.id}:`, err?.message ?? err);
    }
  }

  const record: FirstCommentRecord = { status: "unconfirmed", error: STALE_POSTING_MESSAGE, at: now.toISOString() };
  const patch = JSON.stringify({ firstComment: record });
  const n = await deps.prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "metadata"->'firstComment'->>'status' = 'posting' AND ("metadata"->'firstComment'->>'at')::timestamptz < ${staleBefore}`;
  stale = Number(n) || 0;

  if (requeued || abandoned || stale) {
    console.log(`[FirstComment] sweep: requeued=${requeued} abandoned=${abandoned} interrupted=${stale}`);
  }
  return { requeued, abandoned, stale };
}
