import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  articleInputSchema,
  validateArticlePost,
  isArticleModeMetadata,
  buildStoredArticle,
  channelSiteUrl,
  ARTICLE_TITLE_MAX,
} from "../lib/wordpress-article";

const wp = (id: string) => ({ id, platform: "WORDPRESS", name: `site-${id}` });

describe("validateArticlePost", () => {
  it("accepts WordPress-only channels with a title and a body", () => {
    expect(validateArticlePost({ channels: [wp("a"), wp("b")], title: "T", bodyLength: 10, scheduling: true })).toBeNull();
  });
  it("names non-WordPress channels", () => {
    const err = validateArticlePost({
      channels: [wp("a"), { id: "f", platform: "FACEBOOK", name: "My Page" }],
      title: "T",
      bodyLength: 1,
      scheduling: true,
    });
    expect(err).toMatch(/WordPress sites/);
    expect(err).toContain("My Page");
  });
  it("requires a title always, and a body only to publish (a draft may be empty)", () => {
    expect(validateArticlePost({ channels: [wp("a")], title: "  ", bodyLength: 5, scheduling: false })).toMatch(/title/);
    expect(validateArticlePost({ channels: [wp("a")], title: "x".repeat(ARTICLE_TITLE_MAX + 1), bodyLength: 5, scheduling: false })).toMatch(/too long/);
    expect(validateArticlePost({ channels: [wp("a")], title: "T", bodyLength: 0, scheduling: true })).toMatch(/body/);
    expect(validateArticlePost({ channels: [wp("a")], title: "T", bodyLength: 0, scheduling: false })).toBeNull();
    expect(validateArticlePost({ channels: [], title: "T", bodyLength: 0, scheduling: false })).toBeNull();
  });
});

describe("buildStoredArticle re-keys taxonomy by SITE and drops unknown channels", () => {
  it("merges two channels on the same site, ignores a channel with no site url", () => {
    const input = articleInputSchema.parse({
      title: "  Title  ",
      excerpt: "  ex  ",
      status: "draft",
      newTags: [" a ", "b", "a", ""],
      taxonomyByChannelId: {
        c1: { categoryIds: [1, 2], tagIds: [9] },
        c2: { categoryIds: [2, 3], tagIds: [] },
        c3: { categoryIds: [77], tagIds: [77] }, // not a target of this post
      },
    });
    expect(
      buildStoredArticle(input, { c1: "https://s.one", c2: "https://s.one", c3: undefined })
    ).toEqual({
      title: "Title",
      excerpt: "ex",
      status: "draft",
      newTags: ["a", "b"],
      taxonomyBySite: { "https://s.one": { categoryIds: [1, 2, 3], tagIds: [9] } },
    });
  });
  it("defaults: status publish, no excerpt key when blank", () => {
    const stored = buildStoredArticle(articleInputSchema.parse({ title: "T", excerpt: "  " }), {});
    expect(stored).toEqual({ title: "T", status: "publish", newTags: [], taxonomyBySite: {} });
    expect("excerpt" in stored).toBe(false);
  });
  it("rejects a hostile payload shape at the schema", () => {
    expect(() => articleInputSchema.parse({ title: "T", status: "private" })).toThrow();
    expect(() => articleInputSchema.parse({ title: "T", taxonomyByChannelId: { c: { categoryIds: [-1] } } })).toThrow();
    expect(() => articleInputSchema.parse({ title: "T", newTags: Array(51).fill("x") })).toThrow();
  });
});

describe("marker + site url readers", () => {
  it("isArticleModeMetadata reads only a well-formed marker", () => {
    expect(isArticleModeMetadata({ wordpressArticle: { title: "T" } })).toBe(true);
    expect(isArticleModeMetadata({ wordpressArticle: {} })).toBe(false);
    expect(isArticleModeMetadata({ wordpressArticle: "T" })).toBe(false);
    expect(isArticleModeMetadata(null)).toBe(false);
  });
  it("channelSiteUrl requires the self-hosted kind", () => {
    expect(channelSiteUrl({ kind: "self-hosted", siteUrl: "https://s" })).toBe("https://s");
    expect(channelSiteUrl({ siteUrl: "https://s" })).toBeUndefined();
    expect(channelSiteUrl({ kind: "self-hosted", blog_id: 1 })).toBeUndefined();
  });
});

describe("post.router wiring (source contract)", () => {
  const router = readFileSync(join(__dirname, "../routers/post.router.ts"), "utf8");
  it("strips a client-written wordpressArticle marker and writes only the server-built block", () => {
    expect(router).toMatch(/wordpressArticle: _rawArticle,/);
    expect(router).toContain("if (storedArticle) out.wordpressArticle = storedArticle;");
  });
  it("runs the article rules AFTER the ownership check and re-keys taxonomy by site", () => {
    const owned = router.indexOf("const ownedChannels = await ctx.prisma.channel.findMany");
    const rules = router.indexOf("validateArticlePost({\n          channels: ownedChannels,");
    expect(owned).toBeGreaterThan(0);
    expect(rules).toBeGreaterThan(owned);
    expect(router).toContain("channelSiteUrl(r.metadata)");
  });
  it("an article never gets per-channel captions, caption fan-out or a per-channel format", () => {
    expect(router).toContain("uniqueCaptions: isStory || isArticle ? false : input.uniqueCaptions");
    expect(router).toMatch(/const formats = isStory \|\| isArticle\s*\?\s*undefined/);
    expect(router).toMatch(/const overrides = isStory \|\| isArticle\s*\?\s*undefined/);
  });
  it("post.update refuses adding a non-WordPress channel to an article", () => {
    expect(router).toContain("const isArticlePost = isArticleModeMetadata(existing.metadata);");
    expect(router).toMatch(/if \(isArticlePost && channelIds\) \{/);
  });
  it("story and article are mutually exclusive", () => {
    expect(router).toContain("A post cannot be both a story and an article.");
  });
});

describe("channel.wordpressTaxonomies (source contract)", () => {
  const router = readFileSync(join(__dirname, "../routers/channel.router.ts"), "utf8");
  it("loads the channel DIRECTLY (decrypting), re-checks the org, and contacts the site only via userHostFetch", () => {
    const start = router.indexOf("wordpressTaxonomies: orgProcedure");
    const end = router.indexOf("platformAuthInfo: orgProcedure");
    const block = router.slice(start, end);
    expect(block).toContain("ctx.prisma.channel.findUnique({ where: { id: input.channelId } })");
    expect(block).toContain("channel.organizationId !== ctx.organizationId");
    expect(block).toContain("userHostFetch(");
    expect(block).not.toMatch(/[^t]fetch\(/); // no plain fetch to a user-named host
    expect(block).toContain("createRateLimitMiddleware(wordpressTaxonomyRateLimiter)");
  });
});
