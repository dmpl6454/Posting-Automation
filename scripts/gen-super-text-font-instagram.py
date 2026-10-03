#!/usr/bin/env python3
"""
Regenerates packages/super-text/src/fonts/instagram-sans-500.ts from a local
Instagram Sans Medium TTF (the owner's file, 2026-10-03 — NOT fetched from
anywhere; Meta does not publish it under an open licence, see CLAUDE.md).

    pip install fonttools brotli
    python3 scripts/gen-super-text-font-instagram.py "/path/to/Instagram Sans Medium.ttf"

The whole font is embedded (it is Latin-only, ~24KB as woff2), not a subset, so
kerning (GPOS) and Latin Extended survive. Emitted as a base64 data URI for the
same reason as the Plus Jakarta file: the compose preview and the worker burn must
load literally the same bytes or they wrap at different words.
"""
import base64
import sys

from fontTools.ttLib import TTFont

OUT = "packages/super-text/src/fonts/instagram-sans-500.ts"
EXPECTED_WEIGHT = 500
EXPECTED_PS_NAME = "InstagramSans-Medium"

if len(sys.argv) != 2:
    sys.exit("usage: gen-super-text-font-instagram.py <Instagram Sans Medium.ttf>")

font = TTFont(sys.argv[1])
ps_name = font["name"].getDebugName(6)
weight = font["OS/2"].usWeightClass
if ps_name != EXPECTED_PS_NAME or weight != EXPECTED_WEIGHT:
    # A different cut would make Chromium synthesise bold/light against the
    # registry's declared weight, and synthetic styles rasterise differently on
    # macOS vs Alpine — preview and burn would diverge even with identical bytes.
    sys.exit(f"expected {EXPECTED_PS_NAME} at weight {EXPECTED_WEIGHT}, got {ps_name} at {weight}")
if "fvar" in font:
    sys.exit("variable fonts are not supported here — supply the static Medium cut")

font.flavor = "woff2"
tmp = "/tmp/instagram-sans-500.woff2"
font.save(tmp)
raw = open(tmp, "rb").read()
assert raw[:4] == b"wOF2", raw[:4]
if not (5_000 < len(raw) < 120_000):
    sys.exit(f"unexpected woff2 size {len(raw)}B")
b64 = base64.b64encode(raw).decode()
version = font["name"].getDebugName(5)
cmap = font.getBestCmap()
deva = sum(1 for c in cmap if 0x900 <= c <= 0x97F)

with open(OUT, "w") as fh:
    fh.write(f'''/**
 * GENERATED FILE — do not hand-edit.
 * Regenerate with: python3 scripts/gen-super-text-font-instagram.py <path to Instagram Sans Medium.ttf>
 *
 * Instagram Sans Medium ({ps_name}, {version}, OS/2 weight {weight}),
 * supplied by the owner on 2026-10-03 and embedded at their decision — this is
 * Meta's own typeface, not an open-licence face; see CLAUDE.md "Instagram Sans".
 * Full font ({len(font.getGlyphOrder())} glyphs: Latin, Latin-1, Latin Extended-A;
 * Devanagari glyphs: {deva} — Hindi falls through to the classic stack / Noto
 * exactly as before). fsType {font["OS/2"].fsType}.
 * Raw woff2: {len(raw)} bytes -> base64: {len(b64)} chars
 *
 * Embedded as a data URI (not installed in the Docker image) so the compose
 * preview and the worker burn use literally the same bytes and cannot drift.
 */
export const SUPER_TEXT_INSTAGRAM_WOFF2_BASE64 =
  "{b64}";
''')
print(f"OK {OUT} raw={len(raw)}B base64={len(b64)}c weight={weight}")
