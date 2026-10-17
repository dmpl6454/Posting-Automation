import { describe, it, expect } from "vitest";
import { firstCommentLine } from "./first-comment";

describe("firstCommentLine", () => {
  it("describes each recorded outcome", () => {
    expect(firstCommentLine({ firstComment: { status: "posted", commentId: "1" } })).toEqual({ tone: "ok", text: "First comment posted." });
    expect(firstCommentLine({ firstComment: { status: "unconfirmed" } })?.text).toMatch(/may already be on the post/);
    expect(firstCommentLine({ firstComment: { status: "failed", error: "Permission missing." } })).toEqual({
      tone: "error",
      text: "First comment wasn't posted: Permission missing. You can add it from Show comments.",
    });
  });

  it("says nothing without a record or for an unknown status", () => {
    expect(firstCommentLine(null)).toBeNull();
    expect(firstCommentLine({})).toBeNull();
    expect(firstCommentLine({ firstComment: { status: "skipped" } })).toBeNull();
  });
});
