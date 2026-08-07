/**
 * ffmpeg argv construction for the video watermark/overlay pass.
 *
 * Deliberately its OWN module with ZERO imports. `video-overlay.ts` pulls in
 * `@postautomation/ai` (for the concurrency semaphore) and the AWS SDK, which
 * drags the whole langchain/langsmith graph into anything that touches it —
 * enough to make a unit test of a pure argv builder unrunnable. A regression
 * guard that cannot execute protects nothing, and the constraints below guard a
 * real production incident, so the pure part lives here where it can always be
 * tested cheaply. Same split as publish-stagger.ts / engagement-rate.ts.
 *
 * `video-overlay.ts` re-exports this, so existing importers are unaffected.
 */

/**
 * Per-encode thread cap. ffmpeg defaults to "use every core", so at
 * VIDEO_OVERLAY_CONCURRENCY=2 two runs consumed ~350% of the 4-core prod box
 * (measured 2026-08-07: load 14.7, 2% idle) and starved nginx/MinIO — which is
 * what made Instagram's own fetch of the finished video slow enough to blow the
 * publish poll budget. Capping threads keeps a core free to actually SERVE.
 *
 * ⚠️ Keep VIDEO_OVERLAY_CONCURRENCY × VIDEO_OVERLAY_THREADS below the core
 * count, or this regresses to the same starvation.
 */
export function overlayThreads(): number {
  return Math.max(1, parseInt(process.env.VIDEO_OVERLAY_THREADS || "", 10) || 2);
}

/**
 * Build the ffmpeg argument ARRAY for the overlay pass (pure — no I/O).
 *
 * SECURITY: every element is a discrete, UNQUOTED arg. With `execFile`
 * (no shell) each array element is passed verbatim, so shell metachars in
 * the (user-controlled) `text`/`channelName` baked into `filterComplex` are
 * inert. Do NOT wrap any element in shell quotes — quotes would become part
 * of the literal filename / filtergraph value.
 *   - `inputArgs` is already discrete (`["-i", path1, "-i", path2, ...]`).
 *   - `filterComplex` is ONE element (do not split / quote).
 *   - `[vout]` and `outputPath` are their own UNQUOTED elements.
 */
export function buildOverlayFfmpegArgs(opts: {
  inputArgs: string[];
  filterComplex: string;
  outputPath: string;
}): string[] {
  return [
    "-y",
    ...opts.inputArgs,
    "-filter_complex",
    opts.filterComplex,
    "-map",
    "[vout]",
    "-map",
    "0:a?",
    // ⚠️ RATE CONTROL IS LOAD-BEARING — do NOT drop these back to a bare
    // `-preset ultrafast`. Burning an overlay forces a video re-encode, and
    // with no -crf/-maxrate the encoder holds quality by SPENDING BITS: on
    // 2026-08-07 a 35.7MB optimized rendition came back out at 128MB (3.6×,
    // ~10Mbps) for every target of one post. Instagram then had to pull 128MB
    // per target from a CPU-saturated box, so its container processing outran
    // the publish poll budget and 22 of 39 targets FAILED with
    // "media processing timed out" — and each failure's retry queued ANOTHER
    // encode (83 encodes for 39 targets), so the load fed itself.
    // These settings mirror the ones media-optimize.ts already proves in
    // production; the two ffmpeg paths must stay in step, otherwise this pass
    // silently undoes the optimizer's work.
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    "6M",
    "-bufsize",
    "12M",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    String(overlayThreads()),
    "-codec:a",
    "copy",
    "-movflags",
    "+faststart",
    opts.outputPath,
  ];
}
