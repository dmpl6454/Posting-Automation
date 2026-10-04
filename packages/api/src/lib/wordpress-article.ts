import { z } from "zod";

/**
 * Server-side rules for WordPress ARTICLE posts (Compose → Article mode,
 * 2026-10-04).
 *
 * An article is an ordinary Post whose `metadata.wordpressArticle` block carries
 * the title, excerpt, WordPress status and taxonomy. `Post.content` holds the
 * body as Markdown; the provider renders it (markdown-lite) at publish time.
 * The marker's PRESENCE is what makes the post an article — exactly the pattern
 * `metadata.instagramStory` uses — and only `post.create`'s `article` input may
 * write it (the client passthrough strips the key).
 *
 * Taxonomy term ids are PER SITE. The client sends them keyed by CHANNEL id (the
 * only handle it has); the server re-keys them by the channel's normalised site
 * URL (`Channel.metadata.siteUrl`), which is what the provider sees at publish
 * time. A category id for site A is never sent to site B.
 */

export const ARTICLE_PLATFORMS = ["WORDPRESS"] as const;
export const ARTICLE_TITLE_MAX = 200;
export const ARTICLE_EXCERPT_MAX = 1000;
export const ARTICLE_STATUSES = ["publish", "draft", "pending"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export function isArticlePlatform(platform: string): boolean {
  return (ARTICLE_PLATFORMS as readonly string[]).includes(platform);
}

const termIds = z.array(z.number().int().positive()).max(100).default([]);

/** Raw client input, bounded so a hostile payload cannot be large. */
export const articleInputSchema = z.object({
  title: z.string().max(ARTICLE_TITLE_MAX * 2),
  excerpt: z.string().max(ARTICLE_EXCERPT_MAX * 2).optional(),
  status: z.enum(ARTICLE_STATUSES).default("publish"),
  /** Tag NAMES to create or reuse on every target site. */
  newTags: z.array(z.string().max(100)).max(50).default([]),
  /** Existing term ids, keyed by channel id (re-keyed by site server-side). */
  taxonomyByChannelId: z.record(z.object({ categoryIds: termIds, tagIds: termIds })).default({}),
});
export type ArticleInput = z.infer<typeof articleInputSchema>;

/**
 * Returns an actionable message, or null when the article post is valid.
 *
 * `scheduling` = the post will actually publish. A DRAFT may be saved with an
 * empty body (the author comes back to it), but never without a title — the
 * title is what identifies it in every list — and never to a non-WordPress
 * channel, because nothing else can receive an article.
 */
export function validateArticlePost(input: {
  channels: Array<{ id: string; platform: string; name?: string | null }>;
  title: string;
  bodyLength: number;
  scheduling: boolean;
}): string | null {
  const foreign = input.channels.filter((c) => !isArticlePlatform(c.platform));
  if (foreign.length > 0) {
    const names = foreign.map((c) => c.name || c.id).join(", ");
    return `Articles can only be published to WordPress sites. Remove: ${names}.`;
  }
  const title = input.title.trim();
  if (!title) return "Give the article a title.";
  if (title.length > ARTICLE_TITLE_MAX) return `The title is too long (max ${ARTICLE_TITLE_MAX} characters).`;
  if (input.scheduling && input.bodyLength === 0) return "Write the article body before publishing.";
  return null;
}

/** Is this post a WordPress article? Reads the marker post.create writes. */
export function isArticleModeMetadata(metadata: unknown): boolean {
  const v = (metadata as { wordpressArticle?: unknown } | null | undefined)?.wordpressArticle;
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { title?: unknown }).title === "string";
}

export interface StoredWordPressArticle {
  title: string;
  excerpt?: string;
  status: ArticleStatus;
  newTags: string[];
  taxonomyBySite: Record<string, { categoryIds: number[]; tagIds: number[] }>;
}

/**
 * Build the block that is stored on the post. `siteUrlByChannelId` comes from
 * the owned channels' metadata; a channel id the client named that is NOT a
 * target of this post (or has no site URL) is dropped — ids are never trusted
 * past the ownership check.
 */
export function buildStoredArticle(
  input: ArticleInput,
  siteUrlByChannelId: Record<string, string | undefined>
): StoredWordPressArticle {
  const taxonomyBySite: StoredWordPressArticle["taxonomyBySite"] = {};
  for (const [channelId, tax] of Object.entries(input.taxonomyByChannelId)) {
    const site = siteUrlByChannelId[channelId];
    if (!site) continue;
    const prev = taxonomyBySite[site] ?? { categoryIds: [], tagIds: [] };
    taxonomyBySite[site] = {
      categoryIds: [...new Set([...prev.categoryIds, ...tax.categoryIds])],
      tagIds: [...new Set([...prev.tagIds, ...tax.tagIds])],
    };
  }
  const newTags = [...new Set(input.newTags.map((t) => t.trim()).filter(Boolean))];
  const excerpt = input.excerpt?.trim().slice(0, ARTICLE_EXCERPT_MAX);
  return {
    title: input.title.trim().slice(0, ARTICLE_TITLE_MAX),
    ...(excerpt ? { excerpt } : {}),
    status: input.status,
    newTags,
    taxonomyBySite,
  };
}

/** The self-hosted site URL a WordPress channel was connected with, or undefined. */
export function channelSiteUrl(metadata: unknown): string | undefined {
  const m = metadata as { kind?: unknown; siteUrl?: unknown } | null | undefined;
  return m?.kind === "self-hosted" && typeof m.siteUrl === "string" && m.siteUrl ? m.siteUrl : undefined;
}
