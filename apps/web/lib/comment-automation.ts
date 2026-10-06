/**
 * Comment automation (auto-hide rules + new-comment alerts) — small pure
 * helpers for the Automation tab (2026-10-05). The server cleans the word list
 * again (normalizeBlockedWords); this only turns what was typed into a list
 * and the last run's summary into a sentence.
 */

/** One word or phrase per line or comma. Empty entries are dropped. */
export function parseBlockedWordsInput(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((w) => w.trim())
    .filter(Boolean);
}

export function formatBlockedWords(words: readonly string[]): string {
  return words.join("\n");
}

export interface RunSummary {
  postsChecked?: number;
  hidden?: number;
  newComments?: number;
  errors?: number;
  skippedForQuota?: number;
  hidePermissionMissing?: string[];
  sentimentScored?: number;
  sentimentNegative?: number;
  sentimentPending?: number;
  youtubeVideosChecked?: number;
}

/** "Checked 12 posts · hid 2 · 5 new comments · 1 couldn't be read." */
export function describeLastRun(summary: RunSummary | null | undefined): string {
  if (!summary) return "Hasn't run yet.";
  const parts: string[] = [];
  const posts = summary.postsChecked ?? 0;
  const videos = summary.youtubeVideosChecked ?? 0;
  if (posts === 0 && videos === 0) parts.push("No recent posts to check");
  if (posts > 0) parts.push(`Checked ${posts} ${posts === 1 ? "post" : "posts"}`);
  if (videos > 0) parts.push(`read comments on ${videos} YouTube ${videos === 1 ? "video" : "videos"}`);
  if (summary.hidden) parts.push(`hid ${summary.hidden}`);
  if (summary.newComments) parts.push(`${summary.newComments} new ${summary.newComments === 1 ? "comment" : "comments"}`);
  if (summary.errors) parts.push(`${summary.errors} couldn't be read or hidden`);
  if (summary.sentimentScored) {
    parts.push(
      `scored ${summary.sentimentScored} ${summary.sentimentScored === 1 ? "comment" : "comments"}` +
        (summary.sentimentNegative ? ` (${summary.sentimentNegative} negative)` : "")
    );
  }
  if (summary.sentimentPending) parts.push(`${summary.sentimentPending} waiting to be scored`);
  if (summary.skippedForQuota) parts.push(`${summary.skippedForQuota} Facebook ${summary.skippedForQuota === 1 ? "post" : "posts"} left for later (Meta usage high)`);
  return `${parts.join(" · ")}.`;
}

/** "word:scam" → "Blocked word “scam”", "link" → "Contains a link". */
export function describeReason(reason: string): string {
  if (reason === "link") return "Contains a link";
  if (reason.startsWith("word:")) return `Blocked word “${reason.slice(5)}”`;
  return reason;
}
