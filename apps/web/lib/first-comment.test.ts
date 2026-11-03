import { describe, it, expect } from "vitest";
import { firstCommentLine, buildFirstCommentsPayload } from "./first-comment";

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

describe("firstCommentLine — several comments and delays (2026-11-03)", () => {
  const now = new Date("2026-11-03T10:00:00Z");

  it("says when a delayed comment will go out", () => {
    const due = firstCommentLine({ firstComment: { status: "scheduled", dueAt: "2026-11-03T10:15:00Z" } }, now);
    expect(due?.tone).toBe("ok");
    expect(due?.text).toMatch(/^First comment will be posted at /);
    expect(firstCommentLine({ firstComment: { status: "scheduled", dueAt: "2026-11-03T09:00:00Z" } }, now)?.text).toBe(
      "First comment will be posted any moment now."
    );
    expect(firstCommentLine({ firstComment: { status: "scheduled", total: 3 } }, now)?.text).toBe("First comments will be posted later.");
  });

  it("counts several comments", () => {
    expect(firstCommentLine({ firstComment: { status: "posted", posted: 3, total: 3 } })?.text).toBe("All 3 first comments posted.");
    expect(firstCommentLine({ firstComment: { status: "failed", posted: 1, total: 3, error: "Throttled." } })).toEqual({
      tone: "error",
      text: "1 of 3 first comments posted; the next one failed: Throttled. You can add the rest from Show comments.",
    });
    expect(firstCommentLine({ firstComment: { status: "unconfirmed", posted: 2, total: 3 } })?.text).toMatch(
      /^2 of 3 first comments posted; the next one wasn't confirmed/
    );
  });

  it("shows a run in progress", () => {
    expect(firstCommentLine({ firstComment: { status: "posting" } })?.text).toBe("Posting the first comment…");
  });
});

describe("buildFirstCommentsPayload", () => {
  const base = { comments: ["#a", "  ", "two "], delayMinutes: 0, hasCommentChannel: true, isStoryMode: false, isArticleMode: false };

  it("drops blank boxes, keeps order, and omits a zero delay", () => {
    expect(buildFirstCommentsPayload(base)).toEqual({ firstComments: ["#a", "two"] });
  });

  it("sends the delay when one is chosen", () => {
    expect(buildFirstCommentsPayload({ ...base, delayMinutes: 15 })).toEqual({ firstComments: ["#a", "two"], firstCommentDelayMinutes: 15 });
  });

  it.each([
    ["no Instagram or Facebook channel", { hasCommentChannel: false }],
    ["a story", { isStoryMode: true }],
    ["an article", { isArticleMode: true }],
    ["only blank boxes", { comments: ["", "  "] }],
  ])("sends nothing for %s", (_l, over) => {
    expect(buildFirstCommentsPayload({ ...base, ...over })).toEqual({});
  });

  it("never sends more than five", () => {
    expect(buildFirstCommentsPayload({ ...base, comments: ["1", "2", "3", "4", "5", "6"] }).firstComments).toHaveLength(5);
  });
});
