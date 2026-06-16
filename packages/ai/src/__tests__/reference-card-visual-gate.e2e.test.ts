/**
 * VISUAL GATE (Round 10) — live render of generateReferenceStyledCard against a
 * REAL user style reference, through the REAL provider stack (raw Gemini
 * image-to-image + describeImageStyle + gpt-image-1 + Puppeteer overlay).
 *
 * This is the definition-of-done for Round 10: the rendered PNG must reproduce
 * the reference's LAYOUT (eyebrow, photo region, headline position, gradient),
 * not just its color. The harness only WRITES the PNGs; a human (the orchestrator)
 * VIEWS them to confirm the layout matches.
 *
 * Run (keys must be exported into the env):
 *   VISUAL_GATE=1 GOOGLE_GEMINI_API_KEY=… OPENAI_API_KEY=… \
 *     pnpm --filter @postautomation/ai exec vitest run \
 *     src/__tests__/reference-card-visual-gate.e2e.test.ts
 *
 * Output PNGs land in /tmp/round10-gate/.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateReferenceStyledCard,
  overlayHeadlineAndLogo,
  type ReferenceCardDeps,
  type RefImageInput,
} from "../tools/reference-card-generator";
import { generateImage as nanoBananaGenerate } from "../providers/nano-banana.provider";
import { describeImageStyle } from "../tools/describe-image-style";
import { generateImageDallE } from "../providers/dalle.provider";
import { launchCreativeBrowser } from "../tools/news-image-generator";

const LIVE = process.env.VISUAL_GATE === "1" && !!process.env.GOOGLE_GEMINI_API_KEY;
const d = LIVE ? describe : describe.skip;

const OUT_DIR = "/tmp/round10-gate";

/** The production deps wiring — identical to what repurpose.router.ts passes. */
const realDeps: ReferenceCardDeps = {
  generateImage: async (params) => {
    const r = await nanoBananaGenerate({
      prompt: params.prompt,
      aspectRatio: params.aspectRatio,
      ...(params.referenceImages ? { referenceImages: params.referenceImages } : {}),
    });
    return { imageBase64: r.imageBase64, mimeType: r.mimeType };
  },
  describeImageStyle: (b, m) => describeImageStyle(b, m),
  generateImageDallE: async (params) => {
    const r = await generateImageDallE({
      prompt: params.prompt,
      ...(params.size ? { size: params.size as never } : {}),
      ...(params.quality ? { quality: params.quality as never } : {}),
    });
    return { imageBase64: r.imageBase64, mimeType: r.mimeType };
  },
  overlayHeadlineAndLogo: (o) => overlayHeadlineAndLogo(o),
};

function loadRef(file: string): RefImageInput {
  const buf = readFileSync(join(homedir(), "Downloads", file));
  const mimeType = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return { base64: buf.toString("base64"), mimeType };
}

/**
 * Render a distinctive NON-PERSON reference card via Puppeteer — the "Hollywood
 * Calendar" family the user wants: cream bg, italic centered eyebrow, centered
 * serif headline with highlighted words, a 4-tile filmstrip row, centered footer.
 * No real people → Gemini's policy classifier will run img2img on it, so this
 * PROVES rung-1's layout-mimic works (the celebrity case lands on rung-2 because
 * Gemini refuses identifiable real faces — a provider policy, not our code).
 */
async function buildSyntheticRef(): Promise<RefImageInput> {
  const tile = (c: string) => `<div style="flex:1;height:170px;border-radius:10px;background:${c};"></div>`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,600&family=Inter:wght@400;600;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1080px;height:1350px;background:#f4ece0;font-family:'Inter',sans-serif;display:flex;flex-direction:column;align-items:center;padding:70px 64px;}
.eyebrow{font-family:'Playfair Display',serif;font-style:italic;font-size:30px;color:#b07a2a;letter-spacing:1px;margin-bottom:28px;}
.headline{font-family:'Playfair Display',serif;font-weight:700;font-size:64px;line-height:1.12;text-align:center;color:#23201c;max-width:900px;margin-bottom:14px;}
.hl{background:#f2c879;padding:0 8px;border-radius:4px;}
.sub{font-size:22px;color:#6b6258;text-align:center;margin-bottom:46px;}
.filmstrip{display:flex;gap:18px;width:100%;margin-top:auto;margin-bottom:40px;}
.footer{display:flex;align-items:center;gap:12px;}
.dot{width:34px;height:34px;border-radius:50%;background:#b07a2a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;}
.fname{font-weight:800;font-size:20px;color:#23201c;}
</style></head><body>
<div class="eyebrow">Your Hollywood Calendar</div>
<div class="headline">The <span class="hl">Biggest Films</span> Lighting Up <span class="hl">This Summer</span></div>
<div class="sub">Mark your dates — the lineup you can't miss</div>
<div class="filmstrip">${tile("#c98a3a")}${tile("#7a93b0")}${tile("#9c6b8a")}${tile("#5f8a6b")}</div>
<div class="footer"><div class="dot">C</div><div class="fname">CineToday</div></div>
</body></html>`;
  const browser = await launchCreativeBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });
    await page.setContent(html, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const buf = (await page.screenshot({ type: "png", encoding: "base64" })) as string;
    writeFileSync(join(OUT_DIR, "synthetic-ref.png"), Buffer.from(buf, "base64"));
    return { base64: buf, mimeType: "image/png" };
  } finally {
    await browser.close().catch(() => {});
  }
}

d("Round 11 COMPOSITE gate — REAL Moviefied celebrity reference + real hero photo", () => {
  mkdirSync(OUT_DIR, { recursive: true });
  // The user's ACTUAL reference (contains a real celebrity → Gemini refuses full
  // img2img). The composite path passes ONLY this ref to Gemini (with the photo
  // region as a magenta sentinel — no face), then pastes the REAL hero photo into
  // the detected region locally. The hero here is a real celebrity portrait; in
  // prod it's the article's own photo. This is the true test of the user's case.
  const reference = loadRef("MoviefiedPostRef.jpg");
  const hero = loadRef("MoviefiedPostRef.jpg"); // real face, composited locally (never sent to Gemini)
  const headline = "Shah Rukh Khan Announces Surprise Comeback Film After Two-Year Break";
  const brandName = "Moviefied";
  const handle = "@moviefiedbollywood";

  it('composite path: layout via Gemini sentinel + real photo pasted — "ai" text', async () => {
    const out = await generateReferenceStyledCard(
      { referenceImage: reference, heroImage: hero, headline, brandName, handle, brandColor: "#ff7a00", textMode: "ai" },
      realDeps,
    );
    console.log(`    [gate composite ai] engine=${out.engine} bytes=${out.imageBase64.length}`);
    expect(out.imageBase64.length).toBeGreaterThan(5000);
    writeFileSync(join(OUT_DIR, `composite-ai-${out.engine}.${out.mimeType.includes("png") ? "png" : "jpg"}`), Buffer.from(out.imageBase64, "base64"));
  }, 240_000);

  it('composite path: "overlay" text mode', async () => {
    const out = await generateReferenceStyledCard(
      { referenceImage: reference, heroImage: hero, headline, brandName, handle, brandColor: "#ff7a00", textMode: "overlay" },
      realDeps,
    );
    console.log(`    [gate composite overlay] engine=${out.engine} bytes=${out.imageBase64.length}`);
    expect(out.imageBase64.length).toBeGreaterThan(5000);
    writeFileSync(join(OUT_DIR, `composite-overlay-${out.engine}.${out.mimeType.includes("png") ? "png" : "jpg"}`), Buffer.from(out.imageBase64, "base64"));
  }, 240_000);
});

d("Round 10 visual gate — Moviefied reference", () => {
  mkdirSync(OUT_DIR, { recursive: true });
  // The Moviefied reference is the WHOLE Instagram screenshot; the card we want
  // to mimic is the left portrait half (photo + eyebrow + bottom headline + M logo).
  const reference = loadRef("MoviefiedPostRef.jpg");
  // Production passes the article's OWN photo (a real person, in this celebrity-
  // news domain) as the hero so the WITH_HERO clause lets Gemini preserve it.
  // The reference itself contains a usable portrait, so reuse it as the hero here.
  const hero = loadRef("MoviefiedPostRef.jpg");
  const headline = "Shah Rukh Khan Announces Surprise Comeback Film After Two-Year Break";
  const brandName = "Moviefied";
  const handle = "@moviefiedbollywood";

  it('"ai" text mode — Gemini renders the headline inside the recreated layout', async () => {
    const out = await generateReferenceStyledCard(
      { referenceImage: reference, heroImage: hero, headline, brandName, handle, brandColor: "#ff7a00", textMode: "ai" },
      realDeps,
    );
    console.log(`    [gate ai] engine=${out.engine} bytes=${out.imageBase64.length}`);
    expect(out.engine).not.toBe("template");
    expect(out.imageBase64.length).toBeGreaterThan(5000);
    writeFileSync(join(OUT_DIR, `moviefied-ai.${out.mimeType.includes("png") ? "png" : "jpg"}`), Buffer.from(out.imageBase64, "base64"));
  }, 180_000);

  it('"overlay" text mode — Gemini leaves headline space, code overlays exact text', async () => {
    const out = await generateReferenceStyledCard(
      { referenceImage: reference, heroImage: hero, headline, brandName, handle, brandColor: "#ff7a00", textMode: "overlay" },
      realDeps,
    );
    console.log(`    [gate overlay] engine=${out.engine} bytes=${out.imageBase64.length}`);
    expect(out.engine).not.toBe("template");
    expect(out.imageBase64.length).toBeGreaterThan(5000);
    writeFileSync(join(OUT_DIR, `moviefied-overlay.${out.mimeType.includes("png") ? "png" : "jpg"}`), Buffer.from(out.imageBase64, "base64"));
  }, 180_000);
});

d("Round 10 visual gate — synthetic filmstrip reference (Gemini rung-1 layout proof)", () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const brandName = "CineToday";
  const handle = "@cinetoday";
  const headline = "Five Blockbusters That Will Define This Festive Season";

  it('rung-1 Gemini reproduces the cream/eyebrow/filmstrip layout — "ai" text mode', async () => {
    const reference = await buildSyntheticRef();
    const out = await generateReferenceStyledCard(
      { referenceImage: reference, headline, brandName, handle, brandColor: "#b07a2a", textMode: "ai" },
      realDeps,
    );
    console.log(`    [gate synth ai] engine=${out.engine} bytes=${out.imageBase64.length}`);
    expect(out.imageBase64.length).toBeGreaterThan(5000);
    writeFileSync(join(OUT_DIR, `synthetic-ai-${out.engine}.${out.mimeType.includes("png") ? "png" : "jpg"}`), Buffer.from(out.imageBase64, "base64"));
  }, 180_000);

  it('rung-1 Gemini reproduces the layout — "overlay" text mode', async () => {
    const reference = await buildSyntheticRef();
    const out = await generateReferenceStyledCard(
      { referenceImage: reference, headline, brandName, handle, brandColor: "#b07a2a", textMode: "overlay" },
      realDeps,
    );
    console.log(`    [gate synth overlay] engine=${out.engine} bytes=${out.imageBase64.length}`);
    expect(out.imageBase64.length).toBeGreaterThan(5000);
    writeFileSync(join(OUT_DIR, `synthetic-overlay-${out.engine}.${out.mimeType.includes("png") ? "png" : "jpg"}`), Buffer.from(out.imageBase64, "base64"));
  }, 180_000);
});
