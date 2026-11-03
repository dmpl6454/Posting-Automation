/**
 * How the post page describes a target's automatic first comments (2026-10-17;
 * several comments, Facebook and a delay since 2026-11-03).
 * The worker records the outcome on PostTarget.metadata.firstComment — see
 * apps/worker/src/lib/first-comment.ts. Pure, so the wording is testable.
 */
export interface FirstCommentLine {
  tone: "ok" | "warn" | "error";
  text: string;
}

export function firstCommentLine(targetMetadata: unknown, now: Date = new Date()): FirstCommentLine | null {
  const raw = (targetMetadata as {
    firstComment?: { status?: unknown; error?: unknown; dueAt?: unknown; posted?: unknown; total?: unknown };
  } | null)?.firstComment;
  if (!raw || typeof raw !== "object") return null;
  const error = typeof raw.error === "string" && raw.error ? raw.error : null;
  const total = typeof raw.total === "number" && raw.total > 1 ? raw.total : null;
  const posted = typeof raw.posted === "number" ? raw.posted : 0;
  const noun = total ? "First comments" : "First comment";
  switch (raw.status) {
    case "scheduled": {
      const due = typeof raw.dueAt === "string" ? new Date(raw.dueAt) : null;
      const when =
        due && !Number.isNaN(due.getTime())
          ? due.getTime() <= now.getTime()
            ? "any moment now"
            : `at ${due.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
          : "later";
      return { tone: "ok", text: `${noun} will be posted ${when}.` };
    }
    case "posting":
      return { tone: "ok", text: `Posting the ${noun.toLowerCase()}…` };
    case "posted":
      return { tone: "ok", text: total ? `All ${total} first comments posted.` : "First comment posted." };
    case "unconfirmed":
      return {
        tone: "warn",
        text: total
          ? `${posted} of ${total} first comments posted; the next one wasn't confirmed — it may already be on the post. Check before adding any by hand.`
          : "First comment not confirmed — it may already be on the post. Check before adding it by hand.",
      };
    case "failed":
      return total
        ? {
            tone: "error",
            text: `${posted} of ${total} first comments posted${error ? `; the next one failed: ${error}` : "."} You can add the rest from Show comments.`,
          }
        : { tone: "error", text: `First comment wasn't posted${error ? `: ${error}` : "."} You can add it from Show comments.` };
    default:
      return null;
  }
}

/** Mirrors FIRST_COMMENTS_MAX / FIRST_COMMENT_TEXT_MAX in @postautomation/social. */
export const FIRST_COMMENTS_MAX = 5;
export const FIRST_COMMENT_TEXT_MAX = 2200;

/** Delay choices offered in Compose (minutes after the post goes live). */
export const FIRST_COMMENT_DELAY_OPTIONS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 0, label: "Right away" },
  { minutes: 1, label: "After 1 minute" },
  { minutes: 5, label: "After 5 minutes" },
  { minutes: 15, label: "After 15 minutes" },
  { minutes: 30, label: "After 30 minutes" },
  { minutes: 60, label: "After 1 hour" },
  { minutes: 180, label: "After 3 hours" },
  { minutes: 1440, label: "After 24 hours" },
];

/**
 * `{ firstComments, firstCommentDelayMinutes }` for post.create, or nothing:
 * no Instagram/Facebook channel selected, a story or an article, or every box
 * blank. Blank boxes are dropped; the order the user typed is kept.
 */
export function buildFirstCommentsPayload(a: {
  comments: string[];
  delayMinutes: number;
  hasCommentChannel: boolean;
  isStoryMode: boolean;
  isArticleMode: boolean;
}): { firstComments?: string[]; firstCommentDelayMinutes?: number } {
  if (a.isStoryMode || a.isArticleMode || !a.hasCommentChannel) return {};
  const comments = a.comments.map((c) => c.trim()).filter(Boolean).slice(0, FIRST_COMMENTS_MAX);
  if (!comments.length) return {};
  return a.delayMinutes > 0 ? { firstComments: comments, firstCommentDelayMinutes: a.delayMinutes } : { firstComments: comments };
}
