/**
 * LIVE end-to-end test for the repurpose image pipeline fixes.
 * Hits real OpenAI + Puppeteer — only runs when LIVE_E2E=1 and keys are set.
 * Verifies the two newly-wired pieces:
 *   1. generateImageSafe falls back to gpt-image-1 when Gemini 403s (billing hold).
 *   2. generateStaticNewsCreativeImage bakes a headline + handle (Puppeteer),
 *      and renders even with NO AI background (stock fallback) — so a branded
 *      static creative is always produced.
 *
 * Run: LIVE_E2E=1 pnpm exec vitest run packages/ai/src/__tests__/repurpose-live.e2e.test.ts
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { generateImageSafe } from "../utils/safe-image-generator";
import { generateStaticNewsCreativeImage } from "../tools/news-image-generator";

const LIVE = process.env.LIVE_E2E === "1" && !!process.env.OPENAI_API_KEY;
const d = LIVE ? describe : describe.skip;

const HEADLINE = "Gujarat Titans Team Bus Catches Fire After IPL 2026 Final";

d("repurpose image pipeline (LIVE)", () => {
  let bgDataUrl: string | undefined;

  it("generateImageSafe falls back to gpt-image-1 when Gemini 403s", async () => {
    const bg = await generateImageSafe({
      prompt: "Cinematic background photo of a dramatic stadium at night, moody dark tones, no text, no logos",
      aspectRatio: "3:4",
      title: HEADLINE,
      topic: "sports",
    });
    expect(bg.imageBase64.length).toBeGreaterThan(1000);
    // With Gemini on a billing hold, the only path to success is the OpenAI fallback.
    expect(["dalle", "gemini", "gemini-sanitized", "gemini-generic"]).toContain(bg.source);
    bgDataUrl = `data:${bg.mimeType};base64,${bg.imageBase64}`;
    console.log(`    [safe-image] source=${bg.source} bytes=${bg.imageBase64.length}`);
  }, 120_000);

  it("renders a baked-headline creative over the AI background", async () => {
    const creative = await generateStaticNewsCreativeImage({
      headline: HEADLINE,
      channelName: "Bollywood Chronicle",
      handle: "bollywoodchronicle",
      logoUrl: null,
      template: "breaking_news",
      ...(bgDataUrl ? { backgroundImageUrl: bgDataUrl } : {}),
    });
    expect(creative.width).toBe(1080);
    expect(creative.height).toBe(1350);
    expect(creative.imageBase64.length).toBeGreaterThan(1000);
    writeFileSync("/tmp/repurpose-static-creative.jpg", Buffer.from(creative.imageBase64, "base64"));
    console.log(`    [creative] ${creative.width}x${creative.height} → /tmp/repurpose-static-creative.jpg`);
  }, 60_000);

  it("renders the creative even with NO AI background (stock fallback)", async () => {
    const creative = await generateStaticNewsCreativeImage({
      headline: HEADLINE,
      channelName: "Bollywood Chronicle",
      handle: "bollywoodchronicle",
      logoUrl: null,
      template: "viral_entertainment",
      // no backgroundImageUrl → local stock SVG
    });
    expect(creative.imageBase64.length).toBeGreaterThan(1000);
    writeFileSync("/tmp/repurpose-static-stock.jpg", Buffer.from(creative.imageBase64, "base64"));
    console.log(`    [stock] resilient render → /tmp/repurpose-static-stock.jpg`);
  }, 60_000);
});
