/**
 * WordPress ARTICLE posts (2026-10-04) — the shape `post.create` writes to
 * `Post.metadata.wordpressArticle` when Compose is in Article mode, read back
 * here by the provider. Its PRESENCE is what makes a WordPress publish an
 * article; absent, the provider's legacy caption path runs byte-for-byte.
 *
 * Everything is re-validated on the way out of the database: a loose shape
 * (hand-edited metadata, an older build) must degrade to "not an article", never
 * crash a publish. Taxonomy term ids are PER SITE — a category id from one
 * WordPress install means nothing on another — so they are keyed by the site's
 * normalised URL, which is exactly `Channel.metadata.siteUrl`.
 */

export const WORDPRESS_ARTICLE_STATUSES = ["publish", "draft", "pending"] as const;
export type WordPressArticleStatus = (typeof WORDPRESS_ARTICLE_STATUSES)[number];

export interface WordPressSiteTaxonomy {
  categoryIds: number[];
  tagIds: number[];
}

export interface WordPressArticleMeta {
  title: string;
  excerpt?: string;
  status: WordPressArticleStatus;
  /** Tag NAMES to create (or reuse) on every target site. */
  newTags: string[];
  /** Existing term ids, keyed by the site's normalised URL. */
  taxonomyBySite: Record<string, WordPressSiteTaxonomy>;
}

const isIntArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0);

/** Reads the marker; null when absent or unusable. Never throws. */
export function readWordPressArticle(metadata: unknown): WordPressArticleMeta | null {
  const raw = (metadata as { wordpressArticle?: unknown } | null | undefined)?.wordpressArticle;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (!title) return null;
  const status = (WORDPRESS_ARTICLE_STATUSES as readonly string[]).includes(a.status as string)
    ? (a.status as WordPressArticleStatus)
    : "publish";
  const excerpt = typeof a.excerpt === "string" && a.excerpt.trim() ? a.excerpt.trim() : undefined;
  const newTags = Array.isArray(a.newTags)
    ? [...new Set(a.newTags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))]
    : [];
  const taxonomyBySite: Record<string, WordPressSiteTaxonomy> = {};
  if (a.taxonomyBySite && typeof a.taxonomyBySite === "object" && !Array.isArray(a.taxonomyBySite)) {
    for (const [site, tax] of Object.entries(a.taxonomyBySite as Record<string, unknown>)) {
      if (!tax || typeof tax !== "object") continue;
      const t = tax as Record<string, unknown>;
      taxonomyBySite[site] = {
        categoryIds: isIntArray(t.categoryIds) ? [...new Set(t.categoryIds)] : [],
        tagIds: isIntArray(t.tagIds) ? [...new Set(t.tagIds)] : [],
      };
    }
  }
  return { title: title.slice(0, 200), excerpt, status, newTags, taxonomyBySite };
}

/** `<figure>` blocks for the images that are NOT the featured image. */
export function imageFiguresHtml(sourceUrls: string[]): string {
  const safe = sourceUrls.filter((u) => /^https?:\/\//i.test(u));
  if (safe.length === 0) return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return safe.map((u) => `<figure class="wp-block-image"><img src="${esc(u)}" alt=""></figure>`).join("\n");
}
