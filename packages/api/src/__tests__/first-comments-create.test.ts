import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstCommentsMarker, firstCommentMetadata } from "../lib/first-comments-input";
import { readFirstCommentsPlan } from "@postautomation/social";

/**
 * post.create's first-comments input (2026-11-03): several comments, a delay,
 * Instagram and Facebook. Pure helper tested directly; router wiring locked at
 * the source level (house pattern).
 */
describe("firstCommentsMarker", () => {
  const base = { isStory: false, isArticle: false };

  it("stores several comments and the delay", () => {
    expect(firstCommentsMarker({ ...base, firstComments: ["a", "b"], firstCommentDelayMinutes: 30 })).toEqual({
      comments: ["a", "b"],
      delayMinutes: 30,
    });
  });

  it("a 2026-10-17 client's single comment stays Instagram-only (the legacy marker)", () => {
    // That user was told "Facebook doesn't get it" — a stale tab must not
    // start commenting on their Facebook Pages.
    expect(firstCommentMetadata({ ...base, firstComment: "#tags" })).toEqual({ instagramFirstComment: { text: "#tags" } });
    expect(readFirstCommentsPlan({ instagramFirstComment: { text: "#tags" } })?.platforms).toEqual(["INSTAGRAM"]);
  });

  it("the list wins when both are sent", () => {
    expect(firstCommentMetadata({ ...base, firstComment: "old", firstComments: ["new"] })).toEqual({
      firstComments: { comments: ["new"], delayMinutes: 0 },
    });
  });

  it("writes nothing for a story or an article, even with the legacy input", () => {
    expect(firstCommentMetadata({ ...base, isStory: true, firstComment: "x" })).toEqual({});
    expect(firstCommentMetadata({ ...base, isArticle: true, firstComments: ["x"] })).toEqual({});
  });

  it.each([
    ["a story", { firstComments: ["a"], isStory: true }],
    ["an article", { firstComments: ["a"], isArticle: true }],
    ["no comment", {}],
    ["an empty list", { firstComments: [] }],
  ])("stores nothing for %s", (_l, over) => {
    expect(firstCommentsMarker({ ...base, ...over })).toBeUndefined();
  });

  it("round-trips through the worker's reader for both platforms", () => {
    const marker = firstCommentsMarker({ ...base, firstComments: ["a", "b"], firstCommentDelayMinutes: 5 });
    expect(readFirstCommentsPlan({ firstComments: marker })).toEqual({
      comments: ["a", "b"],
      delayMinutes: 5,
      platforms: ["INSTAGRAM", "FACEBOOK"],
    });
  });
});

describe("post.create wiring", () => {
  const src = readFileSync(join(__dirname, "../routers/post.router.ts"), "utf8");

  it("validates count, length and delay", () => {
    expect(src).toMatch(/firstComments: z\s*\.array\(/);
    expect(src).toMatch(/\.max\(FIRST_COMMENTS_COUNT_MAX/);
    expect(src).toMatch(/firstCommentDelayMinutes: z\s*\.number\(\)\s*\.int\(\)\s*\.min\(0\)/);
  });

  it("writes the marker only through the helper, and strips raw client copies", () => {
    expect(src).toMatch(/Object\.assign\(out, firstCommentMetadata\(\{ \.\.\.input, isStory, isArticle \}\)\)/);
    expect(src).toMatch(/firstComments: _rawFirstComments,/);
    expect(src).toMatch(/instagramFirstComment: _rawFirstComment,/);
  });
});
