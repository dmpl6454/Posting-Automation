import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level contract for the Super Text dialog (no component harness here).
 *
 * Owner report 2026-09-02 (screenshot): "There is no submit button for applying
 * super text and if we click outside it disappears so there is need to apply
 * scroll." Two defects, both locked below:
 *
 *  1. The editor (stage + text + colours + fonts + sizes) is taller than a
 *     laptop viewport and DialogContent had no max-height — the footer, the
 *     ONLY way to apply, rendered below the fold with no way to reach it.
 *  2. Radix's default outside-click dismissed the dialog and silently discarded
 *     every edit. Escape still cancels (a deliberate gesture); a stray click on
 *     the page behind is not.
 */
const ROOT = join(__dirname, "..", "..", "..");
const src = readFileSync(
  join(ROOT, "apps/web/components/content-agent/SuperTextEditor.tsx"),
  "utf8"
);

describe("the Apply footer is always reachable", () => {
  it("caps the dialog height and makes ONLY the middle scroll", () => {
    expect(src).toMatch(/max-h-\[92dvh\]/);
    expect(src).toMatch(/min-h-0 flex-1 space-y-3 overflow-y-auto/);
  });

  it("pins header and footer outside the scroll region", () => {
    expect(src).toMatch(/DialogHeader className="flex-none"/);
    expect(src).toMatch(/DialogFooter className="flex-none/);
  });

  it("still has the Apply / Cancel / Remove actions", () => {
    expect(src).toMatch(/>\s*Apply\s*</);
    expect(src).toMatch(/>\s*Cancel\s*</);
    expect(src).toMatch(/>\s*Remove\s*</);
  });
});

describe("an outside click cannot silently discard the edits", () => {
  it("prevents interact-outside dismissal", () => {
    expect(src).toMatch(/onInteractOutside=\{\(e\) => e\.preventDefault\(\)\}/);
  });
});
