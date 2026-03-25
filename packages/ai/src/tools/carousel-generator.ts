/**
 * Carousel & Reel Generator
 * - Carousel: renders each slide as a separate 1080x1350 image via Puppeteer
 * - Reel: stitches carousel slides into a video with FFmpeg
 */

import puppeteer from "puppeteer";
import { generateCarouselSlideHtml, type CarouselOptions, type CarouselSlide } from "./carousel-template";

export interface CarouselResult {
  slides: Array<{
    imageBase64: string;
    mimeType: string;
    width: number;
    height: number;
  }>;
}

/**
 * Generate carousel slide images via Puppeteer.
 */
export async function generateCarouselImages(
  options: CarouselOptions
): Promise<CarouselResult> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const slides: CarouselResult["slides"] = [];

    for (let i = 0; i < options.slides.length; i++) {
      const slide = options.slides[i]!;
      // Add slide numbering
      slide.slideNumber = i + 1;
      slide.totalSlides = options.slides.length;

      const html = generateCarouselSlideHtml(slide, options, i + 1);
      const page = await browser.newPage();
      await page.setViewport({ width: 1080, height: 1350 });
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });

      const screenshotBuffer = await page.screenshot({
        type: "jpeg",
        quality: 85,
        encoding: "base64",
      });

      slides.push({
        imageBase64: screenshotBuffer as string,
        mimeType: "image/jpeg",
        width: 1080,
        height: 1350,
      });

      await page.close();
    }

    return { slides };
  } finally {
    await browser.close();
  }
}
