/**
 * Regenerates packages/super-text/src/fonts/dm-sans-700-latin.ts.
 *
 * Fetches the LATIN subset of DM Sans at weight 700 from Google Fonts and emits
 * it as a base64 woff2 string. Google serves woff2 only to a modern UA, so the
 * User-Agent header below is load-bearing — without it you get ttf and the
 * payload balloons.
 *
 * The font is EMBEDDED as a data URI rather than installed into the worker image
 * so the compose preview (browser) and the burn (worker Chromium) load literally
 * the same bytes. Line-wrap points depend on glyph advance widths, so "same font
 * in both environments" has to be structurally true, not a deployment promise.
 *
 * Usage: node scripts/gen-super-text-font.mjs
 */
import { writeFileSync } from "node:fs";

const CSS_URL = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@700&display=block";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT = "packages/super-text/src/fonts/dm-sans-700-latin.ts";

const cssRes = await fetch(CSS_URL, { headers: { "User-Agent": UA } });
if (!cssRes.ok) throw new Error(`Google Fonts CSS fetch failed: HTTP ${cssRes.status}`);
const css = await cssRes.text();

// Google's CSS emits one @font-face per subset, each preceded by a /* subset */
// comment. Take the block commented `latin` (NOT latin-ext, a different file).
const blocks = css.split("/*").map((b) => "/*" + b);
const latin = blocks.find((b) => b.startsWith("/* latin */"));
if (!latin) {
  throw new Error(
    `no /* latin */ block in the Google Fonts CSS — did the response format change?\n${css.slice(0, 400)}`
  );
}

const url = latin.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
if (!url) throw new Error("no woff2 URL in the latin block — is the UA being honoured?");

const weight = latin.match(/font-weight:\s*(\d+)/)?.[1];
if (weight !== "700") {
  throw new Error(
    `expected weight 700, got ${weight}. A Regular file would make Chromium ` +
      `synthesise fake bold, which rasterises differently on macOS vs Alpine.`
  );
}

const fontRes = await fetch(url, { headers: { "User-Agent": UA } });
if (!fontRes.ok) throw new Error(`font fetch failed: HTTP ${fontRes.status}`);
const buf = Buffer.from(await fontRes.arrayBuffer());

// woff2 files start with the ASCII signature "wOF2".
const magic = buf.subarray(0, 4).toString("ascii");
if (magic !== "wOF2") throw new Error(`downloaded file is not woff2 (magic: ${magic})`);

// Sanity bound: the latin subset of one weight is ~15-30KB. Far outside that
// range means we grabbed the wrong thing (full family, or a variable font).
if (buf.length < 5_000 || buf.length > 120_000) {
  throw new Error(`unexpected font size ${buf.length}B — expected ~15-30KB for one latin subset`);
}

const base64 = buf.toString("base64");

writeFileSync(
  OUT,
  `/**
 * GENERATED FILE — do not hand-edit.
 * Regenerate with: node scripts/gen-super-text-font.mjs
 *
 * DM Sans 700 (latin subset), SIL Open Font License 1.1.
 * Source: ${url}
 * Raw: ${buf.length} bytes -> base64: ${base64.length} chars
 *
 * Embedded as a data URI (not installed in the Docker image) so the compose
 * preview and the worker burn use literally the same bytes and cannot drift.
 */
export const DM_SANS_700_LATIN_WOFF2_BASE64 =
  "${base64}";
`
);

console.log(`OK ${OUT}  raw=${buf.length}B base64=${base64.length}c weight=${weight}`);
