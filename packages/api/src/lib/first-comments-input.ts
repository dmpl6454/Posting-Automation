/**
 * The stored first-comments markers for post.create. The worker reads them
 * with readFirstCommentsPlan (@postautomation/social).
 *
 * - `firstComments` (2026-11-03 clients) → `metadata.firstComments`, applied to
 *   Instagram AND Facebook targets.
 * - `firstComment` alone (a 2026-10-17 client, e.g. a stale tab) →
 *   `metadata.instagramFirstComment`, Instagram only, exactly as before: that
 *   user was told "Facebook doesn't get it".
 * Nothing for a story or an article, or when no comment was sent.
 */
export function firstCommentMetadata(a: {
  firstComments?: string[];
  firstComment?: string;
  firstCommentDelayMinutes?: number;
  isStory: boolean;
  isArticle: boolean;
}): { firstComments: { comments: string[]; delayMinutes: number } } | { instagramFirstComment: { text: string } } | {} {
  const marker = firstCommentsMarker(a);
  if (marker) return { firstComments: marker };
  if (!a.isStory && !a.isArticle && a.firstComment) return { instagramFirstComment: { text: a.firstComment } };
  return {};
}

/** The new-client marker only (see firstCommentMetadata). */
export function firstCommentsMarker(a: {
  firstComments?: string[];
  firstComment?: string;
  firstCommentDelayMinutes?: number;
  isStory: boolean;
  isArticle: boolean;
}): { comments: string[]; delayMinutes: number } | undefined {
  if (a.isStory || a.isArticle) return undefined;
  if (!a.firstComments?.length) return undefined;
  return { comments: a.firstComments, delayMinutes: a.firstCommentDelayMinutes ?? 0 };
}
