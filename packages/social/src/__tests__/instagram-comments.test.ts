import { describe, it, expect } from "vitest";
import {
  parseCommentsPage,
  isCommentPermissionDeniedError,
  isCommentObjectGoneError,
  COMMENT_REPLY_MAX_LENGTH,
} from "../utils/instagram-comments";

describe("parseCommentsPage", () => {
  it("maps Graph's snake_case comment rows to the app shape with safe defaults", () => {
    const page = parseCommentsPage({
      data: [
        { id: "c1", text: "Love this", timestamp: "2026-09-19T10:00:00+0000", username: "fan1", like_count: 3, hidden: false },
        // Sparse row — Meta omits fields it cannot return (e.g. username for a
        // restricted commenter); the UI must never crash on them.
        { id: "c2" },
      ],
    });
    expect(page.comments).toEqual([
      { id: "c1", text: "Love this", timestamp: "2026-09-19T10:00:00+0000", username: "fan1", likeCount: 3, hidden: false },
      { id: "c2", text: "", timestamp: "", username: null, likeCount: 0, hidden: false },
    ]);
  });

  it("returns an empty page (not a throw) for a media with no comments", () => {
    expect(parseCommentsPage({ data: [] })).toEqual({ comments: [], nextCursor: null });
    expect(parseCommentsPage({})).toEqual({ comments: [], nextCursor: null });
  });

  it("surfaces a cursor ONLY when paging.next says another page exists", () => {
    // Graph can return cursors.after on the LAST page too; a stray cursor would
    // let the UI request a page that is empty forever.
    expect(
      parseCommentsPage({ data: [{ id: "c1" }], paging: { cursors: { after: "AFTER" } } }).nextCursor
    ).toBeNull();
    expect(
      parseCommentsPage({
        data: [{ id: "c1" }],
        paging: { cursors: { after: "AFTER" }, next: "https://graph.facebook.com/next" },
      }).nextCursor
    ).toBe("AFTER");
  });
});

describe("isCommentPermissionDeniedError", () => {
  it("matches Meta's (#10) 'does not have permission' shape", () => {
    expect(
      isCommentPermissionDeniedError({
        code: 10,
        message: "(#10) Application does not have permission for this action",
      })
    ).toBe(true);
    // code arrives as a string on some proxies
    expect(isCommentPermissionDeniedError({ code: "10", message: "does not have permission" })).toBe(true);
  });

  it("does NOT treat every code 10 as a missing scope", () => {
    // Code 10 is overloaded; the wording is what distinguishes the scope case.
    expect(isCommentPermissionDeniedError({ code: 10, message: "Something else entirely" })).toBe(false);
    expect(isCommentPermissionDeniedError({ code: 190, message: "does not have permission" })).toBe(false);
    expect(isCommentPermissionDeniedError(undefined)).toBe(false);
    expect(isCommentPermissionDeniedError(null)).toBe(false);
  });
});

describe("isCommentObjectGoneError", () => {
  it("requires the #100 / subcode 33 PAIR — #100 alone is a generic validation error", () => {
    expect(isCommentObjectGoneError({ code: 100, error_subcode: 33, message: "Object does not exist" })).toBe(true);
    expect(isCommentObjectGoneError({ code: 100, message: "Invalid parameter" })).toBe(false);
    expect(isCommentObjectGoneError({ code: 190, error_subcode: 33 })).toBe(false);
    expect(isCommentObjectGoneError(undefined)).toBe(false);
  });
});

describe("COMMENT_REPLY_MAX_LENGTH", () => {
  it("is Instagram's comment ceiling", () => {
    expect(COMMENT_REPLY_MAX_LENGTH).toBe(2200);
  });
});
