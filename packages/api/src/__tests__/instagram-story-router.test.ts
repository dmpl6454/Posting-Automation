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

  it("allows empty content for a story, or when every channel has its own caption", () => {
    expect(postRouter).toMatch(/content: z\.string\(\),/);
    // 2026-09-21: the rule widened — an empty shared caption is also allowed when
    // EVERY selected channel carries its own (owner-reported: per-channel captions
    // filled in, shared box empty, no way to publish). A non-story post with
    // neither is still refused, which is what this test exists to protect.
    expect(postRouter).toMatch(/!isStory &&\s*input\.content\.trim\(\)\.length === 0/);
    expect(postRouter).toMatch(/!everyChannelHasOwnCaption\(/);
  });
});

describe("post.update — a story stays a story", () => {
  it("SELECTS format on the existing targets", () => {
    // Recreating targets with channelId+status alone dropped the format, which
    // silently republished a Story as a Reel.
    // 2026-09-18: the select also carries contentOverride (per-channel captions
    // were being wiped the same way) — see caption-overrides.test.ts.
    expect(postRouter).toMatch(/targets: \{ select: \{ channelId: true, format: true, contentOverride: true \} \}/);
  });

  it("CARRIES the format onto every recreated target", () => {
    expect(postRouter).toMatch(/format: formatForReplacedTarget\(channelId, existing\.targets, isStoryPost\) as any/);
  });

  it("keys story rules on the story-MODE marker ONLY, never on a STORY target", () => {
    // A per-channel picker post (IG set to Story beside a Facebook Page) carries
    // STORY targets without being a story post. Treating it as one blocked every
    // Retry and every channel edit, with no way out.
    expect(postRouter).toMatch(/const isStoryPost = isStoryModeMetadata\(existing\.metadata\);/);
    expect(postRouter).not.toMatch(/isStoryModeMetadata\(existing\.metadata\) \|\| existing\.targets\.some/);
    expect(postRouter).toMatch(/if \(isStoryModeMetadata\(post\.metadata\)\) \{/);
    expect(postRouter).not.toMatch(/isStoryModeMetadata\(post\.metadata\) \|\| post\.targets\.some/);
  });

  it("validates a story on EITHER route — channel replacement OR scheduling", () => {
    // It used to be nested under channelIds, so scheduling a media-less story
    // draft from the post page passed and failed minutes later.
    expect(postRouter).toMatch(/if \(isStoryPost && \(channelIds \|\| effectiveScheduledAt\)\) \{/);
    expect(postRouter).toMatch(/scheduling: !!effectiveScheduledAt/);
  });

  it("allows empty content on a story but keeps the rule for everything else", () => {
    expect(postRouter).toMatch(/content: z\.string\(\)\.optional\(\)/);
    // 2026-09-21: same widening as create, but derived from the RESULTING targets
    // (update has no captionOverrides input). A non-story post with no caption
    // anywhere is still refused.
    expect(postRouter).toMatch(/!isStoryPost &&\s*input\.content !== undefined/);
    expect(postRouter).toMatch(/!everyTargetHasOwnCaption\(resultingTargets\)/);
  });
});

describe("post.publishNow — story media guard", () => {
  it("refuses a story with no media, or with more than one", () => {
    expect(postRouter).toMatch(/mediaCount: post\._count\.mediaAttachments/);
  });
});

describe("analytics — expired stories are not measured", () => {
  it("Sync Now applies the SAME shared exclusion the worker crons use", () => {
    // 2026-09-16: widened to also skip FACEBOOK stories, which have no
    // published insights path at all — same shared fragment, same reason.
    expect(analyticsRouter).toMatch(/excludeUnmeasurableStoriesWhere/);
    expect(analyticsRouter).toMatch(/from "@postautomation\/queue"/);
  });

  it("Reports at_age hides stories in the 7d/15d/30d windows", () => {
    // A story has no checkpoint there by design; listing one prints a permanent
    // all-"—" row that reads like a MISSED capture.
    expect(analyticsRouter).toMatch(/window !== "24h"/);
    // A FACEBOOK story has no checkpoint even at 24h, so it is excluded there too —
    // NULL-safely, or every legacy NULL-format target would be dropped.
    expect(analyticsRouter).toMatch(/pt\.format IS NOT DISTINCT FROM 'STORY' AND c\.platform::text = 'FACEBOOK'/);
    // IS DISTINCT FROM, never <> — nearly every legacy target has format NULL.
    expect(analyticsRouter).toMatch(/pt\.format IS DISTINCT FROM 'STORY'/);
    expect(analyticsRouter).toMatch(/\$\{storyAtAgeFilter\}/);
  });
});

describe("bulk.bulkSchedule — a story without exactly one media is skipped, not armed", () => {
  // ⚠️ Comments stripped: the router's header doc quotes `status: "SCHEDULED"`
  // ABOVE the procedure, so a raw indexOf finds the documentation, not the write.
  const bulkRouter = readFileSync(join(ROOT, "packages/api/src/routers/bulk.router.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("checks the story-MODE marker and the media count before flipping anything", () => {
    expect(bulkRouter).toMatch(/isStoryModeMetadata\(post\.metadata\) && post\._count\.mediaAttachments !== 1/);
    const procedure = bulkRouter.indexOf("bulkSchedule: orgProcedure");
    const guard = bulkRouter.indexOf("isStoryModeMetadata(post.metadata)", procedure);
    const flip = bulkRouter.indexOf('status: "SCHEDULED"', procedure);
    expect(procedure).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(procedure);
    expect(guard).toBeLessThan(flip);
  });

  it("reports how many were skipped instead of skipping silently", () => {
    expect(bulkRouter).toMatch(/return \{ scheduled, skippedStories \}/);
  });
});
