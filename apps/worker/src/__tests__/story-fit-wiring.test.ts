import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level contract for how the 9:16 story fit is wired (2026-09-16).
 *
 * Ordering is the whole point here, and no mocked publish exercises it:
 * a SECOND ffmpeg pass per target is the 2026-08-07 incident that collapsed a
 * 39-channel publish, so the video padding must ride inside the existing
 * overlay encode, and the image step must sit after it.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const worker = strip(readFileSync(join(ROOT, "apps/worker/src/workers/post-publish.worker.ts"), "utf8"));
const overlay = strip(readFileSync(join(ROOT, "apps/worker/src/lib/video-overlay.ts"), "utf8"));

describe("video: padding rides inside the existing encode", () => {
  it("passes the story flag to the overlay instead of adding a second pass", () => {
    expect(worker).toMatch(/storyCanvas: publishesAsStory/);
    // No separate ffmpeg invocation for stories anywhere in the worker.
    expect(worker).not.toMatch(/buildStoryVideoArgs/);
  });

  it("reshapes only what actually PUBLISHES as a story, never the format label alone", () => {
    // A legacy per-channel-picker post with 2 attachments publishes as a
    // CAROUSEL (instagram.provider.ts sends >1 media there), so padding its
    // slides would silently change what the user published.
    expect(worker).toMatch(
      /const publishesAsStory = isStoryTarget && postTarget\.post\.mediaAttachments\.length === 1;/
    );
    expect(worker).not.toMatch(/storyCanvas: isStoryTarget/);
  });

  it("says so when a story video could NOT be padded, instead of failing silently", () => {
    expect(worker).toMatch(/story 9:16 canvas NOT applied/);
  });

  it("the overlay splices the canvas into the FRONT of its own filter graph", () => {
    expect(overlay).toMatch(/filters\.push\(buildStoryCanvasFilter\("\[0:v\]", "\[vfit\]"\)\)/);
    expect(overlay).toMatch(/const baseLabel = storyCanvas \? "\[vfit\]" : "\[0:v\]"/);
    // Everything downstream draws on the canvas, so the watermark lands inside it.
    expect(overlay).toMatch(/\$\{baseLabel\}\[logo\]overlay=/);
    expect(overlay).toMatch(/const inputLabel = \(hasLogo \|\| channelName\) \? "\[vlogo\]" : baseLabel/);
  });

  it("a story with no watermark and no text still produces an output stream", () => {
    expect(overlay).toMatch(/\} else if \(storyCanvas\) \{[\s\S]*?\[vfit\]null\[vout\]/);
  });

  it("stays inert for every non-story publish", () => {
    expect(overlay).toMatch(/storyCanvas = false,/);
    expect(overlay).toMatch(/if \(!text && !logoUrl && !channelName && !storyCanvas\) return videoUrl;/);
  });
});

describe("images: fitted after the overlay, fail-open", () => {
  it("runs the image fit AFTER the overlay block and BEFORE the AI-image block", () => {
    const overlayBlock = worker.indexOf("processVideoOverlay");
    const fit = worker.indexOf("ensureStoryImageUrl");
    const aiImage = worker.indexOf("No media for ${platform} — auto-generating AI image");
    expect(overlayBlock).toBeGreaterThan(-1);
    expect(fit).toBeGreaterThan(overlayBlock);
    expect(fit).toBeLessThan(aiImage);
  });

  it("only touches story targets on the two platforms that have stories", () => {
    expect(worker).toMatch(/if \(publishesAsStory && \["INSTAGRAM", "FACEBOOK"\]\.includes\(platform\)\)/);
  });

  it("skips video here — it was already padded in the encode above", () => {
    expect(worker).toMatch(/if \(mediaTypes\[i\]\?\.startsWith\("video\/"\) \|\| !mediaId\) \{/);
  });

  it("never fails a publish over a cosmetic step", () => {
    expect(worker).toMatch(/Story image fit failed, posting original/);
  });
});

describe("analytics: no guaranteed-failing captures for a Facebook story", () => {
  it("skips at-age checkpoints for a FACEBOOK story only", () => {
    expect(worker).toMatch(/const skipAtAgeCheckpoints = isStoryTarget && platform === "FACEBOOK"/);
    expect(worker).toMatch(/if \(result\.platformPostId && !skipAtAgeCheckpoints\)/);
  });

  it("leaves Instagram stories and every other format on their existing schedule", () => {
    expect(worker).toMatch(/atAgeWindowsForFormat\(postTarget\.format\)/);
  });
});
