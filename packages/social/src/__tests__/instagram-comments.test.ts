import { describe, it, expect } from "vitest";
import {
  parseCommentsPage,
  isCommentPermissionDeniedError,
  isCommentObjectGoneError,
  isValidGraphObjectId,
  COMMENT_REPLY_MAX_LENGTH,
} from "../utils/instagram-comments";

describe("parseCommentsPage", () => {
  it("maps Graph's snake_case comment rows to the platform-neutral shape with safe defaults", () => {
    const page = parseCommentsPage({
      data: [
        {
          id: "c1",
          text: "Love this",
          timestamp: "2026-09-19T10:00:00+0000",
          username: "fan1",
          like_count: 3,
          hidden: false,
          from: { id: "IGSID_1", username: "fan1" },
        },
        // Sparse row — Meta omits fields it cannot return (e.g. username for a
        // restricted commenter); the UI must never crash on them.
        { id: "c2" },
      ],
    });
    expect(page.comments).toEqual([
      {
        id: "c1",
        text: "Love this",
        createdAt: "2026-09-19T10:00:00+0000",
        author: { id: "IGSID_1", name: null, username: "fan1" },
        likeCount: 3,
        hidden: false,
        replyCount: 0,
        replies: [],
        isOwn: false,
        canReply: true,
        attachmentType: null,
        likedByAccount: null,
        canHide: true,
        canDelete: true,
        canLike: true,
        canEdit: false,
      },
      {
        id: "c2",
        text: "",
        createdAt: "",
        author: { id: null, name: null, username: null },
        likeCount: 0,
        hidden: false,
        replyCount: 0,
        replies: [],
        isOwn: false,
        canReply: true,
        attachmentType: null,
        likedByAccount: null,
        canHide: true,
        canDelete: true,
        canLike: true,
        canEdit: false,
      },
    ]);
  });

  it("returns an empty page (not a throw) for a media with no comments", () => {
    expect(parseCommentsPage({ data: [] })).toEqual({ comments: [], nextCursor: null, totalCount: null });
    expect(parseCommentsPage({})).toEqual({ comments: [], nextCursor: null, totalCount: null });
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

  it("nests embedded replies under their comment; a reply is never itself replyable", () => {
    const page = parseCommentsPage({
      data: [
        {
          id: "c1",
          text: "When is part 2?",
          username: "fan1",
          replies: { data: [{ id: "r1", text: "Tomorrow!", username: "bollywooddaily" }] },
        },
      ],
    });
    const c = page.comments[0]!;
    expect(c.canReply).toBe(true);
    expect(c.replyCount).toBe(1);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0]).toMatchObject({ id: "r1", text: "Tomorrow!", canReply: false, replies: [] });
  });

  it("flags the connected account's OWN replies — by IG user id, or by handle (case-insensitive)", () => {
    const page = parseCommentsPage(
      {
        data: [
          {
            id: "c1",
            username: "fan1",
            replies: {
              data: [
                { id: "r-by-id", username: "renamed", from: { id: "IG_USER" } },
                { id: "r-by-handle", username: "BollywoodDaily" },
                { id: "r-other", username: "fan2", from: { id: "IGSID_2" } },
              ],
            },
          },
        ],
      },
      { igUserId: "IG_USER", username: "@bollywooddaily" }
    );
    const flags = Object.fromEntries(page.comments[0]!.replies.map((r) => [r.id, r.isOwn]));
    expect(flags).toEqual({ "r-by-id": true, "r-by-handle": true, "r-other": false });
    expect(page.comments[0]!.isOwn).toBe(false);
  });

  it("moderation: can hide/delete others' comments, never its OWN hide, like comments AND replies, never edit", () => {
    const page = parseCommentsPage(
      { data: [{ id: "c1", username: "fan", replies: { data: [{ id: "r1", username: "bollywooddaily" }] } }] },
      { username: "bollywooddaily" }
    );
    // Like is offered on comments and replies (User Likes reference covers both);
    // the UI gates it on the GRANTED instagram_manage_engagement. The like STATE
    // stays null — Instagram has no readable "liked by me" field.
    expect(page.comments[0]).toMatchObject({ canHide: true, canDelete: true, canLike: true, canEdit: false, likedByAccount: null });
    expect(page.comments[0]!.replies[0]).toMatchObject({ isOwn: true, canHide: false, canDelete: true, canLike: true, likedByAccount: null });
  });

  it("a HIDDEN top-level comment cannot be replied to (Instagram refuses it)", () => {
    const page = parseCommentsPage({ data: [{ id: "c1", hidden: true }] });
    expect(page.comments[0]).toMatchObject({ hidden: true, canReply: false, canHide: true });
  });

  it("never flags anything as own when the account identity is unknown", () => {
    const page = parseCommentsPage({ data: [{ id: "c1", username: "anyone" }] });
    expect(page.comments[0]!.isOwn).toBe(false);
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
    // What Meta ACTUALLY returned on 2026-09-23 for a token without
    // instagram_manage_comments — the #10 rule alone missed it.
    expect(isCommentPermissionDeniedError({ code: 100, message: "(#100) Missing Permission" })).toBe(true);
    expect(isCommentPermissionDeniedError({ code: 100, message: "Invalid parameter" })).toBe(false);
    expect(
      isCommentPermissionDeniedError({
        code: 100,
        error_subcode: 33,
        message:
          "Unsupported post request. Object with ID '17900000000000001' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      })
    ).toBe(false);
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

describe("isValidGraphObjectId (path-injection guard)", () => {
  it("accepts the real Graph id shapes", () => {
    expect(isValidGraphObjectId("17841400000000000")).toBe(true);
    expect(isValidGraphObjectId("112035290218472_9988776655")).toBe(true);
  });

  it("🔴 REJECTS the arbitrary-authenticated-POST payload", () => {
    // Verified with WHATWG URL: raw interpolation of this value resolves to
    // pathname /v18.0/17841400000000000/media with the trailing /replies
    // absorbed as a query token — an arbitrary Graph POST on the org's token.
    expect(
      isValidGraphObjectId("17841400000000000/media?image_url=https%3A%2F%2Fevil.example%2Fx.jpg&caption=Hacked&x=")
    ).toBe(false);
  });

  it("rejects every character that could break out of one path segment", () => {
    for (const bad of [
      "123/media",
      "123?fields=x",
      "123#frag",
      "123&method=delete",
      "123%2Fmedia",
      "123 456",
      "123\n456",
      "../me",
      "",
      "abc",
      "123_",
      "_123",
      "123__456",
    ]) {
      expect(isValidGraphObjectId(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });
});
