/**
 * Regression guard for the NewsGrid silent render-failure fix (gap #5, 2026-06-23).
 *
 * Bug: when BOTH the Gemini path AND the Puppeteer-only fallback failed, the
 * router's inner `catch { /* total fallback failure *\/ }` swallowed the error and
 * returned backgroundImageUrl:null with no signal. The NewsGrid UI then masked
 * that null with a client-side CSS preview, so the operator approved + published
 * an IMAGELESS post (which fails on IG/FB).
 *
 * Fix: the router now captures `imageError` (non-null only when both paths fail)
 * and returns it; the UI surfaces it and blocks publishing that channel.
 *
 * Source-level test: the bug is structural ("is the failure swallowed or
 * surfaced"), so we assert the router no longer has the swallowing catch and does
 * record + return imageError.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(
  join(__dirname, "..", "routers", "newsgrid.router.ts"),
  "utf8",
);

describe("newsgrid.generate render-failure handling (gap #5)", () => {
  it("no longer swallows the total fallback failure with an empty catch", () => {
    expect(src).not.toMatch(/catch\s*\{\s*\/\*\s*total fallback failure\s*\*\/\s*\}/);
  });

  it("captures imageError when the fallback render throws", () => {
    expect(src).toMatch(/imageError = \(fallbackErr as Error\)/);
  });

  it("returns imageError to the client (per-channel result)", () => {
    // The per-channel result object (the one carrying backgroundImageUrl) also
    // carries imageError — anchor on backgroundImageUrl to hit the right return.
    const anchor = src.indexOf("backgroundImageUrl,");
    expect(anchor).toBeGreaterThan(-1);
    const window = src.slice(anchor, anchor + 400);
    expect(window).toMatch(/imageError,/);
  });

  it("imageError is declared null by default (only set on real failure)", () => {
    expect(src).toMatch(/let imageError: string \| null = null;/);
  });
});

/**
 * Pure-logic guard for the publish gate: a NewsGrid channel result is publishable
 * only if its creative rendered (no imageError). NewsGrid is an image-card
 * product, so a render failure means there is nothing to publish.
 */
function isPublishable(r: { approved: boolean; imageError?: string | null }) {
  return r.approved && !r.imageError;
}

describe("newsgrid publish gate (gap #5)", () => {
  it("an approved result with no imageError is publishable", () => {
    expect(isPublishable({ approved: true, imageError: null })).toBe(true);
  });
  it("an approved result WITH imageError is NOT publishable", () => {
    expect(isPublishable({ approved: true, imageError: "Image rendering failed" })).toBe(false);
  });
  it("an unapproved result is not publishable regardless", () => {
    expect(isPublishable({ approved: false, imageError: null })).toBe(false);
  });
  it("filtering a mixed set keeps only rendered+approved", () => {
    const set = [
      { approved: true, imageError: null },
      { approved: true, imageError: "boom" },
      { approved: false, imageError: null },
    ];
    expect(set.filter(isPublishable)).toHaveLength(1);
  });
});
