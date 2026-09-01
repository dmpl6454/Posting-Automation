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
