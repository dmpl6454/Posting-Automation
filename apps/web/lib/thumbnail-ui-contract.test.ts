import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Client-side contract for the custom video cover.
 *
 * These three defects were found by an adversarial review of the feature BEFORE
 * it shipped, and each one silently loses a user's explicit input while telling
 * them it worked — the worst failure shape for a publishing product. Locked at
 * the source level because ComposeTab has no component-test harness.
 */
const ROOT = join(__dirname, "..", "..", "..");
const src = readFileSync(join(ROOT, "apps/web/components/content-agent/ComposeTab.tsx"), "utf8");

describe("cover upload arms an in-flight flag", () => {
  it("tracks thumbnailUploading on the tile", () => {
    // Without it, both submit guards pass mid-upload and the post publishes
    // WITHOUT the cover while the success toast still fires. Unrecoverable for an
    // IG Reel, whose cover cannot be changed after publishing.
    expect(src).toMatch(/thumbnailUploading\?: boolean/);
    expect(src).toMatch(/thumbnailUploading: true/);
    expect(src).toMatch(/thumbnailUploading: false/);
  });

  it("feeds it into ONE shared busy predicate, not three copies", () => {
    // Three independent checks are how they desync; mediaBusy is the single source.
    expect(src).toMatch(/const mediaBusy = postMedia\.some\(\(m\) => m\.uploading \|\| m\.thumbnailUploading\)/);
    expect(src).toMatch(/const anyUploading = isUploading \|\| mediaBusy/);
  });

  it("blocks BOTH submit paths while a cover is uploading", () => {
    const guards = src.match(/item\.uploading \|\| item\.thumbnailUploading/g) ?? [];
    // publish/schedule + save-as-draft.
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });
});

describe("cover write-back survives tile removal", () => {
  it("keys the post-await write on a captured tile URL, never the array index", () => {
    // The X button re-indexes with filter((_, i) => i !== idx), so a positional
    // write after an await can land on the WRONG tile — or none — while still
    // toasting success.
    expect(src).toMatch(/const tileUrl = postMedia\[idx\]\?\.url/);
    expect(src).toMatch(/m\.url === tileUrl/);
  });

  it("tells the user when the tile vanished instead of claiming success", () => {
    expect(src).toMatch(/Thumbnail not attached/);
  });

  it("disables the picker while that tile's video is still uploading", () => {
    // startAutoUpload swaps the tile's blob: url to the durable S3 url on
    // completion — picking mid-upload would race the very key we write back on.
    expect(src).toMatch(/disabled=\{!!item\.uploading \|\| !!item\.thumbnailUploading\}/);
  });
});

describe("a restored draft's cover id is reconciled like any other media id", () => {
  it("includes cover ids in the verifyIds check", () => {
    // They reach post.create, which runs assertMediaOwned — a deleted cover would
    // otherwise kill the ENTIRE post with an opaque FORBIDDEN and no way to clear it.
    expect(src).toMatch(/flatMap\(\(m: any\) => \[m\.mediaId, m\.thumbnail\?\.mediaId\]\)/);
  });

  it("strips a cover whose Media row is gone, keeping the tile", () => {
    expect(src).toMatch(/next\.thumbnail && !owned\.has\(next\.thumbnail\.mediaId\)/);
  });
});

describe("oversized covers are FITTED, never refused (2026-09-02)", () => {
  it("routes every pick through prepareThumbnail and uploads the prepared file", () => {
    // Phone photos are routinely 3-8MB; the original hard 2MB refusal made the
    // picker unusable, and HEIC/webp died server-side with an opaque error.
    expect(src).toMatch(/const prepared = await prepareThumbnail\(/);
    expect(src).toMatch(/uploadFileToS3\(prepared\.file\)/);
  });

  it("has no hard size refusal left", () => {
    // The guard expression itself, not the phrase — comments may cite the old
    // toast title when explaining why the refusal was removed.
    expect(src).not.toMatch(/file\.size > 2 \* 1024 \* 1024/);
  });

  it("crops to the probed video aspect only for the probed video, never guesses", () => {
    expect(src).toMatch(/tileUrl === firstVideoUrl \? videoAspect : null/);
  });
});

describe("the landed check reads COMMITTED state, not an updater side effect (2026-09-02)", () => {
  it("uses the postMediaRef mirror after the await", () => {
    // A `landed` flag mutated inside a setPostMedia updater is unreliable: React
    // runs updaters eagerly only when that hook's queue is empty, so any other
    // in-flight update left the flag false — toasting "That video was removed"
    // while the attach had in fact landed (owner-reported).
    expect(src).toMatch(/postMediaRef\.current\.some\(\(m\) => m\.url === tileUrl\)/);
  });

  it("keeps the state updater pure — no flag mutation inside it", () => {
    // The mutation itself, not the word — comments explain the removed pattern.
    expect(src).not.toMatch(/landed = (?:true|false)/);
  });

  it("keeps the mirror a render-body assignment, NOT a [postMedia]-keyed effect", () => {
    // The OOM rule: never key a ComposeTab effect on the postMedia array identity.
    expect(src).toMatch(/postMediaRef\.current = postMedia;/);
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*postMediaRef/);
  });
});

describe("the set cover is VISIBLE, not just toasted about (2026-09-02)", () => {
  const previewMediaSrc = readFileSync(
    join(ROOT, "apps/web/components/previews/preview-media.tsx"),
    "utf8"
  );

  it("renders the processed cover image as the tile's visual", () => {
    // Owner report: "we can never see what thumbnail was set". The tile now
    // shows the ACTUAL processed image (crop included) when a cover exists.
    expect(src).toMatch(/src=\{item\.thumbnail\.url\}/);
  });

  it("offers cover REMOVAL keyed on the tile URL, never the array index", () => {
    expect(src).toMatch(/m\.url === tileUrl \? \{ \.\.\.m, thumbnail: undefined \}/);
  });

  it("threads the cover into the preview using the SAME rule as submit", () => {
    // post.create takes the FIRST tile with a cover — the preview must mirror
    // that or it shows a cover that will not publish.
    expect(src).toMatch(/videoPosterUrl=\{postMedia\.find\(\(m\) => m\.thumbnail\)\?\.thumbnail\?\.url\}/);
  });

  it("PreviewMedia applies the poster ONLY on video branches", () => {
    // The image branch must ignore it, so previews can pass it unconditionally.
    expect(previewMediaSrc).toMatch(/poster=\{poster\}/);
    expect(previewMediaSrc).not.toMatch(/<img src=\{url\}[^>]*poster/);
  });
});
