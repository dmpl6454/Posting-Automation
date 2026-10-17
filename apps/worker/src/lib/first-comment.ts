import {
  readInstagramFirstComment,
  readFirstCommentRecord,
  type FirstCommentRecord,
} from "@postautomation/social";

/**
 * The automatic first comment on a freshly published Instagram post
 * (2026-10-17) — e.g. hashtags kept out of the caption. Runs in the publish
 * worker AFTER the target is marked PUBLISHED.
 *
 * 🔴 NEVER THROWS. The post is already live; an escaping error would fail the
 * job and BullMQ would re-run the publish — a duplicate post (the 2026-08-18
 * class). Every outcome is recorded on PostTarget.metadata.firstComment.
 *
 * Posted at most once per target: a recorded outcome (even "unconfirmed" — it
 * may already be live) is never retried automatically. A retried publish job
 * cannot reach this either: the publishedId short-circuit returns first.
 *
 * Skipped for stories (no comments edge) and for every non-Instagram target.
 */
export interface FirstCommentArgs {
  platform: string;
  isStoryTarget: boolean;
  postMetadata: unknown;
  targetId: string;
  /** Target metadata as just written (to see an earlier outcome). */
  targetMetadata: unknown;
  /** The published IG media id. */
  mediaId: string | null | undefined;
  tokens: { accessToken: string; refreshToken?: string; metadata?: Record<string, unknown> };
}

export interface FirstCommentDeps {
  prisma: { $executeRaw: (...args: any[]) => Promise<unknown> };
  commentOnMedia: (tokens: FirstCommentArgs["tokens"], mediaId: string, message: string) => Promise<{ id: string }>;
  now?: () => Date;
}

export async function postFirstComment(deps: FirstCommentDeps, a: FirstCommentArgs): Promise<FirstCommentRecord | null> {
  try {
    if (a.platform !== "INSTAGRAM" || a.isStoryTarget || !a.mediaId) return null;
    const first = readInstagramFirstComment(a.postMetadata);
    if (!first) return null;
    if (readFirstCommentRecord(a.targetMetadata)) return null;

    const at = (deps.now?.() ?? new Date()).toISOString();
    let record: FirstCommentRecord;
    try {
      const res = await deps.commentOnMedia(a.tokens, a.mediaId, first.text);
      record = { status: "posted", commentId: res.id, at };
    } catch (err: any) {
      const message = String(err?.message ?? "Instagram couldn't post the first comment.");
      record = /may already be posted/i.test(message)
        ? { status: "unconfirmed", error: message.slice(0, 300), at }
        : { status: "failed", error: message.slice(0, 300), at };
    }

    // Atomic jsonb merge — never a whole-column rewrite (the publish result's
    // metadata, e.g. the story checkpoint, lives in the same column).
    const patch = JSON.stringify({ firstComment: record });
    try {
      await deps.prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${a.targetId}`;
    } catch (dbErr: any) {
      console.error(`[FirstComment] could not record the outcome for ${a.targetId}:`, dbErr?.message ?? dbErr);
    }
    console.log(`[FirstComment] ${a.targetId}: ${record.status}${record.commentId ? ` (${record.commentId})` : ""}`);
    return record;
  } catch (err: any) {
    console.error(`[FirstComment] unexpected error for ${a.targetId}:`, err?.message ?? err);
    return null;
  }
}
