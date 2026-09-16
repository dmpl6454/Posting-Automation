import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { renderStoryImage, probeImageSize, STORY_IMAGE_MAX_BYTES } from "./story-render";
import { planStoryFit, STORY_WIDTH, STORY_HEIGHT } from "./story-fit";

/** A 4:5 source — the shape the owner reported being cropped on phones. */
async function source45(): Promise<Buffer> {
  return sharp({
    create: { width: 1080, height: 1350, channels: 3, background: { r: 220, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

describe("probeImageSize", () => {
  it("measures a real image", async () => {
    expect(await probeImageSize(await source45())).toEqual({ width: 1080, height: 1350 });
  });

  it("returns null for bytes that are not an image, so nothing is re-rendered on a guess", async () => {
    expect(await probeImageSize(Buffer.from("not an image"))).toBeNull();
  });
});

describe("renderStoryImage", () => {
  it("produces a full 1080x1920 story frame", async () => {
    const plan = planStoryFit({ width: 1080, height: 1350 });
    const out = await renderStoryImage(await source45(), plan);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(STORY_WIDTH);
    expect(meta.height).toBe(STORY_HEIGHT);
    expect(meta.format).toBe("jpeg");
    expect(out.byteLength).toBeLessThanOrEqual(STORY_IMAGE_MAX_BYTES);
  });

  it("keeps the ENTIRE source visible — the centre is the original, the padding is not", async () => {
    const plan = planStoryFit({ width: 1080, height: 1350 });
    const out = await renderStoryImage(await source45(), plan);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
    };
    // Dead centre: the source colour, untouched.
    const centre = px(540, 960);
    expect(centre.r).toBeGreaterThan(180);
    expect(centre.g).toBeLessThan(80);

    // Inside the content box but one row below its top edge: still source.
    const insideTop = px(540, plan.inner.top + 6);
    expect(insideTop.r).toBeGreaterThan(180);

    // In the padding band: a blurred, DARKENED copy — same hue, lower luminance.
    const padding = px(540, 40);
    expect(padding.r).toBeLessThan(centre.r);
  });

  it("pads at the sides when the source is taller than the canvas", async () => {
    const src = await sharp({
      create: { width: 1080, height: 2400, channels: 3, background: { r: 20, g: 200, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    const plan = planStoryFit({ width: 1080, height: 2400 });
    const out = await renderStoryImage(src, plan);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(STORY_WIDTH);
    expect(meta.height).toBe(STORY_HEIGHT);
    expect(plan.inner.left).toBeGreaterThan(0);
  });

  it("applies EXIF orientation, or a phone photo would render sideways", async () => {
    // 1350x1080 tagged orientation 6 (rotate 90° CW) = a 1080x1350 portrait photo.
    const rotated = await sharp({
      create: { width: 1350, height: 1080, channels: 3, background: { r: 10, g: 10, b: 200 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect(await probeImageSize(rotated)).toEqual({ width: 1080, height: 1350 });

    const plan = planStoryFit({ width: 1080, height: 1350 });
    const out = await renderStoryImage(rotated, plan);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(STORY_WIDTH);
    expect(meta.height).toBe(STORY_HEIGHT);
  });
});
