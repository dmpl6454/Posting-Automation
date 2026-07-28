"use client";

import { buildAllSuperTextFontFaceCss } from "@postautomation/super-text";

/**
 * Mounts every super-text @font-face once.
 *
 * The CSS comes from the SAME shared builder the worker feeds to Puppeteer, so
 * the preview and the burn load identical font bytes — the whole point of
 * embedding the face rather than installing it in the worker image. Line-wrap
 * points depend on glyph advance widths, so if these two ever diverged the
 * burned video would break at different words than the preview the user
 * positioned.
 *
 * Rendering ALL faces up front (not just the selected one) means switching fonts
 * in the picker is instant and never flashes a fallback the user might position
 * the strip against.
 *
 * The string is machine-generated from a closed registry — no user input reaches
 * it — and is hoisted to module scope so the ~19KB base64 payload is not
 * re-created on every render.
 *
 * SECURITY: rendered as a TEXT CHILD, not via dangerouslySetInnerHTML. React
 * sets it as textContent, so no markup can be introduced even if the registry
 * were ever changed carelessly. The CSS is base64 plus punctuation and contains
 * no `<`, `>` or `&` for React to escape — asserted by
 * packages/super-text/src/__tests__/super-text-fonts.test.ts, which keeps this
 * rendering path provably correct.
 */
const FONT_FACE_CSS = buildAllSuperTextFontFaceCss();

export function SuperTextFontFaces() {
  if (!FONT_FACE_CSS) return null;
  return <style>{FONT_FACE_CSS}</style>;
}
