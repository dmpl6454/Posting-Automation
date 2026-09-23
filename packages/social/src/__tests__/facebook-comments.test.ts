import { describe, it, expect } from "vitest";
import {
  parseFacebookCommentsPage,
  isFbCommentPermissionError,
  isFbTokenInvalidError,
  isFbCommentThrottleError,
  FB_COMMENT_FIELDS,
  FB_COMMENT_FIELDS_MINIMAL,
} from "../utils/facebook-comments";
import { isGraphFieldError, nextCursorFromPaging } from "../utils/social-comments";

/**
 * Pure contract for Facebook Page comments (2026-09-23): Graph shape →
 * platform-neutral SocialComment, and the error classes the provider maps to
 * actionable messages.
 */

const PAGE_ID = "112035290218472";

describe("parseFacebookCommentsPage", () => {
  it("maps a top-level comment with embedded replies into the neutral shape", () => {
    const page = parseFacebookCommentsPage(
      {
        data: [
          {
            id: "9_1",
            message: "Where can I buy this?",
            created_time: "2026-09-22T08:00:00+0000",
            from: { id: "PSID_1", name: "Asha K" },
            like_count: 4,
            comment_count: 2,
            is_hidden: false,
            can_comment: true,
            comments: {
              data: [
                {
                  id: "9_2",
                  message: "Link in bio!",
                  created_time: "2026-09-22T08:05:00+0000",
                  from: { id: PAGE_ID, name: "Contents of bollywood" },
                  like_count: 1,
                },
              ],
            },
          },
        ],
        paging: { cursors: { after: "AFTER" }, next: "https://graph.facebook.com/next" },
        summary: { total_count: 7 },
      },
      PAGE_ID
    );

    expect(page.nextCursor).toBe("AFTER");
    expect(page.totalCount).toBe(7);
    const c = page.comments[0]!;
    expect(c).toMatchObject({
      id: "9_1",
      text: "Where can I buy this?",
      createdAt: "2026-09-22T08:00:00+0000",
      author: { id: "PSID_1", name: "Asha K", username: null },
      likeCount: 4,
      hidden: false,
      // comment_count is the TRUE reply total, even though only 1 is embedded
      replyCount: 2,
      isOwn: false,
      canReply: true,
      attachmentType: null,
    });
    expect(c.replies).toHaveLength(1);
    // The Page's own reply is flagged, and a reply is never itself replyable.
    expect(c.replies[0]).toMatchObject({ id: "9_2", isOwn: true, canReply: false, replyCount: 0, replies: [] });
  });

  it("never reports FEWER replies than it can actually show", () => {
    const page = parseFacebookCommentsPage(
      { data: [{ id: "c", comment_count: 0, comments: { data: [{ id: "r1" }, { id: "r2" }] } }] },
      PAGE_ID
    );
    expect(page.comments[0]!.replyCount).toBe(2);
  });

  it("degrades safely on a sparse row (Meta withholds fields it cannot return)", () => {
    const page = parseFacebookCommentsPage({ data: [{ id: "c-sparse" }] }, PAGE_ID);
    expect(page.comments[0]).toEqual({
      id: "c-sparse",
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
    });
  });

  it("honours can_comment=false (comments turned off) and flags hidden comments", () => {
    const page = parseFacebookCommentsPage({ data: [{ id: "c", can_comment: false, is_hidden: true }] }, PAGE_ID);
    expect(page.comments[0]).toMatchObject({ canReply: false, hidden: true });
  });

  it("keeps an attachment-only comment's type so the UI can label it", () => {
    const page = parseFacebookCommentsPage({ data: [{ id: "c", attachment: { type: "sticker" } }] }, PAGE_ID);
    expect(page.comments[0]).toMatchObject({ text: "", attachmentType: "sticker" });
  });

  it("does not flag anything as the Page's own when the Page id is unknown", () => {
    const page = parseFacebookCommentsPage({ data: [{ id: "c", from: { id: PAGE_ID } }] }, null);
    expect(page.comments[0]!.isOwn).toBe(false);
  });

  it("returns an empty page with a null total when Meta sends no summary", () => {
    expect(parseFacebookCommentsPage({}, PAGE_ID)).toEqual({ comments: [], nextCursor: null, totalCount: null });
  });

  it("surfaces a cursor ONLY when paging.next exists (a stray cursor pages forever)", () => {
    expect(nextCursorFromPaging({ cursors: { after: "A" } })).toBeNull();
    expect(nextCursorFromPaging({ cursors: { after: "A" }, next: "https://x" })).toBe("A");
    expect(nextCursorFromPaging(undefined)).toBeNull();
  });
});

describe("field sets", () => {
  it("the preferred set embeds the NEWEST replies in one round-trip", () => {
    expect(FB_COMMENT_FIELDS).toContain("comments.order(reverse_chronological).limit(");
    expect(FB_COMMENT_FIELDS).toContain("from{id,name}");
  });

  it("the minimal fallback drops exactly the two names the v26 reference does not render", () => {
    expect(FB_COMMENT_FIELDS).toContain("is_hidden");
    expect(FB_COMMENT_FIELDS).toContain("attachment{type}");
    expect(FB_COMMENT_FIELDS_MINIMAL).not.toContain("is_hidden");
    expect(FB_COMMENT_FIELDS_MINIMAL).not.toContain("attachment");
    // …and still reads the thread (author, text, replies).
    for (const f of ["message", "from{id,name}", "created_time", "comments.order(reverse_chronological).limit("]) {
      expect(FB_COMMENT_FIELDS_MINIMAL).toContain(f);
    }
  });
});

describe("error classification", () => {
  it("treats #10 permission wording and the whole #200–#299 family as a missing scope", () => {
    expect(isFbCommentPermissionError({ code: 10, message: "(#10) Application does not have permission for this action" })).toBe(true);
    expect(isFbCommentPermissionError({ code: 200, message: "(#200) Requires pages_manage_engagement permission" })).toBe(true);
    // 283 is the documented "requires the extended permission pages_read_engagement
    // and/or pages_read_user_content" error on the comments edge.
    expect(isFbCommentPermissionError({ code: 283, message: "That action requires the extended permission pages_read_user_content" })).toBe(true);
    expect(isFbCommentPermissionError({ code: "200" })).toBe(true);
  });

  it("does NOT treat every #10 as a missing scope, nor a dead token, nor nothing", () => {
    expect(isFbCommentPermissionError({ code: 10, message: "Something unrelated" })).toBe(false);
    expect(isFbCommentPermissionError({ code: 190, message: "permission" })).toBe(false);
    expect(isFbCommentPermissionError(undefined)).toBe(false);
  });

  it("identifies a dead token / lost Page role (#190, incl. 460 and 492)", () => {
    expect(isFbTokenInvalidError({ code: 190, error_subcode: 460 })).toBe(true);
    expect(isFbTokenInvalidError({ code: 190, error_subcode: 492 })).toBe(true);
    expect(isFbTokenInvalidError({ code: 10 })).toBe(false);
  });

  it("recognises throttles, including #368 (temporarily blocked — too many replies too fast)", () => {
    for (const code of [4, 17, 32, 368, 613, 80001]) {
      expect(isFbCommentThrottleError({ code })).toBe(true);
    }
    expect(isFbCommentThrottleError({ code: 100 })).toBe(false);
  });

  it("isGraphFieldError needs code 100 AND field wording — #100 alone is overloaded", () => {
    expect(isGraphFieldError({ code: 100, message: "(#100) Tried accessing nonexisting field (is_hidden) on node type (Comment)" })).toBe(true);
    expect(isGraphFieldError({ code: 100, message: "Unsupported get request. Object does not exist" })).toBe(false);
    expect(isGraphFieldError({ code: 10, message: "nonexisting field" })).toBe(false);
    expect(isGraphFieldError(null)).toBe(false);
  });
});
