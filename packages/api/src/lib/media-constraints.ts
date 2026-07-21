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
  probe?: { durationSec?: number };
}

export function validateVideoAgainstPlatforms(
  media: Array<{ fileName: string; fileType: string; fileSize: number; metadata: unknown }>,
  platforms: string[]
): string | null {
  if (!platforms.some((p) => META_PLATFORMS.has(p))) return null;
  for (const m of media) {
    if (!m.fileType.startsWith("video/")) continue;
    const opt = (m.metadata as { optimize?: OptimizeMeta } | null)?.optimize;
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
