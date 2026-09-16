/**
 * Story media normalisation (2026-09-16).
 *
 * Turns whatever the user attached into a story-shaped asset BEFORE it is handed
 * to Meta: exactly 1080x1920, whole content contained, blurred backdrop in the
 * padding. See story-fit.ts for why (mobile crops, web fits, the app pads).
 *
 * ⚠️ FAIL OPEN, ALWAYS. A fit is cosmetic; a publish is not. Every failure path
 * returns the ORIGINAL url — the same contract processVideoOverlay follows. A
 * throw here would land inside the publish try, where classifyError could route
 * it into the token-refresh re-publish branch, which is a documented
 * duplicate-post vector.
 *
 * ⚠️ DETERMINISTIC KEY, never a random one. Story mode fans ONE image out to
 * many accounts and post-publish runs per target at concurrency 10; a random key
 * would mint an S3 object per channel per attempt. The HeadObject short-circuit
 * means the first target renders and every other target (and every retry) reuses
 * the same object — the discipline super-text.worker.ts already uses.
 */

import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { needsStoryFit, planStoryFit, STORY_HEIGHT, STORY_WIDTH, type Dimensions } from "./story-fit";
import { probeImageSize, renderStoryImage } from "./story-render";

export const STORY_FIT_VERSION = "v1";

/** Images are small; this only stops a mislabelled giant file from being buffered. */
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;

export type StoryImageAction = "passthrough" | "render";

/**
 * Should this image be re-rendered for a story?
 *
 * Pure so the rule is test-locked away from S3 and sharp.
 *
 * - Wrong shape ⇒ render (the reported bug).
 * - Right shape but not JPEG, on INSTAGRAM ⇒ render. Meta: "JPEG is the only
 *   image format supported" — our uploads accept png/webp/avif, so an
 *   already-9:16 WebP publishes today only by Meta's goodwill. Facebook photo
 *   stories accept png/gif/bmp/tiff, so they are left alone.
 * - Otherwise ⇒ passthrough, and the publish request stays byte-identical.
 */
export function decideStoryImageAction(input: {
  dimensions: Dimensions | null;
  format: string | null | undefined;
  platform: string;
}): StoryImageAction {
  if (needsStoryFit(input.dimensions)) return "render";
  const isJpeg = /^(jpeg|jpg)$/i.test(String(input.format ?? ""));
  if (!isJpeg && input.platform === "INSTAGRAM" && input.dimensions) return "render";
  return "passthrough";
}

function s3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });
}

export function storyFitPublicUrl(key: string): string {
  const bucket = process.env.S3_BUCKET || "postautomation-media";
  if (process.env.S3_PUBLIC_URL) return `${process.env.S3_PUBLIC_URL}/${key}`;
  return `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${bucket}/${key}`;
}

/**
 * The stable object key for one media row's story rendition.
 *
 * ⚠️ Keep `.jpg` on the end. instagram.provider.ts sniffs video by URL EXTENSION
 * first, so an extension-less key would route an image down the video branch.
 */
export function storyFitKeyFor(organizationId: string, mediaId: string): string {
  return `storyfit/${organizationId}/${mediaId}-${STORY_WIDTH}x${STORY_HEIGHT}-${STORY_FIT_VERSION}.jpg`;
}

/**
 * Return a URL whose media is exactly 9:16, rendering one if needed.
 *
 * Returns the input url unchanged when the source is already story-shaped, when
 * anything fails, or when the media cannot be measured.
 */
export async function ensureStoryImageUrl(opts: {
  url: string;
  organizationId: string;
  mediaId: string;
  platform: string;
}): Promise<string> {
  const { url, organizationId, mediaId, platform } = opts;
  try {
    const bucket = process.env.S3_BUCKET || "postautomation-media";
    const key = storyFitKeyFor(organizationId, mediaId);
    const client = s3Client();

    // Already rendered by another target of this same fan-out, or by an earlier
    // attempt: reuse it and skip the download entirely.
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return storyFitPublicUrl(key);
    } catch {
      // Not there yet — render it below.
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.warn(`[StoryFit] source fetch failed (${res.status}) for media ${mediaId} — publishing the original`);
      return url;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_SOURCE_BYTES) {
      console.warn(`[StoryFit] source ${mediaId} is ${declared} bytes — publishing the original`);
      return url;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_SOURCE_BYTES) return url;

    const dimensions = await probeImageSize(buffer);
    const format = await readImageFormat(buffer);
    const action = decideStoryImageAction({ dimensions, format, platform });
    if (action === "passthrough" || !dimensions) return url;

    const plan = planStoryFit(dimensions);
    const rendered = await renderStoryImage(buffer, plan);

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: rendered,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=86400",
      })
    );
    const out = storyFitPublicUrl(key);
    console.log(
      `[StoryFit] media ${mediaId} ${dimensions.width}x${dimensions.height} → ${STORY_WIDTH}x${STORY_HEIGHT} (${plan.padding} padding) for ${platform}`
    );
    return out;
  } catch (err: any) {
    console.warn(`[StoryFit] failed for media ${opts.mediaId}: ${err?.message} — publishing the original`);
    return url;
  }
}

async function readImageFormat(buffer: Buffer): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default;
    return (await sharp(buffer).metadata()).format ?? null;
  } catch {
    return null;
  }
}
