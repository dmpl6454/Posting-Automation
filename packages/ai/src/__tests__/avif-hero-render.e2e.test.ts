/**
 * REPRO + FIX GATE: a hero photo served as image/avif (HT/news CDNs content-
 * negotiate AVIF) must still render INTO the static creative. Before the fix, the
 * safeImageUrl/safeCardImageUrl regexes rejected `data:image/avif` → photoless
 * card (blank gradient). Chrome decodes avif fine, so allowing avif in the
 * sanitizers is the fix.
 *
 * This test renders premium_editorial with a forced-avif hero and asserts the
 * output is NOT a near-flat gradient (i.e. the photo actually painted), by
 * sampling pixel diversity inside the rendered page via Chrome itself.
 *
 * Gated on LIVE_E2E=1.
 * Run: LIVE_E2E=1 pnpm --filter @postautomation/ai exec vitest run src/__tests__/avif-hero-render.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import { buildStaticCreative } from "../tools/creative-templates";
import puppeteer from "puppeteer";

const LIVE = process.env.LIVE_E2E === "1";
const d = LIVE ? describe : describe.skip;

const HT_HERO =
  "https://www.hindustantimes.com/ht-img/img/2026/06/26/550x309/IRAN-CRISIS-LEBANON-ISRAEL-13_1782506050259_1782506059225_511aaa5e-7c88-43c1-88b9-56c244b2d1b7.JPG";

/** Fetch the hero and force-label it as avif (the failing CDN case). */
async function avifHeroDataUri(): Promise<string> {
  const r = await fetch(HT_HERO, { headers: { Accept: "image/avif,image/*" } });
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:image/avif;base64,${buf.toString("base64")}`;
}

/** Render an HTML string in Chrome, SCREENSHOT it, and count distinct color
 *  buckets across the screenshot. A flat gradient card has very few; a real photo
 *  has many. Screenshotting (not an in-page canvas) avoids canvas-taint/probe flakiness. */
async function colorDiversity(html: string): Promise<number> {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });
    await page.setContent(html, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
    const b64 = (await page.screenshot({ type: "png", encoding: "base64" })) as string;
    // Decode the PNG inside the page (Chrome) and bucket the colors of the TOP 60%
    // of the card (where the photo lives; the bottom has the headline text block).
    // The callback runs in the browser context; `eslint`/`tsc` (node libs) don't
    // know `Image`/`document`, so the body is authored as a string-free closure and
    // the browser globals are referenced via `globalThis` to keep tsc happy.
    const fn = async (pngB64: string): Promise<number> => {
      const g = globalThis as any;
      const img = new g.Image();
      await new Promise((res) => { img.onload = res; img.src = `data:image/png;base64,${pngB64}`; });
      const c = g.document.createElement("canvas");
      c.width = 80; c.height = 100;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, 80, 100);
      const data = ctx.getImageData(0, 0, 80, 60).data; // top 60%
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += 4) {
        seen.add(`${data[i] >> 5},${data[i + 1] >> 5},${data[i + 2] >> 5}`);
      }
      return seen.size;
    };
    return await page.evaluate(fn, b64);
  } finally {
    await browser.close();
  }
}

d("AVIF hero renders into the static creative", () => {
  it("premium_editorial with an avif hero shows the photo (diverse pixels, not a flat gradient)", async () => {
    const hero = await avifHeroDataUri();
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "Israel and Lebanon",
      channelName: "Moviefied",
      bgImageUrl: hero,
      theme: "dark",
    } as any);
    const diversity = await colorDiversity(html);
    console.log(`  [avif-render] background color buckets = ${diversity} (flat gradient ≈ 0-3, real photo ≫ 8)`);
    expect(diversity).toBeGreaterThan(8);
  }, 120_000);
});
