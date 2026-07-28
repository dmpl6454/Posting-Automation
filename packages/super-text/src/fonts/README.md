# Super Text embedded fonts

`plus-jakarta-sans-800-latin.ts` is **generated** — run `node scripts/gen-super-text-font.mjs`.

## Why embedded rather than installed in the worker image

The compose preview (browser) and the burn (worker Chromium) must use the *same*
font, or the strip wraps at different words and the burned video does not match
what the user positioned. Line-break points depend on glyph advance widths, and
the strip is width-clamped at `STRIP_MAX_WIDTH_PCT`, so a different metric means
a different number of lines → a different strip height.

Embedding the bytes in the shared HTML makes that structurally true instead of a
deployment promise. It also means `docker/Dockerfile.worker` needs **no** new
font package, which avoids the workspace-package Docker trap documented as quirk
#10 in [CLAUDE.md](../../../../CLAUDE.md) (and the fact that `.dockerignore` is
empty, so a local `docker build` can't validate a font install anyway).

The consequence to remember: because the font is a webfont, the worker **must**
wait for it before screenshotting. `page.setContent(html, { waitUntil: "load" })`
does *not* wait for `@font-face`. See `renderStripPng` in
`apps/worker/src/workers/super-text.worker.ts`.

## Which face, and why not Instagram Sans

Instagram Sans is Meta's proprietary typeface and is not licensed for
third-party redistribution — that exclusivity is the point of it. The shipped
stand-in is **Plus Jakarta Sans 800** (SIL OFL 1.1): geometric, large x-height,
tight, and — importantly — a **double-storey `a`**, like Instagram Sans.

### Why not DM Sans (the first attempt)

DM Sans 700 shipped first because it is the closest match to Instagram Sans *on
paper*. In practice it was a mistake: at the dialog's real size it is nearly
indistinguishable from Arial (measured: **0.4%** width delta on typical text), so
the picker did not read as a real choice and the owner reported "I can see no
difference." Plus Jakarta Sans 800 gives a **4.8%** delta and an obviously
different face.

The lesson for anyone changing this: **judge a candidate by whether a user can
tell it apart from Classic at ~23px, not by how well its metrics match Instagram
Sans.** Render it — do not reason about it.

### Weight is 800, not 700

Plus Jakarta Sans at 700 sits too close to Arial Bold. The 800 cut is what makes
the difference legible. The `@font-face` weight and
`SUPER_TEXT_FONTS.sans.weight` must stay equal or Chromium synthesises bold,
which rasterises differently on macOS vs Alpine — test-locked.

Tracking is tightened via `SUPER_TEXT_FONTS.sans.letterSpacingEm` in
`../constants.ts`. **That is the fidelity dial** — adjust it there, nowhere else.

## Coverage

Only the **latin** subset is embedded. Non-Latin text (Devanagari, Arabic, CJK)
falls through per-glyph to the rest of the stack — `font-noto` in the worker
image, the OS font in the browser — which is exactly what happens today with
Arial/Liberation Sans, so this is not a regression. If Hindi super text becomes
common, add a second embedded entry with a `unicode-range`.

## Swapping in a licensed face

1. Convert it to **woff2 at the weight you declare** (currently 800) — a real cut,
   not a lighter one. A mismatch makes Chromium synthesise fake bold, and
   synthetic-bold rasterisation differs between macOS and Alpine, so preview and
   burn would diverge even with identical bytes.
2. Base64 it and replace the string in `plus-jakarta-sans-800-latin.ts` (rename
   the file and its export if you like; update the import in `../constants.ts`).
3. Update `EMBEDDED_SANS_FAMILY` in `../constants.ts` to the correct family name.
4. Re-run the parity check: burn two-line text, extract a frame with ffmpeg, and
   confirm the line-break words match the compose preview.

The `font` enum values (`classic` / `sans`) must **not** change — existing posts
and drafts reference them.
