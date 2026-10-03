# Super Text embedded fonts

Two generated files live here — never hand-edit either:

| file | face | weight | regenerate with |
|---|---|---|---|
| `instagram-sans-500.ts` | **Instagram Sans Medium** (the real one) | 500 | `python3 scripts/gen-super-text-font-instagram.py <path to Instagram Sans Medium.ttf>` |
| `plus-jakarta-sans-800-latin.ts` | Plus Jakarta Sans (SIL OFL stand-in) | 800 | `node scripts/gen-super-text-font.mjs` |

## Why embedded rather than installed in the worker image

The compose preview (browser) and the burn (worker Chromium) must use the *same*
font, or the strip wraps at different words and the burned video does not match
what the user positioned. Line-break points depend on glyph advance widths, and
the strip is width-clamped at the layout's `maxWidthPct`, so a different metric
means a different number of lines → a different strip height.

Embedding the bytes in the shared HTML makes that structurally true instead of a
deployment promise. It also means `docker/Dockerfile.worker` needs **no** new
font package, which avoids the workspace-package Docker trap documented as quirk
#10 in [CLAUDE.md](../../../../CLAUDE.md) (and the fact that `.dockerignore` is
empty, so a local `docker build` can't validate a font install anyway).

The consequence to remember: because the font is a webfont, the worker **must**
wait for it before screenshotting. `page.setContent(html, { waitUntil: "load" })`
does *not* wait for `@font-face`. See `renderStripPng` in
`apps/worker/src/workers/super-text.worker.ts` — it asks `document.fonts.load()`
for the face **at the registry's declared weight**. Asking for `700` when the only
`@font-face` is 500 reports a synthesised match, the wait passes early, and the
fallback face is baked.

## Instagram Sans (2026-10-03) — the owner's file, the owner's decision

`instagram-sans-500.ts` is the real **Instagram Sans Medium** (`InstagramSans-Medium`,
version 4.002, OS/2 weight 500, `fsType 0`), supplied by the owner as a TTF and
converted whole to woff2 (~24KB). It is Latin + Latin-1 + Latin Extended-A only
(746 glyphs, **no Devanagari**): Hindi text falls through per-glyph to the classic
stack / Noto exactly as before.

**Licence position, stated plainly:** Instagram Sans is Meta's proprietary typeface.
Meta publishes it for content made for Instagram; its terms do not cover embedding it
in a third-party product. The owner chose to embed it anyway, knowing that. Do not
widen its exposure: it must not be served from a public CDN, used on the marketing
site, or published in any package. It ships only inside the strip HTML (preview and
burn) and the compose bundle.

It is the **default for new strips** (`SUPER_TEXT_DEFAULTS.font`) and the face the
`insta` layout and the `M` size preset are now measured against: at `fontSizePct`
4.8 on a 1080-wide frame it reproduces the owner's reference clip — cap height 37px
(reference 37), pill 156px tall (152), 920px wide (908), same two-line break.

## Why Plus Jakarta Sans is still here

It was the stand-in before the real face arrived, and existing posts/drafts store
`font: "sans"`. The key must stay so those configs keep rendering (and keep their
cached burns valid — the worker keys S3 objects on `sha1(JSON.stringify(config))`).

### Why not DM Sans (the first attempt)

DM Sans 700 shipped first because it is the closest match to Instagram Sans *on
paper*. In practice it was a mistake: at the dialog's real size it is nearly
indistinguishable from Arial (measured: **0.4%** width delta on typical text), so
the picker did not read as a real choice and the owner reported "I can see no
difference." Plus Jakarta Sans 800 gives a **4.8%** delta and an obviously
different face.

The lesson for anyone changing a face: **judge a candidate by whether a user can
tell it apart at ~23px, not by how well its metrics match on paper.** Render it —
do not reason about it.

### Weights

The `@font-face` weight and `SUPER_TEXT_FONTS.<key>.weight` must stay equal for
every embedded face, or Chromium synthesises a weight, and synthetic rasterisation
differs between macOS and Alpine — test-locked. `sans` is 800 (700 sat too close to
Arial Bold); `instagram` is 500 because that is the cut the owner supplied.

Tracking per face is `SUPER_TEXT_FONTS.<key>.letterSpacingEm` in `../constants.ts`
— the only fidelity dial. Both embedded faces sit at 0 (no declaration emitted).

## Coverage

Only Latin is embedded for both faces. Non-Latin text (Devanagari, Arabic, CJK)
falls through per-glyph to the rest of the stack — `font-noto` in the worker
image, the OS font in the browser — which is exactly what happens with the
classic Arial/Liberation Sans stack, so this is not a regression. If Hindi super
text becomes common, add a second embedded entry with a `unicode-range`.

## Adding or swapping a face

1. Convert it to **woff2 at the weight you declare** — a real cut, not a lighter
   one (see Weights above).
2. Generate the base64 module (copy one of the two scripts) and import it in
   `../constants.ts`.
3. Add a key to `SUPER_TEXT_FONT_KEYS` and an entry to `SUPER_TEXT_FONTS`. The
   stack must start with the embedded family and end with the classic stack.
4. Re-run the parity check: render two-line text over a real frame (the scratch
   scripts in the 2026-10-02/03 sessions did this with Playwright + sharp) and
   confirm cap height, pill size and the line-break words.

Existing `font` enum values (`classic` / `sans` / `instagram`) must **not** be
renamed or removed — posts and drafts reference them.
