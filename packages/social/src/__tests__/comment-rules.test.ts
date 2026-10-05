import { describe, it, expect } from "vitest";
import {
  containsLink,
  matchCommentRule,
  normalizeBlockedWords,
  MAX_BLOCKED_WORDS,
  MAX_BLOCKED_WORD_LENGTH,
} from "../utils/comment-rules";

const rules = (blockedWords: string[], hideLinks = false) => ({ blockedWords, hideLinks });

describe("matchCommentRule — blocked words", () => {
  it("matches a plain word as a WHOLE word, case-insensitively", () => {
    expect(matchCommentRule("This is a SCAM honestly", rules(["scam"]))).toEqual({ reason: "word:scam" });
    expect(matchCommentRule("scam!", rules(["scam"]))).toEqual({ reason: "word:scam" });
    expect(matchCommentRule("Scammer alert", rules(["scam"]))).toBeNull();
    expect(matchCommentRule("first class", rules(["ass"]))).toBeNull();
  });

  it("works for non-Latin scripts (whole-word on Unicode letters)", () => {
    expect(matchCommentRule("यह बकवास है", rules(["बकवास"]))).toEqual({ reason: "word:बकवास" });
    expect(matchCommentRule("बकवासबाज़", rules(["बकवास"]))).toBeNull();
  });

  it("folds full-width / compatibility characters before matching", () => {
    expect(matchCommentRule("ＳＣＡＭ", rules(["scam"]))).toEqual({ reason: "word:scam" });
  });

  it("matches a phrase or an emoji as a substring, with whitespace collapsed", () => {
    expect(matchCommentRule("dm   me now for deals", rules(["dm me"]))).toEqual({ reason: "word:dm me" });
    expect(matchCommentRule("nice 🍆🍆", rules(["🍆"]))).toEqual({ reason: "word:🍆" });
  });

  it("does not treat regex metacharacters in a term as a pattern", () => {
    expect(matchCommentRule("win $$$ now", rules(["$$$"]))).toEqual({ reason: "word:$$$" });
    expect(matchCommentRule("a.b.c", rules(["a+b"]))).toBeNull();
  });

  it("returns the first matching term, in the order given; no rules ⇒ null", () => {
    expect(matchCommentRule("spam and scam", rules(["scam", "spam"]))).toEqual({ reason: "word:scam" });
    expect(matchCommentRule("anything", rules([]))).toBeNull();
    expect(matchCommentRule("", rules(["x"]))).toBeNull();
  });
});

describe("matchCommentRule — links", () => {
  it("hides links only when hideLinks is on", () => {
    expect(matchCommentRule("see https://x.example/promo", rules([], true))).toEqual({ reason: "link" });
    expect(matchCommentRule("see https://x.example/promo", rules([], false))).toBeNull();
  });

  it("recognises http(s), www. and bare short-link domains, but not plain sentences", () => {
    expect(containsLink("go to www.cheapdeals.com")).toBe(true);
    expect(containsLink("bit.ly/3abc for free followers")).toBe(true);
    expect(containsLink("visit example.com today")).toBe(true);
    expect(containsLink("Loved it. Great work.Thanks")).toBe(false);
    expect(containsLink("@someone tag your friend")).toBe(false);
  });

  it("a blocked word wins over the link rule (it is checked first)", () => {
    expect(matchCommentRule("scam at example.com", rules(["scam"], true))).toEqual({ reason: "word:scam" });
  });
});

describe("normalizeBlockedWords", () => {
  it("trims, lower-cases, collapses spaces and de-duplicates", () => {
    expect(normalizeBlockedWords(["  Scam ", "scam", "DM  me", "", "   "])).toEqual(["scam", "dm me"]);
  });

  it("caps each term's length and the number of terms", () => {
    expect(normalizeBlockedWords(["x".repeat(100)])[0]!.length).toBe(MAX_BLOCKED_WORD_LENGTH);
    const many = Array.from({ length: 500 }, (_, i) => `w${i}`);
    expect(normalizeBlockedWords(many)).toHaveLength(MAX_BLOCKED_WORDS);
  });
});
