import { describe, it, expect } from "vitest";
import {
  readFbStoryCheckpoint,
  isFbStoryMediaExpired,
  findFbStoryByMediaId,
  fbStoryUrl,
  isFbPermissionError,
  FB_STORY_MEDIA_TTL_MS,
} from "../utils/facebook-story";

describe("readFbStoryCheckpoint", () => {
  it("reads the media id and kind the provider wrote", () => {
    expect(
      readFbStoryCheckpoint({ fbStoryMedia: { id: "123", kind: "PHOTO", createdAt: "2026-09-16T06:00:00.000Z" } })
    ).toEqual({ id: "123", kind: "PHOTO", createdAt: "2026-09-16T06:00:00.000Z" });
  });

  it("refuses anything malformed rather than resuming against a bad id", () => {
    expect(readFbStoryCheckpoint(null)).toBeNull();
    expect(readFbStoryCheckpoint({})).toBeNull();
    expect(readFbStoryCheckpoint({ fbStoryMedia: [] })).toBeNull();
    expect(readFbStoryCheckpoint({ fbStoryMedia: { id: "", kind: "PHOTO" } })).toBeNull();
    expect(readFbStoryCheckpoint({ fbStoryMedia: { id: "1", kind: "REEL" } })).toBeNull();
  });

  it("treats a missing timestamp as ancient, so the media is re-uploaded rather than trusted", () => {
    const cp = readFbStoryCheckpoint({ fbStoryMedia: { id: "1", kind: "VIDEO" } })!;
    expect(isFbStoryMediaExpired(cp)).toBe(true);
  });
});

describe("isFbStoryMediaExpired", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");

  it("honours Facebook's 24h unpublished-media window", () => {
    const fresh = { id: "1", kind: "PHOTO" as const, createdAt: new Date(now.getTime() - 60_000).toISOString() };
    const stale = { id: "1", kind: "PHOTO" as const, createdAt: new Date(now.getTime() - FB_STORY_MEDIA_TTL_MS - 1000).toISOString() };
    expect(isFbStoryMediaExpired(fresh, now)).toBe(false);
    expect(isFbStoryMediaExpired(stale, now)).toBe(true);
  });

  it("treats an unparseable timestamp as expired", () => {
    expect(isFbStoryMediaExpired({ id: "1", kind: "PHOTO", createdAt: "not-a-date" }, now)).toBe(true);
  });
});

describe("findFbStoryByMediaId", () => {
  const entries = [
    { post_id: "p1", media_id: "m1", url: "https://facebook.com/stories/p1", status: "PUBLISHED" },
    { post_id: "p2", media_id: "m2", status: "PUBLISHED" },
  ];

  it("matches on OUR media id — never on recency", () => {
    expect(findFbStoryByMediaId(entries, "m1")).toEqual({ postId: "p1", url: "https://facebook.com/stories/p1" });
  });

  it("returns null when the listing is readable and simply does not contain it", () => {
    expect(findFbStoryByMediaId(entries, "m404")).toBeNull();
    expect(findFbStoryByMediaId([], "m1")).toBeNull();
    expect(findFbStoryByMediaId(undefined, "m1")).toBeNull();
  });

  it("keeps the postId when the entry carries no usable url", () => {
    expect(findFbStoryByMediaId(entries, "m2")).toEqual({ postId: "p2", url: null });
  });

  it("refuses a non-http url rather than putting it in front of a user", () => {
    expect(findFbStoryByMediaId([{ post_id: "p3", media_id: "m3", url: "javascript:alert(1)" }], "m3")).toEqual({
      postId: "p3",
      url: null,
    });
  });

  it("ignores an entry with no post id — there would be nothing to record", () => {
    expect(findFbStoryByMediaId([{ media_id: "m9" }], "m9")).toBeNull();
  });
});

describe("fbStoryUrl", () => {
  it("matches the shape Meta documents", () => {
    expect(fbStoryUrl("123")).toBe("https://www.facebook.com/stories/123");
  });
});

describe("isFbPermissionError", () => {
  it("names the CREATE_CONTENT / permission class, which nothing in connect verifies", () => {
    expect(isFbPermissionError({ error: { code: 200, message: "Permissions error" } })).toBe(true);
    expect(isFbPermissionError({ error: { code: 10, message: "Application does not have permission" } })).toBe(true);
    expect(isFbPermissionError({ error: { code: 1, message: "requires CREATE_CONTENT task" } })).toBe(true);
  });

  it("does not claim a media or unknown error is a permission problem", () => {
    expect(isFbPermissionError({ error: { code: 100, message: "Invalid photo_id" } })).toBe(false);
    expect(isFbPermissionError(null)).toBe(false);
    expect(isFbPermissionError({})).toBe(false);
  });
});
