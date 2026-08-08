import { describe, it, expect } from "vitest";
import { isFacebookVideoLike } from "../utils/fb-video-like";

/**
 * The gate for the expensive video-view recovery path.
 *
 * ⚠️ It is NOT `mediaType === "video"`. `ExternalPost.mediaType` carries a union
 * of TWO Meta vocabularies — `attachments.media_type` when the attachment is
 * present, `status_type` as the fallback — so the same reel can arrive labelled
 * `video` OR `added_video`. Live-probed 2026-08-08: the published_posts edge
 * returned `status_type: "added_video"` alongside `media_type: "video"` for
 * every reel on the page. Prod also holds 16 rows as `mobile_status_update`.
 */
describe("isFacebookVideoLike", () => {
  it("is definitive when the listing already resolved a video node", () => {
    // Even a label we would otherwise reject loses to a real video id.
    expect(isFacebookVideoLike({ mediaType: "photo", videoId: "123" })).toBe(true);
  });

  it("accepts every video label present in the two Meta vocabularies", () => {
    for (const t of ["video", "video_inline", "video_autoplay", "added_video", "video_direct_response"]) {
      expect(isFacebookVideoLike({ mediaType: t }), t).toBe(true);
    }
  });

  it("is case-insensitive (Instagram stores these uppercase)", () => {
    expect(isFacebookVideoLike({ mediaType: "VIDEO" })).toBe(true);
    expect(isFacebookVideoLike({ mediaType: "Reels" })).toBe(true);
  });

  it("rejects the labels that provably cannot carry a view count", () => {
    for (const t of [
      "photo",
      "added_photos",
      "album",
      "link",
      "shared_story",
      "note",
      "status",
      "mobile_status_update",
    ]) {
      expect(isFacebookVideoLike({ mediaType: t }), t).toBe(false);
    }
  });

  it("infers video from a /reel/, /videos/ or /watch permalink", () => {
    // The label can be missing or wrong; the URL is decisive.
    expect(isFacebookVideoLike({ permalink: "https://www.facebook.com/reel/884975274344793" })).toBe(true);
    expect(isFacebookVideoLike({ mediaType: null, permalink: "https://fb.com/page/videos/12" })).toBe(true);
    expect(isFacebookVideoLike({ permalink: "https://www.facebook.com/watch/?v=9" })).toBe(true);
  });

  it("a photo permalink does not make a photo video-like", () => {
    expect(
      isFacebookVideoLike({ mediaType: "photo", permalink: "https://facebook.com/page/photos/1" })
    ).toBe(false);
  });

  it("UNKNOWN non-empty label ⇒ ATTEMPT (asymmetric on purpose)", () => {
    // A wasted attempt costs one cheap lookup; a wrongly-skipped post is a
    // PERMANENT "—". So an unrecognized vocabulary entry gets the benefit of
    // the doubt.
    expect(isFacebookVideoLike({ mediaType: "some_future_meta_label" })).toBe(true);
  });

  it("no signal at all ⇒ false (don't spend the call on nothing)", () => {
    expect(isFacebookVideoLike({})).toBe(false);
    expect(isFacebookVideoLike({ mediaType: "" })).toBe(false);
    expect(isFacebookVideoLike({ mediaType: null, permalink: null, videoId: null })).toBe(false);
    expect(isFacebookVideoLike({ mediaType: "   " })).toBe(false);
  });

  it("is total — never throws on any input shape", () => {
    const inputs: any[] = [
      {},
      { mediaType: undefined },
      { permalink: undefined },
      { videoId: "" },
      { mediaType: 123 as any },
    ];
    for (const i of inputs) expect(() => isFacebookVideoLike(i)).not.toThrow();
  });
});
