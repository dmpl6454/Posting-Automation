/**
 * Pure helpers for the repurpose-video worker.
 *
 * Kept tiny + side-effect-free so they're unit-testable without spinning up
 * BullMQ/Redis/S3. The worker handler itself isn't unit-tested; these encode
 * the contract of the terminal progress payloads the repurpose UI parses.
 */

/**
 * Build the `detail` string for the terminal `video_ready` progress step.
 * The repurpose UI JSON.parses this to attach the finished Media to a draft.
 */
export function buildVideoReadyDetail(mediaId: string, url: string, format: string): string {
  return JSON.stringify({ mediaId, url, format });
}

/**
 * Build the `detail` string for the `video_error` progress step. The message
 * is already passed through `friendlyAIMessage` by the caller, so it's a clean,
 * non-leaking string — we pass it straight through.
 */
export function buildVideoErrorDetail(message: string): string {
  return message;
}

/**
 * Worker-local mirror of `friendlyAIMessage` from
 * `packages/api/src/lib/ai-errors.ts`. Inlined (not imported) so the worker
 * doesn't pull the whole `@postautomation/api` tRPC router graph in at module
 * load. Keeps the SAME contract: missing-key / billing / project-id leaks are
 * mapped to non-leaking, user-actionable strings; never surfaces raw provider
 * JSON to the progress stream.
 */
export function friendlyVideoError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const msg = raw.toLowerCase();

  const isMissingKey =
    msg.includes("api key not found") ||
    msg.includes("api key is required") ||
    (msg.includes("environment variable is required") && msg.includes("key")) ||
    (msg.includes("is required for") && msg.includes("key")) ||
    msg.includes("_api_key") ||
    msg.includes("fal_key is required") ||
    msg.includes("not configured");
  if (isMissingKey) {
    return "AI provider not configured — ask your workspace admin to set the API key.";
  }

  const isBilling =
    msg.includes("permission_denied") ||
    msg.includes("dunning") ||
    msg.includes("insufficient_quota") ||
    msg.includes("billing") ||
    msg.includes("quota exceeded") ||
    (/\b(401|403)\b/.test(msg) && (msg.includes("forbidden") || msg.includes("denied")));
  if (isBilling) {
    return "The AI video provider is temporarily unavailable (billing or permission issue). Please try again later or contact your admin.";
  }

  // Strip any leaked Google project IDs / long JSON before showing.
  if (/projects\/\d+|"status"\s*:/.test(raw)) {
    return "Video generation failed due to a provider error. Please try again.";
  }
  // Final fallthrough: never echo a raw provider string back to the progress
  // stream (it can contain endpoint paths, request ids, stack frames, etc.).
  return "Video generation failed. Please try again or contact support.";
}

/**
 * Escape a caption string for ffmpeg `drawtext`.
 *
 * Two layers:
 * 1. drawtext filter escaping — backslash, single-quote (→ typographic
 *    apostrophe), colon and square brackets are the chars drawtext treats
 *    specially inside `text='...'`.
 * 2. Defense-in-depth — even though the caption is now passed to ffmpeg via
 *    `execFileSync` (NO shell), we also backslash-escape `"` and strip ASCII
 *    control chars so a malicious title can never break out of the filter
 *    string or inject terminal/control sequences.
 */
export function escapeDrawText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, " ") // strip ASCII control chars (defense-in-depth)
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "’")
    .replace(/"/g, '\\"')
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}
