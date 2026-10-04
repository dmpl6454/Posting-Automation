/**
 * Pure helpers for Content Studio → Compose's WordPress ARTICLE mode
 * (2026-10-04). No React, no tRPC — channel filtering, the submit gate and the
 * draft restore are unit-tested; the component only wires them together.
 *
 * An article publishes ONE blog post (title + Markdown body + excerpt + status
 * + categories/tags) to one or more self-hosted WordPress sites. The server
 * re-validates everything (`packages/api/src/lib/wordpress-article.ts`); the
 * limits here are deliberate replicas so the form can say no before a round
 * trip. Keep them in step.
 */

export const ARTICLE_PLATFORMS = ["WORDPRESS"] as const;
export const ARTICLE_TITLE_MAX = 200;
export const ARTICLE_EXCERPT_MAX = 1000;
export const ARTICLE_STATUSES = ["publish", "draft", "pending"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
  publish: "Publish on the site",
  draft: "Save as a WordPress draft",
  pending: "Submit for review (pending)",
};

export interface ArticleTaxonomySelection {
  categoryIds: number[];
  tagIds: number[];
}

export interface ArticleState {
  title: string;
  excerpt: string;
  status: ArticleStatus;
  /** Tag NAMES typed by the author — created or reused on every target site. */
  newTags: string[];
  /** Existing term ids, keyed by channel id (the server re-keys by site). */
  taxonomyByChannelId: Record<string, ArticleTaxonomySelection>;
}

export const EMPTY_ARTICLE: ArticleState = {
  title: "",
  excerpt: "",
  status: "publish",
  newTags: [],
  taxonomyByChannelId: {},
};

export function isArticleChannel(channel: { platform: string }): boolean {
  return (ARTICLE_PLATFORMS as readonly string[]).includes(channel.platform);
}

/** Drop every selected id that is not a live WordPress channel. */
export function pruneSelectionForArticle(
  selectedIds: string[],
  channels: Array<{ id: string; platform: string }>
): { next: string[]; removed: number } {
  const ok = new Set(channels.filter(isArticleChannel).map((c) => c.id));
  const next = selectedIds.filter((id) => ok.has(id));
  return { next, removed: selectedIds.length - next.length };
}

/**
 * Why the article cannot be submitted yet, or null. ONE predicate feeds the
 * submit handler, the buttons' disabled/title and the visible banner, so they
 * cannot disagree (same shape as storyBlockReason).
 */
export function articleBlockReason(input: {
  title: string;
  bodyLength: number;
  selectedCount: number;
  uploading: boolean;
}): string | null {
  if (!input.title.trim()) return "Give the article a title.";
  if (input.title.trim().length > ARTICLE_TITLE_MAX) return `The title is too long (max ${ARTICLE_TITLE_MAX} characters).`;
  if (input.bodyLength === 0) return "Write the article body.";
  if (input.selectedCount === 0) return "Select at least one WordPress site.";
  if (input.uploading) return "Wait for the images to finish uploading.";
  return null;
}

/** Split typed tag input on commas/newlines, trim, dedupe case-insensitively, cap length. */
export function addArticleTags(existing: string[], typed: string): string[] {
  const out = [...existing];
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  for (const raw of typed.split(/[,\n]/)) {
    const t = raw.trim().slice(0, 100);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 50);
}

/** The payload `post.create` takes. Only STILL-selected channels keep their term ids. */
export function buildArticlePayload(state: ArticleState, selectedChannelIds: string[]) {
  const selected = new Set(selectedChannelIds);
  const taxonomyByChannelId: Record<string, ArticleTaxonomySelection> = {};
  for (const [channelId, tax] of Object.entries(state.taxonomyByChannelId)) {
    if (!selected.has(channelId)) continue;
    if (tax.categoryIds.length === 0 && tax.tagIds.length === 0) continue;
    taxonomyByChannelId[channelId] = { categoryIds: [...tax.categoryIds], tagIds: [...tax.tagIds] };
  }
  const excerpt = state.excerpt.trim();
  return {
    title: state.title.trim(),
    ...(excerpt ? { excerpt: excerpt.slice(0, ARTICLE_EXCERPT_MAX) } : {}),
    status: state.status,
    newTags: state.newTags,
    taxonomyByChannelId,
  };
}

/**
 * Re-validate a restored draft's article block entry by entry — hand-edited
 * storage or an older build must never 400 the whole post. Anything malformed
 * is dropped, never trusted.
 */
export function sanitizeRestoredArticle(raw: unknown): ArticleState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const title = typeof a.title === "string" ? a.title.slice(0, ARTICLE_TITLE_MAX) : "";
  const excerpt = typeof a.excerpt === "string" ? a.excerpt.slice(0, ARTICLE_EXCERPT_MAX) : "";
  const status = (ARTICLE_STATUSES as readonly string[]).includes(a.status as string) ? (a.status as ArticleStatus) : "publish";
  const newTags = Array.isArray(a.newTags) ? addArticleTags([], a.newTags.filter((t): t is string => typeof t === "string").join(",")) : [];
  const taxonomyByChannelId: Record<string, ArticleTaxonomySelection> = {};
  const ints = (v: unknown): number[] =>
    Array.isArray(v) ? [...new Set(v.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0))] : [];
  if (a.taxonomyByChannelId && typeof a.taxonomyByChannelId === "object" && !Array.isArray(a.taxonomyByChannelId)) {
    for (const [channelId, tax] of Object.entries(a.taxonomyByChannelId as Record<string, unknown>)) {
      if (!tax || typeof tax !== "object" || typeof channelId !== "string" || !channelId) continue;
      const t = tax as Record<string, unknown>;
      taxonomyByChannelId[channelId] = { categoryIds: ints(t.categoryIds), tagIds: ints(t.tagIds) };
    }
  }
  if (!title && !excerpt && newTags.length === 0 && Object.keys(taxonomyByChannelId).length === 0) return null;
  return { title, excerpt, status, newTags, taxonomyByChannelId };
}
