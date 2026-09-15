import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Server-side contract for Instagram Story posts.
 *
 * Asserted at the SOURCE level (house pattern — see video-thumbnail-post-create
 * and analytics-platform-filter): post.create/update are long mutations whose
 * story behaviour is a sequence of guards, and what must not regress is that each
 * guard EXISTS and runs before the value is trusted. A mocked-Prisma call would
 * exercise one happy path and miss a removed guard entirely.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const postRouter = readFileSync(join(ROOT, "packages/api/src/routers/post.router.ts"), "utf8");
const analyticsRouter = readFileSync(join(ROOT, "packages/api/src/routers/analytics.router.ts"), "utf8");

describe("post.create — story mode", () => {
  it("is marked by the `story` INPUT, not by client-supplied metadata", () => {
    expect(postRouter).toMatch(/story: storyInputSchema\.optional\(\)/);
    expect(postRouter).toMatch(/const isStory = !!input\.story/);
  });

  it("STRIPS a client-supplied instagramStory from the passthrough metadata", () => {
    // `metadata` is .passthrough(), so without this a client could write the story
    // marker directly and skip every check below while still being treated as a
    // story downstream.
    expect(postRouter).toMatch(/instagramStory: _rawStory/);
    expect(postRouter).toMatch(/if \(isStory\) out\.instagramStory = \{ mentions: storyMentions \}/);
  });

  it("validates mentions server-side and names the invalid ones", () => {
    expect(postRouter).toMatch(/normalizeStoryMentions\(input\.story\.mentions\)/);
    expect(postRouter).toMatch(/aren't valid Instagram usernames/);
  });

  it("enforces Instagram-only channels and one media AFTER the ownership check", () => {
    const ownership = postRouter.indexOf("Some selected channels are no longer available (they were removed");
    const storyCheck = postRouter.indexOf("validateStoryPost({");
    expect(ownership).toBeGreaterThan(-1);
    expect(storyCheck).toBeGreaterThan(ownership);
  });

  it("forces format STORY on every target of a story post", () => {
    expect(postRouter).toMatch(/format: \(isStory \? "STORY" : \(formats\?\.\[channelId\] \?\? null\)\) as any/);
  });

  it("keeps the per-channel picker map only where it can be true", () => {
    // The stale-picker trap: attach video → pick Story → remove video → attach
    // image → publish would otherwise post an image STORY from a normal post.
    expect(postRouter).toMatch(/sanitizeFormatByChannelId\(input\.formatByChannelId, ownedChannels, hasVideoMedia\)/);
  });

  it("never carries a cover into a story (Meta rejects cover_url on STORIES)", () => {
    expect(postRouter).toMatch(/const thumbMediaId = isStory\s*\?\s*undefined/);
  });

  it("turns off unique captions for a story — it displays none", () => {
    expect(postRouter).toMatch(/uniqueCaptions: isStory \? false : input\.uniqueCaptions/);
  });

  it("allows empty content ONLY for a story", () => {
    expect(postRouter).toMatch(/content: z\.string\(\),/);
    expect(postRouter).toMatch(/if \(!isStory && input\.content\.trim\(\)\.length === 0\)/);
  });
});

describe("post.update — a story stays a story", () => {
  it("SELECTS format on the existing targets", () => {
    // Recreating targets with channelId+status alone dropped the format, which
    // silently republished a Story as a Reel.
    expect(postRouter).toMatch(/targets: \{ select: \{ channelId: true, format: true \} \}/);
  });

  it("CARRIES the format onto every recreated target", () => {
    expect(postRouter).toMatch(/format: formatForReplacedTarget\(channelId, existing\.targets, isStoryPost\) as any/);
  });

  it("detects a story by EITHER marker — the mode block or an existing STORY target", () => {
    // The per-channel picker route predates story mode and writes no marker.
    expect(postRouter).toMatch(
      /isStoryModeMetadata\(existing\.metadata\) \|\| existing\.targets\.some\(\(t\) => t\.format === "STORY"\)/
    );
  });

  it("re-checks Instagram-only channels on the Add-channel path", () => {
    expect(postRouter).toMatch(/if \(isStoryPost\) \{\s*const storyError = validateStoryPost/);
  });

  it("allows empty content on a story but keeps the rule for everything else", () => {
    expect(postRouter).toMatch(/content: z\.string\(\)\.optional\(\)/);
    expect(postRouter).toMatch(/if \(!isStoryPost && input\.content !== undefined/);
  });
});

describe("post.publishNow — story media guard", () => {
  it("refuses a story with no media, or with more than one", () => {
    expect(postRouter).toMatch(/mediaCount: post\._count\.mediaAttachments/);
  });
});

describe("analytics — expired stories are not measured", () => {
  it("Sync Now applies the SAME shared exclusion the worker crons use", () => {
    expect(analyticsRouter).toMatch(/excludeExpiredStoriesWhere/);
    expect(analyticsRouter).toMatch(/from "@postautomation\/queue"/);
  });

  it("Reports at_age hides stories in the 7d/15d/30d windows", () => {
    // A story has no checkpoint there by design; listing one prints a permanent
    // all-"—" row that reads like a MISSED capture.
    expect(analyticsRouter).toMatch(/mode === "at_age" && window !== "24h"/);
    // IS DISTINCT FROM, never <> — nearly every legacy target has format NULL.
    expect(analyticsRouter).toMatch(/pt\.format IS DISTINCT FROM 'STORY'/);
    expect(analyticsRouter).toMatch(/\$\{storyAtAgeFilter\}/);
  });
});
