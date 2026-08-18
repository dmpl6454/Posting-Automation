import { describe, it, expect } from "vitest";
import { captionsMatch, LISTING_MESSAGE_MAX, normalizeCaption } from "../utils/publish-reconcile";

/**
 * Caption matching decides whether a post already on the account IS the one we
 * just tried to publish. A false positive records someone else's post id as ours.
 */
describe("captionsMatch", () => {
  it("matches identical captions, whitespace differences aside", () => {
    expect(captionsMatch("hello  world\n", "hello world")).toBe(true);
  });

  it("does not match different captions", () => {
    expect(captionsMatch("hello world", "goodbye world")).toBe(false);
  });

  it("matches a caption the listing edge truncated at its 2000-char cap", () => {
    const full = "x".repeat(2200);
    expect(captionsMatch(full.slice(0, LISTING_MESSAGE_MAX), full)).toBe(true);
  });

  it("REFUSES to adopt a post whose caption merely EXTENDS ours (review finding)", () => {
    // The dangerous direction: the account holds "<ours> + tail" from a different
    // post. A symmetric prefix test would treat that as a match.
    const ours = "y".repeat(500);
    expect(captionsMatch(`${ours} and a different tail`, ours)).toBe(false);
  });

  it("REFUSES a short listed prefix that is not at the truncation boundary", () => {
    const published = "z".repeat(900);
    expect(captionsMatch(published.slice(0, 400), published)).toBe(false);
  });

  it("never matches on an empty side", () => {
    expect(captionsMatch("", "anything")).toBe(false);
    expect(captionsMatch("anything", "   ")).toBe(false);
  });

  it("normalizeCaption collapses whitespace and trims", () => {
    expect(normalizeCaption("  a \n\t b  ")).toBe("a b");
  });
});
