#!/usr/bin/env python3
"""
Regenerates packages/super-text/src/fonts/instagram-sans-<weight>.ts from a local
Instagram Sans TTF (the owner's files, 2026-10-03 — NOT fetched from anywhere;
Meta does not publish them under an open licence, see CLAUDE.md).

    pip install fonttools brotli
    python3 scripts/gen-super-text-font-instagram.py InstagramSans-Bold.ttf 700
    python3 scripts/gen-super-text-font-instagram.py "Instagram Sans Medium.ttf" 500
    python3 scripts/gen-super-text-font-instagram.py InstagramSans-Light.ttf 300

The second argument is the weight the registry will DECLARE for this cut; the
script refuses a file whose OS/2 weight class disagrees, because a mismatch makes
Chromium synthesise a weight, and synthetic styles rasterise differently on macOS
vs Alpine — preview and burn would diverge even with identical bytes.

The whole font is embedded (Latin-only, ~24KB as woff2), not a subset, so kerning
(GPOS) and Latin Extended survive. Emitted as a base64 data URI for the same reason
as the Plus Jakarta file: the compose preview and the worker burn must load
literally the same bytes or they wrap at different words.
"""
import base64
import sys

from fontTools.ttLib import TTFont

if len(sys.argv) != 3:
    sys.exit("usage: gen-super-text-font-instagram.py <InstagramSans-*.ttf> <weight 300|500|700>")

src, weight = sys.argv[1], int(sys.argv[2])
font = TTFont(src)
ps_name = font["name"].getDebugName(6)
os2_weight = font["OS/2"].usWeightClass
if not ps_name.startswith("InstagramSans-"):
    sys.exit(f"not an Instagram Sans file (PostScript name {ps_name})")
if os2_weight != weight:
    sys.exit(f"{ps_name} is weight {os2_weight}, but {weight} was requested — declare the cut's real weight")
if "fvar" in font:
    sys.exit("variable fonts are not supported here — supply a static cut")

font.flavor = "woff2"
tmp = f"/tmp/instagram-sans-{weight}.woff2"
font.save(tmp)
raw = open(tmp, "rb").read()
assert raw[:4] == b"wOF2", raw[:4]
if not (5_000 < len(raw) < 120_000):
    sys.exit(f"unexpected woff2 size {len(raw)}B")
b64 = base64.b64encode(raw).decode()
version = font["name"].getDebugName(5)
cmap = font.getBestCmap()
deva = sum(1 for c in cmap if 0x900 <= c <= 0x97F)
out = f"packages/super-text/src/fonts/instagram-sans-{weight}.ts"

with open(out, "w") as fh:
    fh.write(f'''/**
 * GENERATED FILE — do not hand-edit.
 * Regenerate with: python3 scripts/gen-super-text-font-instagram.py <{ps_name}.ttf> {weight}
 *
 * {ps_name} ({version}, OS/2 weight {weight}), supplied by the owner on
 * 2026-10-03 and embedded at their decision — this is Meta's own typeface, not an
 * open-licence face; see CLAUDE.md "Instagram Sans". Full font
 * ({len(font.getGlyphOrder())} glyphs: Latin, Latin-1, Latin Extended-A; Devanagari
 * glyphs: {deva} — Hindi falls through to the classic stack / Noto exactly as
 * before). fsType {font["OS/2"].fsType}.
 * Raw woff2: {len(raw)} bytes -> base64: {len(b64)} chars
 *
 * Embedded as a data URI (not installed in the Docker image) so the compose
 * preview and the worker burn use literally the same bytes and cannot drift.
 */
export const SUPER_TEXT_INSTAGRAM_{weight}_WOFF2_BASE64 =
  "{b64}";
''')
print(f"OK {out} raw={len(raw)}B base64={len(b64)}c weight={weight}")
