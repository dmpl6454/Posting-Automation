import puppeteer from "puppeteer";
import { generateNewsCardHtml, generateStaticNewsCreativeHtml, type NewsCardOptions, type StaticNewsCreativeOptions } from "./news-card-template";
import { generateImageDallE } from "../providers/dalle.provider";

export interface NewsImageResult {
  imageBase64: string;
  mimeType: string;
  width: number;
  height: number;
  style: "news_card" | "ai_generated";
}

export async function generateNewsCardImage(
  options: NewsCardOptions
): Promise<NewsImageResult> {
  const html = generateNewsCardHtml(options);

  const dimensions = options.platform === "instagram"
    ? { width: 1080, height: 1080 }
    : { width: 1200, height: 675 };

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(dimensions);
    await page.setContent(html, { waitUntil: "networkidle0" });

    const screenshotBuffer = await page.screenshot({
      type: "png",
      encoding: "base64",
    });

    return {
      imageBase64: screenshotBuffer as string,
      mimeType: "image/png",
      width: dimensions.width,
      height: dimensions.height,
      style: "news_card",
    };
  } finally {
    await browser.close();
  }
}

export async function generateNewsAiImage(
  headline: string,
  source: string
): Promise<NewsImageResult> {
  const prompt = `Create a professional, visually striking editorial illustration for a news article titled: "${headline}". Modern, clean, digital art style suitable for social media. No text in the image.`;

  const result = await generateImageDallE({
    prompt,
    size: "1024x1024",
    quality: "standard",
  });

  return {
    imageBase64: result.imageBase64,
    mimeType: result.mimeType,
    width: 1024,
    height: 1024,
    style: "ai_generated",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Static News Creative — full-bleed Instagram 4:5 image via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────
export async function generateStaticNewsCreativeImage(
  options: StaticNewsCreativeOptions
): Promise<NewsImageResult> {
  const html = generateStaticNewsCreativeHtml(options);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });

    const screenshotBuffer = await page.screenshot({
      type: "jpeg",
      quality: 82,
      encoding: "base64",
    });

    return {
      imageBase64: screenshotBuffer as string,
      mimeType: "image/jpeg",
      width: 1080,
      height: 1350,
      style: "news_card",
    };
  } finally {
    await browser.close();
  }
}

export async function generateNewsImage(
  style: "news_card" | "ai_generated",
  options: {
    headline: string;
    source: string;
    sourceUrl?: string;
    logoUrl?: string;
    handle?: string;
    platform: "instagram" | "twitter" | "linkedin" | "facebook";
  }
): Promise<NewsImageResult> {
  if (style === "ai_generated") {
    return generateNewsAiImage(options.headline, options.source);
  }

  return generateNewsCardImage({
    headline: options.headline,
    source: options.source,
    sourceUrl: options.sourceUrl,
    logoUrl: options.logoUrl,
    handle: options.handle,
    platform: options.platform,
  });
}

/**
 * Generate a relevant background image for a news headline using DALL-E.
 * Returns a data URL that can be used as backgroundImageUrl in StaticNewsCreativeOptions.
 */
export async function generateRelevantBackground(
  headline: string
): Promise<string | null> {
  try {
    const prompt = `Create a cinematic, atmospheric background photo for a news article about: "${headline}". The image should be a dramatic, editorial-quality photograph — moody lighting, shallow depth of field, relevant subject matter. NO text, NO logos, NO overlays. Just a beautiful, relevant background image.`;

    const result = await generateImageDallE({
      prompt,
      size: "1024x1792",
      quality: "standard",
    });

    return `data:${result.mimeType};base64,${result.imageBase64}`;
  } catch (err) {
    console.warn(`[NewsImage] Background generation failed, will use fallback:`, (err as Error).message);
    return null;
  }
}
