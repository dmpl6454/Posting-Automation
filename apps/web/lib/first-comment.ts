/**
 * How the post page describes a target's automatic first comment (2026-10-17).
 * The worker records the outcome on PostTarget.metadata.firstComment — see
 * apps/worker/src/lib/first-comment.ts. Pure, so the wording is testable.
 */
export interface FirstCommentLine {
  tone: "ok" | "warn" | "error";
  text: string;
}

export function firstCommentLine(targetMetadata: unknown): FirstCommentLine | null {
  const raw = (targetMetadata as { firstComment?: { status?: unknown; error?: unknown } } | null)?.firstComment;
  if (!raw || typeof raw !== "object") return null;
  const error = typeof raw.error === "string" && raw.error ? raw.error : null;
  switch (raw.status) {
    case "posted":
      return { tone: "ok", text: "First comment posted." };
    case "unconfirmed":
      return {
        tone: "warn",
        text: "First comment not confirmed — it may already be on the post. Check before adding it by hand.",
      };
    case "failed":
      return { tone: "error", text: `First comment wasn't posted${error ? `: ${error}` : "."} You can add it from Show comments.` };
    default:
      return null;
  }
}
