/**
 * Pure helpers for interpreting the terminal video progress events the
 * repurpose-video worker (Phase 2b, T2) publishes to the userId-scoped progress
 * channel:
 *
 *   { step: "video_ready", status: "done",  detail: JSON.stringify({ mediaId, url, format }) }
 *   { step: "video_error", status: "error", detail: <friendly message> }
 *
 * The RepurposeTab SSE handler runs every incoming step through these so it can
 * render the finished video (T4) instead of a false "repurposed!" success.
 */

export interface VideoProgressStep {
  step: string;
  status?: string;
  detail?: string;
}

export interface VideoReadyPayload {
  mediaId: string;
  url: string;
  format: string;
}

/**
 * Returns the parsed `{ mediaId, url, format }` ONLY when the step is the
 * terminal `video_ready` step and its `detail` is valid JSON carrying at least
 * `mediaId` + `url`. Returns `null` for anything else — wrong step, missing
 * detail, malformed JSON (never throws), or missing required fields. `format`
 * defaults to "" when the JSON omits it.
 */
export function parseVideoReadyEvent(step: VideoProgressStep): VideoReadyPayload | null {
  if (step.step !== "video_ready") return null;
  if (typeof step.detail !== "string" || step.detail.length === 0) return null;

  try {
    const parsed = JSON.parse(step.detail) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const mediaId = obj.mediaId;
    const url = obj.url;
    if (typeof mediaId !== "string" || mediaId.length === 0) return null;
    if (typeof url !== "string" || url.length === 0) return null;
    const format = typeof obj.format === "string" ? obj.format : "";
    return { mediaId, url, format };
  } catch {
    return null;
  }
}

/** True when the step signals the worker's terminal `video_error`. */
export function isVideoErrorEvent(step: VideoProgressStep): boolean {
  return step.step === "video_error";
}

/**
 * On a terminal video event (`video_ready` / `video_error` / `__finished__`),
 * the activity-log steps that the worker only ever published as "running"
 * (e.g. "Generating AI video (Seedance)", "Adding captions", "Uploading video")
 * would otherwise spin forever, because the client closes the SSE before the
 * worker's "done" re-publishes arrive. This flips every still-"running" step to
 * the terminal `status`, leaving every other status (done/error/skipped)
 * untouched. Pure + non-mutating (returns a new array with new objects only for
 * the running entries).
 */
export function finalizeRunningSteps<T extends { status: string }>(
  steps: T[],
  status: "done" | "error",
): T[] {
  return steps.map((s) => (s.status === "running" ? { ...s, status } : s));
}
