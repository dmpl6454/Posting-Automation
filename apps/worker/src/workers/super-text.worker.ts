import { trackBackgroundTask } from "../lib/background-tasks";
import { Worker, type Job } from "bullmq";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, promises as fsp } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  mediaOptimizeQueue,
  createRedisConnection,
  type SuperTextBurnJobData,
} from "@postautomation/queue";
import {
  buildSuperTextFrameHtml,
  superTextConfigSchema,
  resolveSuperTextFont,
  resolveSuperTextScope,
  DEFAULT_INTRO_SECONDS,
  type SuperTextConfig,
  type SuperTextScope,
} from "@postautomation/super-text";
import { launchCreativeBrowser } from "@postautomation/ai";
import {
  buildSuperTextCompositeArgs,
  displayDimensions,
  durationIntegrityOk,
  type ProbeVideoStream,
} from "../lib/super-text-burn";
import { flipParkedPostIfReady } from "../lib/publish-gates";
import { runPerChannelSuperText, type PerChannelState } from "../lib/super-text-per-channel";
import { baseTextOf } from "../lib/super-text-variants";
import { SUPER_TEXT_MEDIA_KEY } from "../lib/per-target-media";
import {
  buildFrameGrabArgs,
  composeCoverJpeg,
  coverCandidateTimes,
  pickBestCover,
  planCoverBase,
  prepareCoverBase,
  scoreCoverCandidate,
  type CoverBase,
} from "../lib/super-text-cover";

/**
 * super-text worker: burns the user's positioned text strip into their video
 * BEFORE it publishes.
 *
 * Pipeline per configured video:
 *   1. ffprobe the source for its native pixel size + duration
 *   2. render the strip to a TRANSPARENT full-frame PNG via the shared HTML
 *      builder + the gated Puppeteer browser (Chromium is what gives us colour
 *      emoji and per-word colours — ffmpeg drawtext can do neither)
 *   3. stream the source to /tmp, then ffmpeg `overlay=0:0`
 *   4. verify the output wasn't truncated, upload it, create a DERIVED Media row
 *   5. repoint the post's PostMedia at the derived row
 * Then clear the gate and flip DRAFT→SCHEDULED if nothing else is pending.
 *
 * Because step 5 leaves an ordinary video Media row attached to the post, the
 * frozen IG/FB publish paths, media-optimize, streamed uploads and the watchdog
 * all continue to work with ZERO changes.
 *
 * concurrency: 1 — one ffmpeg at a time on the 4-core prod box, matching
 * media-optimize. Puppeteer is additionally bounded by CREATIVE_RENDER_CONCURRENCY
 * inside launchCreativeBrowser.
 */

const execFileAsync = promisify(execFile);

const s3 = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId:
      process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ||
      process.env.S3_SECRET_KEY ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      "",
  },
});
const S3_BUCKET = process.env.S3_BUCKET || "postautomation-media";
const S3_BASE_URL =
  process.env.S3_PUBLIC_URL || process.env.S3_BASE_URL || `https://${S3_BUCKET}.s3.amazonaws.com`;

const PROBE_TIMEOUT_MS = 60_000;
const BURN_TIMEOUT_MS = Number(process.env.SUPER_TEXT_TIMEOUT_MS || 30 * 60 * 1000);
/** Re-check of the create-time cap (SUPER_TEXT_MAX_SOURCE_BYTES in packages/api). */
const MAX_SOURCE_BYTES = 950 * 1024 * 1024;

/**
 * Story MODE marker (packages/api `isStoryModeMetadata` — same rule, kept local
 * so the worker does not import the API package): the `instagramStory` object
 * is written only by post.create's `story` input.
 */
function isStoryModeMeta(meta: Record<string, unknown> | null | undefined): boolean {
  const m = meta?.instagramStory;
  return !!m && typeof m === "object" && !Array.isArray(m);
}

/** Distinct per-channel COVER variants per video (each is one composited JPEG). */
function maxCoverVariants(): number {
  const raw = Number(process.env.SUPER_TEXT_MAX_COVER_VARIANTS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 250;
}

export const SUPER_TEXT_FAIL_MESSAGE =
  "Super text could not be applied to your video. Edit the post to try again, or remove the super text.";

interface Probe {
  /**
   * DISPLAY size — after the rotation ffmpeg applies on decode — NOT the coded
   * size ffprobe prints as width/height. The strip is rendered at this size and
   * composited at 0:0, so it must match the decoded frame (2026-10-03 incident:
   * a phone video coded 1920×1080 + 90° put the strip mid-frame and off the
   * right edge; see displayDimensions).
   */
  width?: number;
  height?: number;
  /** Quarter-turn rotation ffprobe reported (log/diagnostic only). */
  rotation?: 0 | 90 | 180 | 270;
  durationSec?: number;
}

async function probe(target: string): Promise<Probe> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", target],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string } & ProbeVideoStream>;
    format?: { duration?: string };
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  const dims = displayDimensions(v);
  return {
    width: dims.width,
    height: dims.height,
    rotation: dims.rotation,
    durationSec: data.format?.duration ? parseFloat(data.format.duration) || undefined : undefined,
  };
}

/** Stream a (public S3) URL to a local file — never buffer a video in heap. */
async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`source download failed: HTTP ${res.status}`);
  const { Readable } = await import("stream");
  const { pipeline } = await import("stream/promises");
  const { createWriteStream } = await import("fs");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
}

/** How long to wait for an embedded webfont before giving up and rendering anyway. */
const FONT_READY_TIMEOUT_MS = 10_000;

/**
 * A timeout leg for Promise.race whose timer can be CLEARED once the race is
 * settled. A bare `new Promise(r => setTimeout(r, ms))` leaves the timer armed
 * even after the other leg wins, holding the event loop for up to ms and delaying
 * process exit.
 */
class Deferred {
  readonly promise: Promise<void>;
  private handle: ReturnType<typeof setTimeout> | undefined;
  constructor(ms = FONT_READY_TIMEOUT_MS) {
    this.promise = new Promise<void>((resolve) => {
      this.handle = setTimeout(resolve, ms);
    });
  }
  cancel(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = undefined;
  }
}

/** Render the strip as a transparent full-frame PNG at the video's native size. */
async function renderStripPng(
  html: string,
  width: number,
  height: number,
  outPath: string,
  /**
   * Embedded face to await, or null when the font needs no loading. The WEIGHT
   * must be the registry's declared weight: fonts.load() resolves the face that
   * matches the descriptor, and asking for `700` when the only @font-face is
   * 500 (Instagram Sans Medium, 2026-10-03) reports a synthesised match — the
   * wait then passes before the real bytes are in and the fallback is baked.
   */
  embedded: { family: string; weight: number } | null
) {
  const embeddedFamily = embedded?.family ?? null;
  const embeddedWeight = embedded?.weight ?? 700;
  const browser = await launchCreativeBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    // `load` (not networkidle0) — the page is fully self-contained inline HTML.
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });

    // `waitUntil:"load"` does NOT wait for @font-face. Screenshotting here would
    // silently bake the FALLBACK face while the compose preview showed the real
    // one — exactly the preview/burn drift this shared-renderer design exists to
    // prevent, and it fails with no error at all.
    //
    // Bounded by a timeout so a font problem degrades to a fallback render
    // instead of hanging the burn (which the watchdog would later reap FAILED).
    //
    // The whole wait is best-effort: it must never be the thing that FAILS a burn
    // that would otherwise have succeeded. Before this feature there was no
    // evaluate call here at all, so letting a CDP/page hiccup reject would have
    // introduced a brand-new failure mode for every super-text post. If the page
    // is genuinely broken, page.screenshot below fails loudly on its own.
    if (embeddedFamily) {
      const timer = new Deferred();
      try {
        await Promise.race([
          // NOTE: this callback body executes INSIDE the browser page, so `document`
          // exists at runtime — but the worker's tsconfig has no DOM lib, so reach it
          // through globalThis with a narrow local type rather than a bare identifier.
          page.evaluate(async ({ family, weight }: { family: string; weight: number }) => {
            const { fonts } = (
              globalThis as unknown as {
                document: {
                  fonts: { load: (f: string) => Promise<unknown>; ready: Promise<unknown> };
                };
              }
            ).document;
            try {
              // Explicitly kick the load: fonts.ready only settles work already
              // triggered by layout, so asking for the exact face is the reliable
              // way to know it resolved.
              await fonts.load(`${weight} 100px "${family}"`);
            } catch {
              /* fall through to fonts.ready */
            }
            await fonts.ready;
          }, { family: embeddedFamily, weight: embeddedWeight }),
          timer.promise,
        ]);
      } catch (err) {
        console.warn(
          `[SuperText] font-readiness wait errored for "${embeddedFamily}" — continuing:`,
          err instanceof Error ? err.message : err
        );
      } finally {
        timer.cancel();
      }

      // fonts.ready resolves once loading FINISHES, whether or not this specific
      // face succeeded, and the timeout leg resolves silently. fonts.check() is
      // the only call that distinguishes "loaded" from "fell back", so without
      // this a wrong-font burn would be indistinguishable from a correct one.
      //
      // Scope of the guard (measured in the worker image): with a corrupt payload
      // check() === false, so it DOES catch the real failure mode. But with no
      // @font-face declared at all it returns TRUE, because check() answers "can I
      // render this text?" and a system fallback counts. That case is unreachable
      // here — `embeddedFamily` is only non-null under the same condition that made
      // buildSuperTextFontFaceCss emit the face — but do not reuse check() as a
      // general "is my webfont present" test.
      //
      // Deliberately a WARNING, not a throw: the burn is still a valid video and
      // failing it here would be a regression for a cosmetic problem.
      const active = await page
        .evaluate(
          (family: string) =>
            (
              globalThis as unknown as { document: { fonts: { check: (f: string) => boolean } } }
            ).document.fonts.check(`700 100px "${family}"`),
          embeddedFamily
        )
        .catch(() => null);
      if (active === false) {
        console.warn(
          `[SuperText] embedded font "${embeddedFamily}" did NOT activate — the strip ` +
            `will burn in the fallback face and may wrap differently than the preview.`
        );
      }
    }

    const png = (await page.screenshot({
      type: "png",
      omitBackground: true, // transparency is what makes overlay=0:0 work
      encoding: "base64",
    })) as string;
    await fsp.writeFile(outPath, Buffer.from(png, "base64"));
  } finally {
    // Closing releases the CREATIVE_RENDER_CONCURRENCY slot.
    await browser.close().catch(() => undefined);
  }
}

/** Merge-patch `metadata.superText` on the post (fresh read → additive write). */
async function stampSuperText(postId: string, patch: Record<string, unknown>) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { metadata: true } });
  const meta = ((post?.metadata as Record<string, unknown>) ?? {});
  const st = ((meta.superText as Record<string, unknown>) ?? {});
  await prisma.post.update({
    where: { id: postId },
    data: { metadata: { ...meta, superText: { ...st, ...patch } } as any },
  });
}

/**
 * FAIL-VISIBLE terminal path. Unlike caption-fanout's degraded valve (publishing a
 * shared caption is an acceptable fallback), publishing a video WITHOUT the text
 * the user deliberately placed changes the meaning of the post — so a burn that
 * exhausts its retries fails the post loudly instead. Org-scoped and idempotent.
 */
export async function markSuperTextFailed(
  postId: string,
  organizationId: string,
  errorDetail: string
): Promise<void> {
  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    select: { id: true, metadata: true },
  });
  if (!post) return;
  const meta = ((post.metadata as Record<string, unknown>) ?? {});
  const st = ((meta.superText as Record<string, any>) ?? {});
  if (st.pendingBurn !== true) return; // already resolved — never double-fail

  await prisma.postTarget.updateMany({
    where: { postId, status: { in: ["DRAFT", "SCHEDULED"] } },
    data: { status: "FAILED", errorMessage: SUPER_TEXT_FAIL_MESSAGE },
  });
  await prisma.post.update({
    where: { id: postId },
    data: {
      status: "FAILED",
      metadata: {
        ...meta,
        superText: {
          ...st,
          pendingBurn: false,
          failed: true,
          error: String(errorDetail).slice(0, 300),
          completedAt: new Date().toISOString(),
        },
      } as any,
    },
  });
}

/**
 * Per-channel state is nested under superText.perChannelState[mediaId]; merge it
 * from a FRESH read so two media entries can never clobber each other.
 */
async function stampPerChannelState(postId: string, mediaId: string, state: PerChannelState) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { metadata: true } });
  const meta = ((post?.metadata as Record<string, unknown>) ?? {});
  const st = ((meta.superText as Record<string, unknown>) ?? {});
  const all = ((st.perChannelState as Record<string, unknown>) ?? {});
  await prisma.post.update({
    where: { id: postId },
    data: {
      metadata: { ...meta, superText: { ...st, perChannelState: { ...all, [mediaId]: state } } } as any,
    },
  });
}

/**
 * Record a target's own burned copy. Read-merge-write on the target's metadata,
 * preserving sibling keys (nothing else writes target metadata before the flip;
 * igStoryContainer / fbStoryMedia land at publish time, after this).
 */
async function writeTargetSuperTextMedia(
  targetId: string,
  sourceMediaId: string,
  entry: { mediaId: string; text: string; variant: number },
  scope: SuperTextScope
) {
  const target = await prisma.postTarget.findUnique({ where: { id: targetId }, select: { metadata: true } });
  const meta = ((target?.metadata as Record<string, unknown>) ?? {});
  const map = ((meta[SUPER_TEXT_MEDIA_KEY] as Record<string, unknown>) ?? {});
  if (scope === "cover") {
    // The per-channel COVER rides the existing videoThumbnail path: the publish
    // worker spreads PostTarget.metadata over Post.metadata when it builds the
    // provider payload, so a target-level videoThumbnail wins with no worker
    // change. The entry keeps the text for the post page but carries NO
    // `mediaId`, so per-target-media.ts never swaps the video itself.
    const cover = await prisma.media.findUnique({ where: { id: entry.mediaId }, select: { id: true, url: true } });
    if (!cover) throw new Error(`cover media ${entry.mediaId} not found`);
    await prisma.postTarget.update({
      where: { id: targetId },
      data: {
        metadata: {
          ...meta,
          videoThumbnail: { mediaId: cover.id, url: cover.url, superText: { sourceMediaId, variant: entry.variant } },
          [SUPER_TEXT_MEDIA_KEY]: {
            ...map,
            [sourceMediaId]: { text: entry.text, variant: entry.variant, coverMediaId: cover.id },
          },
        } as any,
      },
    });
    return;
  }
  await prisma.postTarget.update({
    where: { id: targetId },
    data: { metadata: { ...meta, [SUPER_TEXT_MEDIA_KEY]: { ...map, [sourceMediaId]: entry } } as any },
  });
}

/** Set the post-level cover (variant 0, cover scope). Fresh read → top-level merge. */
async function stampPostCover(postId: string, cover: { mediaId: string; url: string; sourceMediaId: string }) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { metadata: true } });
  const meta = ((post?.metadata as Record<string, unknown>) ?? {});
  await prisma.post.update({
    where: { id: postId },
    data: {
      metadata: {
        ...meta,
        videoThumbnail: { mediaId: cover.mediaId, url: cover.url, superText: { sourceMediaId: cover.sourceMediaId } },
      } as any,
    },
  });
}

/** Download a (public S3) image into memory — covers are small by construction. */
async function fetchBuffer(url: string, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cover source download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`cover source too large (${buf.length} bytes)`);
  return buf;
}

/**
 * Resolve the image the cover starts from: the user's uploaded cover, else the
 * best of a few early frames of the video (see super-text-cover.ts).
 */
async function resolveCoverBase(
  postMetadata: unknown,
  sourceUrl: string,
  durationSec: number | undefined,
  tmpDir: string,
  label: string
): Promise<{ base: CoverBase; from: string }> {
  const plan = planCoverBase(postMetadata);
  if (plan.kind === "user-cover") {
    try {
      return { base: await prepareCoverBase(await fetchBuffer(plan.url)), from: "user-cover" };
    } catch (e: any) {
      console.warn(`[super-text] user cover unusable (${e?.message ?? e}) — picking a frame instead`);
    }
  }
  const scored: Array<{ t: number; png: Buffer; score: number }> = [];
  for (const t of coverCandidateTimes(durationSec)) {
    const out = path.join(tmpDir, `frame-${label}-${t}.png`);
    try {
      await execFileAsync("ffmpeg", buildFrameGrabArgs(sourceUrl, out, t), { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      const png = await fsp.readFile(out);
      const { score } = await scoreCoverCandidate(png);
      scored.push({ t, png, score });
    } catch (e: any) {
      console.warn(`[super-text] frame grab at ${t}s failed: ${e?.message ?? e}`);
    } finally {
      await fsp.rm(out, { force: true }).catch(() => undefined);
    }
  }
  const best = pickBestCover(scored);
  if (!best) throw new Error("could not grab any frame for the cover");
  return { base: await prepareCoverBase(best.png), from: `frame@${best.t}s` };
}

/** Best-effort in-app note to the creator when some channels fell back to the shared strip. */
async function notifyPerChannelDegraded(
  postId: string,
  organizationId: string,
  createdById: string | null | undefined,
  detail: string
) {
  try {
    let recipients: string[] = createdById ? [createdById] : [];
    if (recipients.length === 0) {
      const owners = await prisma.organizationMember.findMany({
        where: { organizationId, role: "OWNER" },
        select: { userId: true },
      });
      recipients = owners.map((m) => m.userId);
    }
    for (const userId of recipients) {
      await prisma.notification.create({
        data: {
          userId,
          organizationId,
          type: "post.supertext_degraded",
          title: "Some channels use your original super text",
          body: `A different super text could not be prepared for every channel (${detail}). Those channels publish the video with the text you wrote.`,
          link: `/dashboard/posts/${postId}`,
          metadata: { postId, reason: detail },
        },
      });
    }
  } catch (e: any) {
    console.warn(`[super-text] degraded notification failed for ${postId}:`, e?.message ?? e);
  }
}

/** Provider-chain text generation for the per-channel variant lines (lazy-loaded @postautomation/ai). */
async function loadVariantTextGen() {
  const { generateContent, withTextProviderFallback, isProviderCreditExhausted } = await import("@postautomation/ai");
  return {
    generateText: (prompt: string) =>
      withTextProviderFallback(
        undefined,
        (provider) =>
          generateContent({
            provider: provider as Parameters<typeof generateContent>[0]["provider"],
            platform: "INSTAGRAM",
            charLimit: 4000,
            tone: "punchy, spoken-language",
            userPrompt: prompt,
          }),
        (failed, next, e) =>
          console.warn(
            `[super-text] Provider ${failed} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), trying ${next}`
          )
      ),
    isCreditExhausted: isProviderCreditExhausted,
  };
}

interface BurnContext {
  organizationId: string;
  createdById: string;
  tmpDir: string;
  /** Source Media row (the ORIGINAL upload, never a derived row). */
  source: { id: string; url: string; fileName: string; duration: number | null };
  srcProbe: Probe;
  width: number;
  height: number;
  /** Local copy of the source — downloaded once per media, shared by every burn. */
  inputPath: string;
  downloaded: { done: boolean };
  /** Where the strip goes for THIS media (story-mode posts are forced to `video`). */
  scope: SuperTextScope;
  /** Post metadata at job start — names the user's uploaded cover, if any. */
  postMetadata: unknown;
  /** Cover scope: the base image, resolved once per media and reused per variant. */
  coverBase: { value: CoverBase | null; from: string };
}

/**
 * ONE burn: strip PNG → ffmpeg composite → integrity check → S3 → derived Media
 * row (+ the standard optimize job). Shared by the base burn and every
 * per-channel variant, so there is exactly one encode contract.
 */
async function burnConfig(
  ctx: BurnContext,
  cfg: SuperTextConfig,
  /** 0 = the user's own text (shared burn); k ≥ 1 = per-channel variant k. */
  variant: number
): Promise<{ derivedId: string; out: Probe }> {
  const label = variant === 0 ? ctx.source.id : `${ctx.source.id}-v${variant}`;
  const stripPath = path.join(ctx.tmpDir, `strip-${label}.png`);
  const outputPath = path.join(ctx.tmpDir, `out-${label}.mp4`);

  try {
    // Guard on a non-empty payload so a missing generated font file skips the
    // wait rather than burning FONT_READY_TIMEOUT_MS on a face that never arrives.
    const fontSpec = resolveSuperTextFont(cfg.font);
    const embeddedFamily = fontSpec.embedded?.base64
      ? { family: fontSpec.embedded.family, weight: fontSpec.weight }
      : null;

    if (ctx.scope === "cover") {
      // ── Cover only: no video encode. Strip is rendered at the COVER's size
      // (the user's cover may not match the video's pixel size), composited
      // with sharp, uploaded as a JPEG, and stored as an IMAGE Media row.
      if (!ctx.coverBase.value) {
        const resolved = await resolveCoverBase(ctx.postMetadata, ctx.source.url, ctx.srcProbe.durationSec, ctx.tmpDir, ctx.source.id);
        ctx.coverBase = { value: resolved.base, from: resolved.from };
        console.log(`[super-text] cover base for ${ctx.source.id}: ${resolved.from} (${resolved.base.width}x${resolved.base.height})`);
      }
      const base = ctx.coverBase.value!;
      await renderStripPng(buildSuperTextFrameHtml(cfg, base.width, base.height), base.width, base.height, stripPath, embeddedFamily);
      const jpeg = await composeCoverJpeg(base, await fsp.readFile(stripPath));
      const hash = crypto.createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 8);
      const key = `supertext/${ctx.organizationId}/${label}-${hash}-cover.jpg`;
      await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: jpeg, ContentLength: jpeg.length, ContentType: "image/jpeg" }));
      const url = `${S3_BASE_URL}/${key}`;
      const derived = await prisma.media.create({
        data: {
          organizationId: ctx.organizationId,
          uploadedById: ctx.createdById,
          fileName: `supertext-cover-${ctx.source.fileName.replace(/\.[^.]+$/, "")}.jpg`,
          fileType: "image/jpeg",
          fileSize: jpeg.length,
          url,
          width: base.width,
          height: base.height,
          metadata: {
            superText: {
              sourceMediaId: ctx.source.id,
              cover: true,
              coverFrom: ctx.coverBase.from,
              burnedAt: new Date().toISOString(),
              ...(variant > 0 ? { variant, text: baseTextOf(cfg) } : {}),
            },
          } as any,
        },
      });
      return { derivedId: derived.id, out: { width: base.width, height: base.height } };
    }

    await renderStripPng(
      buildSuperTextFrameHtml(cfg, ctx.width, ctx.height),
      ctx.width,
      ctx.height,
      stripPath,
      embeddedFamily
    );
    if (!ctx.downloaded.done) {
      await downloadToFile(ctx.source.url, ctx.inputPath);
      ctx.downloaded.done = true;
    }
    await execFileAsync(
      "ffmpeg",
      buildSuperTextCompositeArgs({
        inputPath: ctx.inputPath,
        overlayPngPath: stripPath,
        outputPath,
        // Intro scope: strip on screen for the first N seconds only.
        ...(ctx.scope === "intro" ? { showForSeconds: cfg.introSeconds ?? DEFAULT_INTRO_SECONDS } : {}),
      }),
      { timeout: BURN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
    );

    const out = await probe(outputPath);
    if (!durationIntegrityOk(ctx.srcProbe.durationSec, out.durationSec)) {
      throw new Error(
        `burn output truncated (${out.durationSec ?? "?"}s vs source ${ctx.srcProbe.durationSec ?? "?"}s)`
      );
    }

    // Config hash in the key: re-burning after an edit writes a NEW object
    // instead of silently serving a stale cached one.
    const hash = crypto.createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 8);
    const key = `supertext/${ctx.organizationId}/${label}-${hash}.mp4`;
    const size = (await fsp.stat(outputPath)).size;
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: createReadStream(outputPath),
        ContentLength: size,
        ContentType: "video/mp4",
      })
    );
    const url = `${S3_BASE_URL}/${key}`;

    const derived = await prisma.media.create({
      data: {
        organizationId: ctx.organizationId,
        uploadedById: ctx.createdById,
        fileName: `supertext-${ctx.source.fileName}`,
        fileType: "video/mp4",
        fileSize: size,
        url,
        width: out.width ?? ctx.width,
        height: out.height ?? ctx.height,
        duration: out.durationSec ? Math.round(out.durationSec) : ctx.source.duration,
        metadata: {
          superText: {
            sourceMediaId: ctx.source.id,
            burnedAt: new Date().toISOString(),
            ...(variant > 0 ? { variant, text: baseTextOf(cfg) } : {}),
          },
          // Hand the derived file to the STANDARD optimize pipeline exactly like
          // a fresh upload, so IG still gets its 1080×1920 rendition.
          optimize: { status: "pending", enqueuedAt: new Date().toISOString() },
        } as any,
      },
    });

    await mediaOptimizeQueue
      .add(
        "optimize",
        { mediaId: derived.id },
        {
          jobId: `optimize:${derived.id}:v1`,
          attempts: 2,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 24 * 3600 },
        }
      )
      .catch((e) => console.warn("[super-text] optimize enqueue failed:", e?.message ?? e));

    return { derivedId: derived.id, out };
  } finally {
    await fsp.rm(stripPath, { force: true }).catch(() => undefined);
    await fsp.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

export async function runSuperTextBurn(
  data: SuperTextBurnJobData
): Promise<{ burned: number; skipped: number; flipped: boolean } | { skipped: string }> {
  const { postId, organizationId } = data;

  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    include: { mediaAttachments: { include: { media: true } } },
  });
  if (!post) {
    console.warn(`[super-text] Post ${postId} not found in org ${organizationId} — skipping`);
    return { skipped: "post_not_found" };
  }

  const meta = ((post.metadata as Record<string, any>) ?? {});
  const st = (meta.superText ?? {}) as Record<string, any>;
  if (st.pendingBurn !== true) return { skipped: "not_pending" };

  const byMediaId = (st.byMediaId ?? {}) as Record<string, unknown>;
  const results: Record<string, any> = { ...(st.results ?? {}) };
  // Per-channel super text (2026-10-02): AI writes a different strip line per
  // channel and each channel gets its own burn. The user's own text stays the
  // shared burn (variant 0), so every channel has a strip even if a variant
  // fails. See lib/super-text-per-channel.ts for the state machine.
  const perChannel = st.perChannel === true;
  const perChannelState = ((st.perChannelState ?? {}) as Record<string, PerChannelState>);
  let perChannelDegraded = false;
  const perChannelSummary: string[] = [];
  let burned = 0;
  let skipped = 0;

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "supertext-"));
  try {
    for (const [mediaId, rawCfg] of Object.entries(byMediaId)) {
      // Retry idempotency: a BullMQ retry never re-burns an entry that already
      // produced a derived Media row (the swap below is not reversible).
      const baseDone = results[mediaId]?.status === "done";
      if (baseDone && !perChannel) {
        skipped++;
        continue;
      }

      const parsed = superTextConfigSchema.safeParse(rawCfg);
      if (!parsed.success) throw new Error(`invalid super-text config for media ${mediaId}`);

      // The base burn repoints PostMedia at the derived row, so on a retry the
      // attachment no longer carries the source id — load the ORIGINAL row
      // directly for the per-channel variants (it is never deleted).
      const attachment = post.mediaAttachments.find((a) => a.mediaId === mediaId);
      const media = baseDone
        ? await prisma.media.findFirst({ where: { id: mediaId, organizationId } })
        : attachment?.media ?? null;

      // Config for media that is no longer attached (user removed it after
      // saving) is skipped, not fatal.
      if (!media || !media.fileType.startsWith("video/")) {
        skipped++;
        continue;
      }
      if (Number(media.fileSize) > MAX_SOURCE_BYTES) {
        throw new Error(`source ${mediaId} exceeds the 950MB super-text cap`);
      }

      // A probe is a metadata read (range-seeks), safe to do over http — unlike a
      // long encode, which must never read through nginx (PR #144 truncation).
      const src = await probe(media.url);
      const width = src.width && src.width >= 16 ? src.width : 1080;
      const height = src.height && src.height >= 16 ? src.height : 1920;
      if (src.rotation) {
        // Phone footage: the strip canvas is the DISPLAY size, not the coded one.
        console.log(
          `[super-text] source ${mediaId} carries a ${src.rotation}° rotation — strip canvas is the display size ${width}x${height}`
        );
      }
      const ctx: BurnContext = {
        organizationId,
        createdById: post.createdById,
        tmpDir,
        source: { id: mediaId, url: media.url, fileName: media.fileName, duration: media.duration },
        srcProbe: src,
        width,
        height,
        inputPath: path.join(tmpDir, `in-${mediaId}.mp4`),
        downloaded: { done: false },
        // A story has no cover (Meta rejects cover_url on a STORIES container), so
        // a cover-scoped strip on a story-mode post is burned into the video.
        scope: isStoryModeMeta(meta) && resolveSuperTextScope(parsed.data.scope) === "cover"
          ? "video"
          : resolveSuperTextScope(parsed.data.scope),
        postMetadata: meta,
        coverBase: { value: null, from: "" },
      };

      try {
        if (!baseDone) {
          const { derivedId } = await burnConfig(ctx, parsed.data, 0);

          if (ctx.scope === "cover") {
            // The video is untouched; the composited frame becomes the post's
            // cover (videoThumbnail), which every provider already applies.
            const cover = await prisma.media.findUniqueOrThrow({ where: { id: derivedId }, select: { url: true } });
            await stampPostCover(postId, { mediaId: derivedId, url: cover.url, sourceMediaId: mediaId });
            results[mediaId] = { status: "done", coverMediaId: derivedId, scope: "cover" };
          } else {
            // Repoint the post at the burned video. The join row keeps its `order`, so
            // carousel/slide ordering is untouched — only which Media it points at.
            await prisma.postMedia.updateMany({
              where: { postId, mediaId },
              data: { mediaId: derivedId },
            });
            results[mediaId] = { status: "done", derivedMediaId: derivedId, scope: ctx.scope };
          }
          // Persist per entry so a crash mid-loop never re-burns finished work.
          await stampSuperText(postId, { results });
          burned++;
        } else {
          skipped++;
        }

        if (perChannel) {
          const gen = await loadVariantTextGen();
          const outcome = await runPerChannelSuperText(
            {
              loadTargets: () =>
                prisma.postTarget.findMany({
                  where: { postId, status: { in: ["DRAFT", "SCHEDULED"] } },
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                  select: { id: true, channel: { select: { name: true, username: true, platform: true } } },
                }),
              generateText: gen.generateText,
              isCreditExhausted: gen.isCreditExhausted,
              burn: async (cfg, k) => {
                const { derivedId } = await burnConfig(ctx, cfg, k);
                burned++;
                return { derivedMediaId: derivedId };
              },
              writeTargetMedia: (targetId, entry) => writeTargetSuperTextMedia(targetId, mediaId, entry, ctx.scope),
              persist: (state) => stampPerChannelState(postId, mediaId, state),
              // A cover variant is one small JPEG, not an encode — the cap can be
              // generous there. Video/intro variants keep the encode cap.
              ...(ctx.scope === "cover" ? { maxVariants: maxCoverVariants() } : {}),
            },
            {
              sourceMediaId: mediaId,
              baseCfg: parsed.data,
              postContent: post.content ?? "",
              state: perChannelState[mediaId],
            }
          );
          perChannelState[mediaId] = outcome.state;
          if (outcome.degraded) perChannelDegraded = true;
          perChannelSummary.push(
            `${mediaId}: targets=${outcome.targets} unique=${outcome.unique} base=${outcome.onBase} fallback=${outcome.fallback}` +
              (outcome.state.outOfCredit ? " (AI out of credit)" : outcome.state.generationFailed ? " (AI generation failed)" : "")
          );
        }
      } finally {
        await fsp.rm(ctx.inputPath, { force: true }).catch(() => undefined);
      }
    }

    await stampSuperText(postId, {
      pendingBurn: false,
      completedAt: new Date().toISOString(),
      results,
      ...(perChannel ? { perChannelDegraded } : {}),
    });

    if (perChannel) {
      console.log(`[super-text] Post ${postId} per-channel: ${perChannelSummary.join(" | ")}`);
      if (perChannelDegraded) {
        const anyOutOfCredit = Object.values(perChannelState).some((s) => s?.outOfCredit);
        await notifyPerChannelDegraded(
          postId,
          organizationId,
          post.createdById,
          anyOutOfCredit ? "every AI provider is out of credit" : "some lines could not be generated or burned"
        );
      }
    }

    // Flip only if every gate (e.g. a concurrent caption-fanout) is clear.
    const flipped = await flipParkedPostIfReady(prisma as any, postId, organizationId);
    console.log(
      `[super-text] Post ${postId}: burned=${burned} skipped=${skipped} flipped=${flipped}`
    );
    return { burned, skipped, flipped };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createSuperTextWorker() {
  const worker = new Worker<SuperTextBurnJobData>(
    QUEUE_NAMES.SUPER_TEXT,
    async (job: Job<SuperTextBurnJobData>) => runSuperTextBurn(job.data),
    { connection: createRedisConnection(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[super-text] job ${job?.id} failed:`, err?.message ?? err);
    // attemptsMade is incremented before "failed" fires, so >= attempts means
    // there are no retries left → surface it instead of leaving a stuck DRAFT.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      // Tracked so a graceful drain waits for it (lib/background-tasks.ts):
      // cut short, the post would stay DRAFT with pendingBurn set forever.
      trackBackgroundTask(
        markSuperTextFailed(
          job.data.postId,
          job.data.organizationId,
          err?.message ?? "unknown error"
        ).catch((e) => console.error("[super-text] markSuperTextFailed errored:", e))
      );
    }
  });

  return worker;
}
