/**
 * Pure helpers for the super-text burn. Kept separate from the worker so the
 * ffmpeg contract and the integrity rule are unit-testable without Redis, S3,
 * Puppeteer or a database.
 */

/**
 * ffmpeg argv for compositing the pre-rendered transparent strip PNG over the
 * source video.
 *
 * SECURITY: an argv ARRAY executed through async execFile (NO shell) — the same
 * contract as video-overlay.ts and media-optimize.ts. Nothing here is shell-quoted
 * and no user text reaches ffmpeg at all (the text lives in the PNG), which is
 * precisely why this design avoids the `drawtext` escaping minefield.
 *
 * The strip PNG is rendered at the video's native size, so the composite is a
 * plain `overlay=0:0` — all positioning already happened in CSS, shared with the
 * live preview.
 *
 * `-c:a copy` keeps the original audio bit-for-bit (no re-encode, no drift).
 */
export function buildSuperTextCompositeArgs(opts: {
  inputPath: string;
  overlayPngPath: string;
  outputPath: string;
}): string[] {
  return [
    "-y",
    "-i", opts.inputPath,
    "-i", opts.overlayPngPath,
    "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[vout]",
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    // Leave a core for the rest of the box (prod is a 4-core Linode shared with
    // Postgres + MinIO), matching media-optimize's transcode budget.
    "-threads", "3",
    opts.outputPath,
  ];
}

/**
 * PR #144 lesson, applied to the burn: a stalled encode can exit 0 having written
 * a TRUNCATED file. Publishing a silently-cut video is worse than failing, so the
 * output duration must be within 2% of the source.
 *
 * Fail-OPEN when the SOURCE duration is unknown (probe gap — we have nothing to
 * compare against); fail-CLOSED when the OUTPUT duration is unreadable (that is
 * itself a sign the encode produced something unusable).
 */
export function durationIntegrityOk(
  sourceSec: number | undefined,
  outputSec: number | undefined
): boolean {
  if (!sourceSec || !Number.isFinite(sourceSec)) return true;
  if (!outputSec || !Number.isFinite(outputSec)) return false;
  return outputSec >= sourceSec * 0.98;
}
