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

function tiktokVideoProblem(m: { fileName: string }, probe: OptimizeMeta["probe"]): string | null {
  if (!probe) return null;
  if (probe.durationSec && probe.durationSec > TIKTOK_MAX_DURATION_SEC + 0.5) {
    return `"${m.fileName}" is ${Math.round(probe.durationSec / 60)} minutes long — TikTok accepts videos up to 10 minutes (many accounts only 3). Trim it and re-upload.`;
  }
  if (probe.fps && probe.fps < TIKTOK_MIN_FPS - 0.5) {
    return `"${m.fileName}" is ${Math.round(probe.fps)} fps — TikTok needs at least 23 fps. Re-export it at 30 fps and re-upload.`;
  }
  const minSide = Math.min(probe.width ?? Infinity, probe.height ?? Infinity);
  if (Number.isFinite(minSide) && minSide < TIKTOK_MIN_SIDE_PX) {
    return `"${m.fileName}" is ${probe.width}x${probe.height} — TikTok needs at least 360 px on each side. Use a larger export.`;
  }
  return null;
}

export function validateVideoAgainstPlatforms(
  media: Array<{ fileName: string; fileType: string; fileSize: number; metadata: unknown }>,
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
