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

/** Max scene captions to rotate through the lower-third. */
const MAX_CAPTION_SCENES = 4;
/**
 * Hard cap on a single caption line. drawtext does NOT word-wrap, so at fontsize
 * 40 on a 720px-wide (720×1280) frame an ~80-char line runs off both edges;
 * ~48 chars keeps a single proportional line inside the frame and readable.
 */
const CAPTION_MAX_CHARS = 48;

/**
 * Build the ordered list of ffmpeg `drawtext` filter strings for the Seedance
 * caption burn — a CLEAN lower-third:
 *   • a PERSISTENT title line (no `enable=`), sitting near the bottom; and
 *   • ONE rotating scene caption at a time, time-sliced via
 *     `enable='between(t,A,B)'`, positioned ABOVE the title so at most two
 *     lines (title + current scene) ever show at once.
 *
 * Returned as an array of filter strings; the caller joins with "," into the
 * single `-vf` element passed to `execFileSync("ffmpeg", [...])` (NO shell).
 *
 * SECURITY: the `escape` callback (escapeDrawText) is applied to EVERY caption
 * TEXT value — title + each scene — because the text is article-derived and
 * attacker-influenceable. The `between(t,A,B)` window bounds are NUMBERS we
 * compute here (never user input); the single quotes around `between(...)` are
 * filtergraph-level quoting that make the commas/colons inside safe, so we must
 * NOT run that expression through `escape` (doing so would break the filter).
 *
 * Guards: sceneCount === 0 → just the title; durationSeconds <= 0 → scenes get
 * NO `enable=` (persistent fallback, no zero-width windows); all-empty → [].
 */
export function buildCaptionDrawtextFilters(
  opts: { title: string; scenes: string[]; durationSeconds: number },
  escape: (s: string) => string
): string[] {
  const filters: string[] = [];

  const cleanTitle = opts.title.trim();
  const scenes = opts.scenes
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CAPTION_SCENES);

  // Nothing to show at all.
  if (!cleanTitle && scenes.length === 0) return filters;

  // ── Persistent TITLE (lower-third, no enable=) ──────────────────────────
  // Sits near the very bottom; the scene caption stacks ABOVE it.
  if (cleanTitle) {
    const escapedTitle = escape(cleanTitle.slice(0, CAPTION_MAX_CHARS));
    filters.push(
      `drawtext=text='${escapedTitle}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=h-text_h-60:box=1:boxcolor=black@0.6:boxborderw=18`
    );
  }

  // ── Rotating SCENE captions (time-sliced, one at a time) ────────────────
  // Each sits ABOVE the title line so only title + one scene show at once.
  const sceneCount = scenes.length;
  if (sceneCount > 0) {
    const hasWindows = opts.durationSeconds > 0;
    const seg = hasWindows ? opts.durationSeconds / sceneCount : 0;

    scenes.forEach((scene, i) => {
      const escapedScene = escape(scene.slice(0, CAPTION_MAX_CHARS));
      // y ABOVE the title: title box is ~text_h+~36 tall and anchored at
      // y=h-text_h-60; place the scene a fixed band higher.
      const base = `drawtext=text='${escapedScene}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=h-text_h-200:box=1:boxcolor=black@0.55:boxborderw=18`;
      if (hasWindows) {
        // A and B are computed NUMBERS, NOT user input. The single quotes here
        // are filtergraph-level — keep them; do NOT escape the inner expr.
        const a = (i * seg).toFixed(2);
        const b = ((i + 1) * seg).toFixed(2);
        filters.push(`${base}:enable='between(t,${a},${b})'`);
      } else {
        // durationSeconds <= 0 → can't time-slice; show persistently.
        filters.push(base);
      }
    });
  }

  return filters;
}
