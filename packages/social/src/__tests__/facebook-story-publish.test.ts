import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level contract for Facebook Page stories (2026-09-16).
 *
 * Asserted at the SOURCE like instagram-story-router.test.ts: what must not
 * regress is that each guard EXISTS and runs in the right order. Comments are
 * stripped first, so the explanatory notes — which quote the very strings under
 * test — can neither satisfy nor fail an assertion.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const provider = readFileSync(join(ROOT, "packages/social/src/providers/facebook.provider.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("FacebookProvider — story routing", () => {
  it("routes a STORY target away from the feed paths, UNCONDITIONALLY", () => {
    // Until this branch existed a FACEBOOK target with format STORY silently
    // published an ordinary feed post: nothing here read metadata.format.
    // ⚠️ And gating the route on media let a media-less story fall through to
    // the TEXT branch, publishing the story's private note as a public Page post.
    expect(provider).toMatch(/if \(isStoryFormat\(payload\.metadata\)\) \{/);
    expect(provider).not.toMatch(/isStoryFormat\(payload\.metadata\) && payload\.mediaUrls/);
    expect(provider).toMatch(/A Facebook story requires one image or video/);
    const route = provider.indexOf("return this.publishStory(tokens, payload, pageId)");
    const feed = provider.indexOf("return this.publishPostWithMedia(tokens, payload, pageId)");
    expect(route).toBeGreaterThan(-1);
    expect(route).toBeLessThan(feed);
  });

  it("uses the documented story edges, not the feed", () => {
    expect(provider).toMatch(/const edge = kind === "VIDEO" \? "video_stories" : "photo_stories"/);
    expect(provider).toMatch(/upload_phase: "start"/);
    expect(provider).toMatch(/upload_phase: "finish"/);
  });

  it("uploads the photo UNPUBLISHED first — publishing it would make a feed post", () => {
    expect(provider).toMatch(/uploadPhotoToFacebook\(tokens, pageId, mediaUrl, false\)/);
  });

  it("sends the video to the separate upload host with the documented headers", () => {
    expect(provider).toMatch(/Authorization: `OAuth \$\{tokens\.accessToken\}`/);
    expect(provider).toMatch(/file_url: mediaUrl/);
  });
});

describe("FacebookProvider — duplicate prevention", () => {
  it("checkpoints the uploaded media id BEFORE the story is created, and the write is FATAL", () => {
    const checkpoint = provider.indexOf("payload.onCheckpoint?.({");
    const create = provider.indexOf("return await this.createStoryFromMedia(tokens, pageId, mediaId, kind)");
    expect(checkpoint).toBeGreaterThan(-1);
    expect(checkpoint).toBeLessThan(create);
    expect(provider).toMatch(/refusing to publish a story that a retry could not find/);
    expect(provider).toMatch(/fbStoryMedia: \{ id: mediaId, kind, createdAt/);
  });

  it("adopts an existing story by OUR media id instead of publishing again", () => {
    expect(provider).toMatch(
      /const existing = await this\.findStoryByMediaId\(tokens, pageId, checkpoint\.id, checkpoint\.createdAt\)/
    );
    expect(provider).toMatch(/adopted: true/);
  });

  it("THROWS when the story listing cannot be read — unreadable is not 'nothing published'", () => {
    expect(provider).toMatch(/throw new Error\(`Facebook story listing failed/);
  });

  it("reuses the same uploaded media while it is still inside Facebook's 24h window", () => {
    expect(provider).toMatch(/if \(!isFbStoryMediaExpired\(checkpoint\)\) \{/);
  });
});

describe("FacebookProvider — no story tagging", () => {
  it("sends no tags on either story edge: Meta documents none for Page stories", () => {
    const story = provider.slice(provider.indexOf("private async publishStory"), provider.indexOf("async deletePost"));
    expect(story).not.toMatch(/user_tags/);
    expect(story).not.toMatch(/\btags\b/);
    expect(story).not.toMatch(/tag_uid/);
  });
});

describe("FacebookProvider — the non-story paths are untouched", () => {
  it("still publishes feed photos as PUBLISHED and keeps the text-only path", () => {
    expect(provider).toMatch(/uploadPhotoToFacebook\(tokens, pageId, firstUrl, true, payload\.content\)/);
    expect(provider).toMatch(/\$\{pageId\}\/feed/);
  });
});

describe("FacebookProvider — a story is never reconciled by caption", () => {
  it("findExistingPost returns null for a story rather than matching the wrong post", () => {
    // A story has no caption and is not on the published_posts edge, so caption
    // matching can only return an unrelated Page post that happens to share the
    // note text.
    expect(provider).toMatch(/if \(isStoryFormat\(payload\.metadata\)\) return null;/);
  });

  it("the unknown-outcome resolver looks the story up by its media id", () => {
    const resolver = provider.slice(provider.indexOf("private async resolveUnknownPublish"));
    expect(resolver).toMatch(/readFbStoryCheckpoint\(payload\.metadata\)/);
    expect(resolver).toMatch(/findStoryByMediaId\(tokens, pageId, checkpoint\.id, checkpoint\.createdAt\)/);
    expect(resolver).toMatch(/AmbiguousPublishError/);
  });

  it("treats a 5xx or an unreadable body as UNKNOWN, never as a definite failure", () => {
    // A definite failure makes the target re-claimable, and the retry publishes
    // a SECOND story.
    expect(provider).toMatch(/if \(res\.status >= 500 \|\| bodyUnreadable\) \{/);
    expect(provider).toMatch(/did not confirm whether this story published/);
  });

  it("narrows the adoption listing by time and follows pages before concluding anything", () => {
    expect(provider).toMatch(/&since=\$\{Math\.max\(0, sinceUnix - Math\.ceil\(RECONCILE_SKEW_MS \/ 1000\)\)\}/);
    expect(provider).toMatch(/for \(let page = 0; page < FB_STORY_LIST_MAX_PAGES; page\+\+\)/);
    // Running out of pages is not "nothing was published".
    expect(provider).toMatch(/did not resolve media \$\{mediaId\} within/);
  });
});
