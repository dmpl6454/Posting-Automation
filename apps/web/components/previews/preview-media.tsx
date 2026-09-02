"use client";

import { Play } from "lucide-react";
// Relative import (not "~/"): this module is imported by vitest suites and
// the root vitest config has no "~" alias for apps/web.
import { withPosterHint } from "../../lib/video-poster";

export type MediaKind = "image" | "video";

export const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i;

/**
 * Classify a media URL when the caller didn't supply an explicit kind.
 * Compose passes kinds (it knows the File type); other callers' URLs are
 * S3/remote and carry an extension.
 *
 * A caller-supplied kind of "image" is NOT trusted when the URL itself says
 * video: the two failure directions are wildly asymmetric (rendering an image
 * through <video> is a cosmetic miss; rendering a video through <img> is the
 * WebKit whole-file memory ingest described below). A broken classifier in
 * Compose shipped exactly that — an uppercase ".MOV" library pick passed as
 * kind "image" — and this override is the backstop that keeps a repeat from
 * ever reaching <img>.
 */
export function classifyMediaUrl(url: string, kind?: MediaKind): MediaKind {
  if (kind === "video") return "video";
  if (VIDEO_EXT_RE.test(url)) return "video";
  return kind ?? "image";
}

/**
 * Video test for a Compose postMedia item ({url, file?}). Lives HERE so the
 * media tile, the submit gates, and the preview `mediaKinds` all share ONE
 * classifier — they MUST agree on what's a video (see PreviewMedia's warning).
 *
 * The URL fallback exists for items with no File — Media-Library picks and
 * restored drafts. S3 keys preserve the original filename's extension CASE
 * (media.router/`/api/upload` use `fileName.split(".").pop()`, and iPhone
 * videos are ".MOV"), so the test must be case-insensitive: a case-sensitive
 * version of this shipped as a broken tile + hidden Thumbnail/Super-text
 * controls + an <img>-ingests-video Safari memory kill (2026-09-01).
 *
 * ⚠️ The bare "video" substring test is a pre-existing LAST-RESORT net, kept
 * only to preserve prior behavior — do NOT lean on it. Every real path is
 * already covered by the two tests above it: fresh uploads carry a File MIME
 * type, and every URL our own upload paths mint ends in `.{ext}`. Unlike the
 * preview's img/video choice, a FALSE video here is not merely cosmetic — it
 * would offer Super text on an image, and the burn worker fails the post
 * rather than publishing an unburned file. It is safe today only because our
 * S3 keys are `{orgId}/{ts}-{rand}.{ext}` and carry no original filename.
 */
export function isVideoMediaItem(m: { url: string; file?: { type: string } }): boolean {
  return !!(
    m.file?.type.startsWith("video/") ||
    VIDEO_EXT_RE.test(m.url) ||
    m.url.toLowerCase().includes("video")
  );
}

/**
 * The ONLY way previews may render a media URL.
 *
 * ⚠️ NEVER render a VIDEO url through <img>. WebKit's image loader ingests
 * the ENTIRE blob into memory before giving up — measured +1.57GB RSS for a
 * 1.6GB camera file (Playwright WebKit 26.0, 2026-07-21). That ingestion is
 * what got Safari compose tabs memory-killed mid-upload ("this webpage was
 * reloaded because it was using significant memory"). Chromium sniffs the
 * first bytes and cancels in ~9ms, so the bug is INVISIBLE in Chrome — do
 * not "simplify" this back to a bare <img>.
 *
 * Local blob: videos render a static placeholder — no media element at all:
 * even a preload="metadata" <video> triggers multi-hundred-MB→GB read bursts
 * in WebKit for high-bitrate local blobs. Remote (http) videos stream over
 * ranged HTTP and stay flat, so they get a real metadata-only <video>.
 */
export function PreviewMedia({
  url,
  kind,
  className,
  alt,
}: {
  /** undefined tolerated so guarded `mediaUrls[0]` reads type-check under noUncheckedIndexedAccess */
  url: string | undefined;
  kind?: MediaKind;
  className: string;
  alt?: string;
}) {
  if (!url) return null;
  if (classifyMediaUrl(url, kind) === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={alt ?? "Post media"} className={className} />;
  }
  if (url.startsWith("blob:")) {
    return (
      <div className={`${className} flex items-center justify-center bg-zinc-900`}>
        <div className="flex flex-col items-center gap-1 text-zinc-300">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
            <Play className="h-5 w-5 fill-current" />
          </div>
          <span className="text-[10px] font-medium">Video</span>
        </div>
      </div>
    );
  }
  // controls: owner request 2026-07-21 — a static frame read as "preview
  // doesn't work"; native play/pause makes it obviously alive. No autoplay,
  // so no muted requirement.
  return <video src={withPosterHint(url)} className={className} controls playsInline preload="metadata" />;
}
