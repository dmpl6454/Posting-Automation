"use client";

import { Play } from "lucide-react";

export type MediaKind = "image" | "video";

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i;

/**
 * Classify a media URL when the caller didn't supply an explicit kind.
 * Compose passes kinds (it knows the File type); other callers' URLs are
 * S3/remote and carry an extension.
 */
export function classifyMediaUrl(url: string, kind?: MediaKind): MediaKind {
  if (kind) return kind;
  return VIDEO_EXT_RE.test(url) ? "video" : "image";
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
  return <video src={url} className={className} muted playsInline preload="metadata" />;
}
