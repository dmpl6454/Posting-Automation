/**
 * Compose measures the first attached video once, with ONE detached <video>
 * element (see the probe effect in ComposeTab — keyed on the URL string, never
 * on the postMedia array). The outcome is stored WITH the URL it was measured
 * from, so a reading for video A can never be used to judge video B: until the
 * current URL has its own outcome, its length is "pending" (2026-10-28 review —
 * the old probe never reset, so TikTok's length check could read the previous
 * video's duration).
 */

/** What the probe recorded for one URL. */
export interface VideoProbeOutcome {
  url: string;
  /** "done" = a usable duration was read; "failed" = error, timeout or no duration. */
  status: "done" | "failed";
}

export type VideoLengthStatus = "none" | "pending" | "done" | "failed";

/** A probe that never answers (stalled remote URL) stops blocking after this. */
export const VIDEO_PROBE_TIMEOUT_MS = 20_000;

export function videoLengthStatus(url: string | null, outcome: VideoProbeOutcome | null): VideoLengthStatus {
  if (!url) return "none";
  if (!outcome || outcome.url !== url) return "pending";
  return outcome.status;
}

/** The duration to judge THIS video by, or null when it is not known for it. */
export function probedDurationFor(
  url: string | null,
  outcome: VideoProbeOutcome | null,
  durationSec: number | null
): number | null {
  if (videoLengthStatus(url, outcome) !== "done") return null;
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  return durationSec;
}
