import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeLastRun, describeReason, formatBlockedWords, parseBlockedWordsInput } from "./comment-automation";

describe("comment automation helpers", () => {
  it("parses one word or phrase per line or comma, dropping blanks", () => {
    expect(parseBlockedWordsInput("scam, free followers\n\n DM me ,")).toEqual(["scam", "free followers", "DM me"]);
    expect(formatBlockedWords(["a", "b c"])).toBe("a\nb c");
  });

  it("describes the last run in words, including the quota pause", () => {
    expect(describeLastRun(null)).toBe("Hasn't run yet.");
    expect(describeLastRun({ postsChecked: 0 })).toBe("No recent posts to check.");
    expect(describeLastRun({ postsChecked: 12, hidden: 2, newComments: 1, errors: 1, skippedForQuota: 3 })).toBe(
      "Checked 12 posts · hid 2 · 1 new comment · 1 couldn't be read or hidden · 3 Facebook posts left for later (Meta usage high)."
    );
  });

  it("describes why a comment was hidden", () => {
    expect(describeReason("link")).toBe("Contains a link");
    expect(describeReason("word:scam")).toBe("Blocked word “scam”");
  });
});

describe("Automation tab contract", () => {
  const ui = readFileSync(join(__dirname, "../components/comments/comment-automation.tsx"), "utf8");
  it("every control is disabled for people who can't edit, and Save refuses an empty rule or scope", () => {
    expect(ui).toMatch(/disabled=\{!canEdit \|\| save\.isPending \|\| noRule \|\| scopeEmpty\}/);
    expect((ui.match(/disabled=\{!canEdit\}/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
  it("'all accounts' is sent as an empty list, never as a snapshot of today's ids", () => {
    expect(ui).toMatch(/channelIds: allAccounts \? \[\] : \[\.\.\.picked\]/);
  });
  it("unhide goes through comment.moderate (which also marks the log)", () => {
    expect(ui).toMatch(/unhide\.mutate\(\{ targetId: item\.postTargetId, commentId: item\.commentId, action: "unhide" \}\)/);
  });
});
