import { describe, it, expect } from "vitest";
import { readSourceWithoutComments } from "./source-lock";

/**
 * Instagram: comment on our own post, first comment, @mention replies
 * (2026-10-17). Source locks for the wiring a type-check can't see.
 */
describe("Compose first comment", () => {
  const src = readSourceWithoutComments("apps/web/components/content-agent/ComposeTab.tsx");

  it("is sent on BOTH create paths (publish/schedule and save-draft)", () => {
    expect(src.match(/\.\.\.firstCommentPayload\(\)/g)?.length).toBe(2);
  });

  it("is never sent for a story or an article, or without an Instagram or Facebook channel", () => {
    const fn = src.slice(src.indexOf("function firstCommentPayload"), src.indexOf("function firstCommentPayload") + 700);
    expect(fn).toMatch(/isStoryMode,\s*isArticleMode/);
    expect(fn).toMatch(/ch\.platform === "INSTAGRAM" \|\| ch\.platform === "FACEBOOK"/);
    expect(fn).toMatch(/buildFirstCommentsPayload\(/);
  });

  it("is cleared after a successful create, delay included", () => {
    expect(src).toMatch(/setFirstComments\(\[""\]\)/);
    expect(src).toMatch(/setFirstCommentDelay\(0\)/);
  });
});

describe("Comment thread: new top-level comment", () => {
  const src = readSourceWithoutComments("apps/web/components/comments/comment-thread.tsx");

  it("is offered on Instagram and Facebook and uses comment.create", () => {
    expect(src).toMatch(/\(knownPlatform === "INSTAGRAM" \|\| knownPlatform === "FACEBOOK"\) && first && \(/);
    expect(src).toMatch(/trpc\.comment\.create\.useMutation/);
  });

  it("an unknown outcome flips the button to an explicit re-send", () => {
    expect(src).toMatch(/setNewCommentUnconfirmed\(true\)/);
    expect(src).toMatch(/Post again anyway/);
  });
});

describe("Mentions inbox", () => {
  const src = readSourceWithoutComments("apps/web/components/comments/mentions-inbox.tsx");

  it("a reply after an earlier one must pass `again`", () => {
    expect(src).toMatch(/again: m\.replyStatus \? true : undefined/);
  });

  it("is reachable from the Comments page (?view=mentions)", () => {
    const page = readSourceWithoutComments("apps/web/app/dashboard/comments/page.tsx");
    expect(page).toMatch(/viewParam === "mentions"/);
    expect(page).toMatch(/<MentionsInbox accounts=\{accounts\} \/>/);
  });
});
