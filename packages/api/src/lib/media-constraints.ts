/**
 * Early platform-constraint validation for video media (owner-approved
 * 2026-07-21). Runs at post CREATION so a KNOWN-unpublishable combination is
 * refused with a plain, actionable message instead of an opaque platform
 * error minutes later (live case: IG error 2207076 after 6 attempts on a
 * 1.75GB PCM-audio camera master).
 *
 * Deliberately narrow: only verdicts that are CERTAIN from stored data are
 * rejected here (optimization failed; probed duration over IG's cap).
 * Everything else — including >1GB videos, which the media-optimize pipeline
 * shrinks automatically — proceeds, and the publish worker stays the
 * authoritative gate.
 */

import { formatTikTokDuration } from "@postautomation/social/src/utils/tiktok-posting";

const META_PLATFORMS = new Set(["INSTAGRAM", "FACEBOOK"]);
const IG_MAX_DURATION_SEC = 15 * 60; // Instagram reels/video ceiling

interface OptimizeMeta {
  status?: string;
  reasons?: string[];
  error?: string;
  probe?: { durationSec?: number; fps?: number; width?: number; height?: number };
}

/**
 * TikTok limits that NO rendition can fix (2026-10-28): every creator may post at
 * most 10 minutes through the API (their own cap, often 3, is checked at publish
 * time against creator_info); 23 fps minimum (the rendition caps fps, it never
 * raises it); 360 px minimum per side (the rendition only scales down). Too-fast,
 * too-big and odd codecs are fixed by the rendition, so they are not refused here.
 */
const TIKTOK_MAX_DURATION_SEC = 600;
const TIKTOK_MIN_FPS = 23;
const TIKTOK_MIN_SIDE_PX = 360;

type MediaDims = { fileName: string; duration?: number | null; width?: number | null; height?: number | null };

const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * The probe's numbers, falling back to the Media columns written from the same
 * probe: a FAILED optimization overwrites `metadata.optimize` with
 * `{status, error}` and drops the probe, which used to wave a 15-minute or 320 px
 * video straight through. (fps has no column, so it is only checked when probed.)
 */
function tiktokVideoProblem(m: MediaDims, probe: OptimizeMeta["probe"]): string | null {
  const durationSec = positive(probe?.durationSec) ?? positive(m.duration);
  const fps = positive(probe?.fps);
  const width = positive(probe?.width) ?? positive(m.width);
  const height = positive(probe?.height) ?? positive(m.height);
  if (durationSec && durationSec > TIKTOK_MAX_DURATION_SEC + 0.5) {
    return `"${m.fileName}" is ${formatTikTokDuration(durationSec)} long — TikTok accepts videos up to ${formatTikTokDuration(TIKTOK_MAX_DURATION_SEC)} (many accounts only 3:00). Trim it and re-upload.`;
  }
  if (fps && fps < TIKTOK_MIN_FPS - 0.5) {
    return `"${m.fileName}" is ${Math.round(fps)} fps — TikTok needs at least 23 fps. Re-export it at 30 fps and re-upload.`;
  }
  const minSide = Math.min(width ?? Infinity, height ?? Infinity);
  if (Number.isFinite(minSide) && minSide < TIKTOK_MIN_SIDE_PX) {
    return `"${m.fileName}" is ${width ?? "?"}x${height ?? "?"} — TikTok needs at least 360 px on each side. Use a larger export.`;
  }
  return null;
}

export function validateVideoAgainstPlatforms(
  media: Array<{
    fileName: string;
    fileType: string;
    fileSize: number;
    metadata: unknown;
    duration?: number | null;
    width?: number | null;
    height?: number | null;
  }>,
  platforms: string[]
): string | null {
  const hasMeta = platforms.some((p) => META_PLATFORMS.has(p));
  const hasTikTok = platforms.includes("TIKTOK");
  if (!hasMeta && !hasTikTok) return null;
  for (const m of media) {
    if (!m.fileType.startsWith("video/")) continue;
    const opt = (m.metadata as { optimize?: OptimizeMeta } | null)?.optimize;
    if (hasTikTok) {
      const problem = tiktokVideoProblem(m, opt?.probe);
      if (problem) return problem;
    }
    if (!hasMeta) continue;
    if (opt?.status === "failed") {
      return (
        `"${m.fileName}" can't be published to Instagram/Facebook: automatic optimization failed ` +
        `(${opt.reasons?.join("; ") || opt.error || "unknown reason"}). ` +
        `Export it as MP4 (H.264 + AAC audio, under 1GB) and re-upload.`
      );
    }
    const duration = opt?.probe?.durationSec;
    if (duration && duration > IG_MAX_DURATION_SEC && platforms.includes("INSTAGRAM")) {
      return (
        `"${m.fileName}" is ${Math.round(duration / 60)} minutes long — Instagram videos must be ` +
        `under 15 minutes. Trim it and re-upload.`
      );
    }
  }
  return null;
}
