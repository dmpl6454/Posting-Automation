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
    // `normalize` (2026-09-16) joins the nothing-to-do guard: a caller that
    // requests none of these still gets its url back untouched.
    expect(overlay).toMatch(
      /if \(!text && !logoUrl && !channelName && !storyCanvas && !normalize\) return videoUrl;/
    );
    expect(overlay).toMatch(/normalize = false,/);
  });

  it("every encode call site carries the story flag — none can publish a story unpadded", () => {
    // Two encode paths since 2026-09-16 (legacy watermark + shared normalize).
    const calls = worker.match(/processVideoOverlay\(mediaUrls\[i\]!, \{[\s\S]*?\}\);/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toMatch(/storyCanvas: publishesAsStory,/);
    expect(worker.match(/storyCanvas: publishesAsStory/g)?.length).toBe(2);
  });

  it("a normalize-only call with nothing drawn still produces an output stream", () => {
    // A normalize-only call with no canvas still needs an output stream.
    expect(overlay).toMatch(/\} else if \(normalize\) \{[\s\S]*?\[0:v\]null\[vout\]/);
  });
});

describe("watermark removal (owner decision 2026-09-16)", () => {
  it("the watermark switch is the fail-closed VIDEO_WATERMARK_ENABLED helper", () => {
    expect(worker).toMatch(/const watermarkOn = isVideoWatermarkEnabled\(\);/);
  });

  it("the Logo Library lookup only runs when the watermark will be drawn", () => {
    expect(worker).toMatch(
      /if \(watermarkOn\) \{\s*try \{\s*const logoMedia = await prisma\.media\.findFirst\(\{\s*where: \{[^}]*category: "logo"/
    );
    // …and it is the ONLY logo lookup in the worker, so nothing runs it ungated.
    expect(worker.match(/category: "logo"/g)?.length).toBe(1);
    // The logo_path fallback sits inside the same gate, before the per-media loop.
    const gate = worker.indexOf("if (watermarkOn) {");
    const fallback = worker.indexOf("logoUrl = (channelMetadata?.logo_path as string) || null;");
    const loop = worker.indexOf("const overlayText = (postTarget.post.metadata as any)?.videoOverlayText");
    expect(gate).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(gate);
    expect(fallback).toBeLessThan(loop);
  });

  it("channel name and logo are passed ONLY on the watermark path", () => {
    const watermark = worker.match(
      /else if \(plan === "watermark"\) \{[\s\S]*?(processVideoOverlay\(mediaUrls\[i\]!, \{[\s\S]*?\}\);)/
    );
    expect(watermark).not.toBeNull();
    expect(watermark![1]).toMatch(/logoUrl,/);
    expect(watermark![1]).toMatch(/channelName: channel\.name,/);
    // One and only one place burns the channel name into a video.
    expect(worker.match(/channelName: channel\.name/g)?.length).toBe(1);

    const normalize = (worker.match(/processVideoOverlay\(mediaUrls\[i\]!, \{[\s\S]*?\}\);/g) ?? []).find((c) =>
      c.includes("normalize: true")
    );
    expect(normalize).toBeDefined();
    // Any per-channel input would route the call to the per-target path.
    expect(normalize).toMatch(/logoUrl: null,/);
    expect(normalize).toMatch(/channelName: undefined,/);
    expect(normalize).not.toMatch(/channel\.name/);
    expect(normalize).not.toMatch(/logoPosition|logoSize/);
  });

  it("the plan is computed per video from the rendition flag, the story flag and the size cap", () => {
    expect(worker).toMatch(
      /const mediaIsRendition = postTarget\.post\.mediaAttachments\.map\(\(m, i\) => mediaUrls\[i\] !== m\.media\.url\);/
    );
    // Captured before any step rewrites mediaUrls.
    expect(worker.indexOf("const mediaIsRendition")).toBeLessThan(worker.indexOf("mediaUrls = processed;"));
    expect(worker).toMatch(
      /planMetaVideoPrep\(\{\s*watermarkOn,\s*hasOverlayText: !!overlayText,\s*publishesAsStory,\s*isRendition: mediaIsRendition\[i\] === true,\s*tooBig: tooBigForOverlay,\s*\}\)/
    );
  });

  it("a rendition skip returns the url unchanged, so the story warning's url-identity signal still holds", () => {
    expect(worker).toMatch(/else if \(plan === "skip-rendition"\) \{[\s\S]*?processed\.push\(mediaUrls\[i\]!\);/);
    expect(worker).toMatch(/processed\[i\] === mediaUrls\[i\]/);
  });

  it("logs the prep time per target", () => {
    expect(worker).toMatch(/video prep \$\{Date\.now\(\) - videoPrepStartedAt\}ms plan=/);
  });

  it("the overlay routes channel-less calls to the shared, cached path", () => {
    expect(overlay).toMatch(/if \(!logoUrl && !channelName\) \{\s*return runSharedMetaReady\(/);
    // Legacy per-target artifacts keep their one-off key; the shared path uses
    // the deterministic key and only falls back to a one-off key when the
    // output cannot be verified.
    expect(overlay).toMatch(/const key = `videos\/overlay_\$\{id\}\.mp4`;/);
    expect(overlay).toMatch(/const storage = planMetaReadyStorage\(inputSec, outputSec\);/);
    expect(overlay).toMatch(/if \(storage === "reject"\) \{\s*throw new Error/);
  });

  it("the shared path verifies the download length before an artifact can be cached", () => {
    expect(overlay).toMatch(/downloadVideo\(videoUrl, inputPath, o\.maxBytes, true\)/);
    expect(overlay).toMatch(/if \(written !== len\) \{\s*throw new Error/);
  });

  it("the shared path never treats a failed HeadObject as a cache hit", () => {
    expect(overlay).toMatch(/catch \(err: any\) \{[\s\S]*?return false;\s*\}\s*\}/);
  });

  it("a cache hit must also be young enough to outlive the MinIO lifecycle rule", () => {
    // The hit is decided by the tested pure predicate (size AND age), fed the
    // object's real LastModified — never by ContentLength alone.
    expect(overlay).toMatch(/isReusableMetaReadyArtifact\(\{\s*contentLength: head\.ContentLength,\s*lastModified: head\.LastModified,\s*now: Date\.now\(\),\s*\}\)/);
    expect(overlay).toMatch(/return reusable;/);
    expect(overlay).not.toMatch(/return \(head\.ContentLength \?\? 0\) > 0;/);
  });

  it("the in-flight entry is cleared on success AND failure, without an unhandled rejection", () => {
    expect(overlay).toMatch(/run\.then\(settle, settle\);/);
    expect(overlay).not.toMatch(/run\.finally\(/);
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
