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

// ─────────────────────────────────────────────────────────────────────────────
// Logo Overlay — stamp logo + channel name on any base64 image via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────
export interface LogoOverlayOptions {
  /** Base64-encoded source image */
  imageBase64: string;
  /** MIME type of the source image */
  mimeType: string;
  /** Image dimensions */
  width: number;
  height: number;
  /** Logo URL (channel avatar or custom logo) */
  logoUrl?: string;
  /** Channel name displayed next to logo */
  channelName?: string;
  /** Channel handle displayed below name */
  channelHandle?: string;
  /** Position: bottom-left (default), bottom-right, top-left, top-right */
  position?: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  /** Accent color for fallback initial avatar */
  accentColor?: string;
  /** Opacity of the branding bar background (0-1, default 0.85) */
  opacity?: number;
}

export async function overlayLogoOnImage(options: LogoOverlayOptions): Promise<{ imageBase64: string; mimeType: string }> {
  const {
    imageBase64, mimeType, width, height,
    logoUrl, channelName, channelHandle,
    position = "bottom-left",
    accentColor = "#e11d48",
    opacity = 0.85,
  } = options;

  // If no logo and no channel name, return original image
  if (!logoUrl && !channelName) {
    return { imageBase64, mimeType };
  }

  const dataUrl = `data:${mimeType};base64,${imageBase64}`;
  const initial = (channelName?.[0] ?? "C").toUpperCase();

  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" style="width:48px;height:48px;border-radius:12px;object-fit:cover;border:2px solid rgba(255,255,255,0.2);flex-shrink:0;" crossorigin="anonymous" />`
    : `<div style="width:48px;height:48px;border-radius:12px;background:${accentColor};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:20px;flex-shrink:0;">${initial}</div>`;

  const nameHtml = channelName
    ? `<div style="color:#fff;font-size:18px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 4px rgba(0,0,0,0.6);">${channelName}</div>`
    : "";
  const handleHtml = "";

  const isTop = position.startsWith("top");
  const isRight = position.endsWith("right");

  const positionStyles = isTop
    ? "top:0;left:0;right:0;"
    : "bottom:0;left:0;right:0;";

  const gradientDir = isTop ? "180deg" : "0deg";
  const flexDir = isRight ? "row-reverse" : "row";
  const textAlign = isRight ? "right" : "left";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;font-family:'Inter',system-ui,sans-serif;}
.bg{position:absolute;inset:0;background-image:url(${dataUrl});background-size:cover;background-position:center;}
.brand-bar{position:absolute;${positionStyles}padding:16px 24px;display:flex;flex-direction:${flexDir};align-items:center;gap:14px;background:linear-gradient(${gradientDir},rgba(0,0,0,${opacity}) 0%,rgba(0,0,0,0.3) 70%,transparent 100%);}
.brand-text{text-align:${textAlign};}
</style></head><body>
<div class="bg"></div>
<div class="brand-bar">
  ${logoHtml}
  <div class="brand-text">${nameHtml}${handleHtml}</div>
</div>
</body></html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 10000 });

    const screenshotBuffer = await page.screenshot({
      type: mimeType.includes("png") ? "png" : "jpeg",
      quality: mimeType.includes("png") ? undefined : 85,
      encoding: "base64",
    });

    return {
      imageBase64: screenshotBuffer as string,
      mimeType,
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
/**
 * Extract the dominant vibrant color from a logo image URL.
 * Uses Puppeteer canvas to sample pixels and find the most prominent non-gray color.
 * Returns a hex color string like "#e11d48", or null if extraction fails.
 */
export async function extractDominantColor(imageUrl: string): Promise<string | null> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 200, height: 200 });

    const color = await page.evaluate(async (url: string) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image load failed"));
        img.src = url;
      });

      const canvas = document.createElement("canvas");
      const size = 64;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      // Count colors in buckets (quantize to 16-step)
      const buckets: Record<string, { r: number; g: number; b: number; count: number }> = {};
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
        if (a < 128) continue; // skip transparent
        // Skip near-white, near-black, and gray pixels
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        if (saturation < 0.15 || max < 30 || min > 225) continue;
        const qr = (r >> 4) << 4, qg = (g >> 4) << 4, qb = (b >> 4) << 4;
        const key = `${qr},${qg},${qb}`;
        if (!buckets[key]) buckets[key] = { r: qr, g: qg, b: qb, count: 0 };
        buckets[key]!.count++;
      }

      // Find the bucket with highest count
      let best: { r: number; g: number; b: number; count: number } | null = null;
      for (const b of Object.values(buckets)) {
        if (!best || b.count > best.count) best = b;
      }

      if (!best) return null;
      const hex = (c: number) => c.toString(16).padStart(2, "0");
      return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
    }, imageUrl);

    return color;
  } catch (e) {
    console.warn(`[extractDominantColor] Failed:`, (e as Error).message);
    return null;
  } finally {
    await browser.close();
  }
}

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
