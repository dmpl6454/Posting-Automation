import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Compose's WordPress Article mode (2026-10-04), asserted at the SOURCE level
 * (house pattern — see story-ui-contract.test.ts). Each rule locks a way the
 * UI could quietly promise something the publish does not do, or let a
 * Post-mode control leak into an article.
 */
const ROOT = join(__dirname, "..", "..", "..");
const compose = readFileSync(join(ROOT, "apps/web/components/content-agent/ComposeTab.tsx"), "utf8");
const previewRaw = readFileSync(join(ROOT, "apps/web/components/previews/wordpress-article-preview.tsx"), "utf8");
const preview = previewRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const picker = readFileSync(join(ROOT, "apps/web/components/content-agent/ArticleTaxonomyPicker.tsx"), "utf8");

describe("Article mode is one derived flag", () => {
  it("derives isArticleMode from postType and offers the third tab", () => {
    expect(compose).toMatch(/const isArticleMode = postType === "article"/);
    expect(compose).toContain('(["post", "story", "article"] as PostType[])');
    expect(compose).toContain('data-testid="article-mode-banner"');
  });
});

describe("what an article sends", () => {
  it("BOTH create paths carry the article marker, built from the live selection", () => {
    expect(compose.match(/\.\.\.\(isArticleMode && \{ article: buildArticlePayload\(article, selectedChannels\) \}\)/g)).toHaveLength(2);
  });
  it("never sends per-channel captions, unique captions or the format map for an article", () => {
    expect(compose.match(/!isStoryMode && !isArticleMode && customCaptions/g)).toHaveLength(2);
    expect(compose).toContain("!isStoryMode && !isArticleMode && uniqueCaptions && selectedChannels.length > 1");
    expect(compose).toContain("!isStoryMode && !isArticleMode && Object.keys(formatByChannelId).length > 0");
  });
  it("takes neither a video cover nor YouTube metadata (both create paths)", () => {
    expect(compose.match(/const md = isStoryMode \|\| isArticleMode\s*\?/g)).toHaveLength(2);
  });
});

describe("one predicate gates submit, both buttons and the banner", () => {
  it("articleBlock is derived once and read by the handler, the buttons and the visible notice", () => {
    expect(compose).toMatch(/const articleBlock = isArticleMode\s*\?\s*articleBlockReason\(\{/);
    expect(compose).toMatch(/if \(articleBlock\) \{\s*toast\(\{ title: "Article not ready"/);
    expect(compose.match(/\|\| !!articleBlock/g)!.length).toBeGreaterThanOrEqual(2);
    expect(compose.match(/youtubeBlockReason \?\? storyBlock \?\? articleBlock \?\? captionBlock/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("the shared caption rule is off for an article (the body is validated by articleBlock)", () => {
    expect(compose).toMatch(/const captionBlock = isStoryMode \|\| isArticleMode\s*\?\s*null/);
  });
});

describe("channel scoping", () => {
  it("the picker ignores the platform filter, hides its pills, and prunes to WordPress on every path", () => {
    expect(compose).toContain("if (isStoryMode || isArticleMode || counts.length < 2) return null;");
    expect(compose).toContain("filterByPlatform(modeScoped, isStoryMode || isArticleMode ? null : platformFilter)");
    expect(compose).toMatch(/if \(postType === "article"\) \{\s*const \{ next \} = pruneSelectionForArticle\(reconciled/);
    expect(compose).toMatch(/next === "story"\s*\?\s*pruneSelectionForStory\(selectedChannels, channels as any\[\]\)\s*:\s*pruneSelectionForArticle\(/);
  });
});

describe("mode does not leak", () => {
  it("article fields reset after a successful create, alongside the mode", () => {
    expect(compose).toMatch(/setPostType\("post"\);\s*setFormatByChannelId\(\{\}\);[\s\S]{0,200}setArticle\(EMPTY_ARTICLE\);/);
  });
  it("a restored draft's article block is re-validated, never trusted", () => {
    expect(compose).toContain("const restoredArticle = sanitizeRestoredArticle(saved.draft.article);");
  });
  it("Post-mode controls hidden: Create with AI, carousel generator, video upload, captions card", () => {
    expect(compose).toContain("{!isStoryMode && !isArticleMode && (\n          <>\n          {/* Create with AI");
    expect(compose).toContain("{!hasYouTube && !hasVideoAttached && !isStoryMode && !isArticleMode && (");
    expect(compose).toMatch(/\{!isArticleMode && \(\s*<Button\s*variant=\{hasYouTube \? "default" : "outline"\}/);
    expect(compose).toContain("{!isStoryMode && !isArticleMode && selectedChannels.length > 1 && (");
  });
});

describe("preview", () => {
  it("article mode renders WordPressArticlePreview INSTEAD of the switcher, with the body as Markdown", () => {
    expect(compose).toMatch(/\) : isArticleMode \? \([\s\S]{0,400}<WordPressArticlePreview\s+title=\{article\.title\}\s+body=\{content\}/);
  });
  it("the preview uses the SAME converter the worker uses (the byte-identical replica) and never a bare <img>", () => {
    expect(preview).toContain('from "~/lib/markdown-lite"');
    expect(preview).not.toMatch(/<img\b/);
    expect(preview).toContain("<PreviewMedia");
  });
});

describe("taxonomy picker", () => {
  it("loads per CHANNEL through the tRPC query, cached, and keys the selection by channel id", () => {
    expect(picker).toContain("trpc.channel.wordpressTaxonomies.useQuery(");
    expect(picker).toContain("staleTime: 5 * 60 * 1000");
    expect(compose).toContain("selection={article.taxonomyByChannelId[c.id] ?? { categoryIds: [], tagIds: [] }}");
  });
});
