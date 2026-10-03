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
  /**
   * Intro scope (2026-10-02): keep the strip on screen only for the first N
   * seconds. Absent ⇒ the original every-frame overlay, byte-identical argv.
   * N is a NUMBER we format ourselves — never user text — so the ffmpeg
   * expression cannot be injected into.
   */
  showForSeconds?: number;
}): string[] {
  const window =
    typeof opts.showForSeconds === "number" && Number.isFinite(opts.showForSeconds) && opts.showForSeconds > 0
      ? `:enable='lte(t,${Math.min(3600, Math.max(0.1, opts.showForSeconds)).toFixed(2)})'`
      : "";
  return [
    "-y",
    "-i", opts.inputPath,
    "-i", opts.overlayPngPath,
    "-filter_complex", `[0:v][1:v]overlay=0:0:format=auto${window}[vout]`,
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

/* ─── Orientation ───────────────────────────────────────────────────────────
 * Incident 2026-10-03 (owner screenshot of an Instagram story): the strip sat
 * at MID-height, started right of centre and ran off the frame. The source
 * was a phone video — coded 1920×1080 with a 90° display matrix. ffprobe
 * reports the CODED size (`width:1920,height:1080`) and the rotation
 * separately, while ffmpeg auto-rotates on decode, so the overlay base frame
 * is 1080×1920. The strip PNG was therefore laid out on a landscape canvas
 * (84% down = 907px, centred at 960px) and composited top-left onto a portrait
 * frame: 907px is 47% of 1920, and a block centred at 960px on a 1080px frame
 * hangs off the right edge. Exactly the screenshot.
 *
 * The strip must be rendered at the DISPLAY size — the size the pixels have
 * after ffmpeg's rotation — so these helpers read the rotation the same way
 * ffmpeg does and swap the axes for 90°/270°. The cover path never had this
 * bug: it grabs a real frame with ffmpeg (already rotated) and sizes the strip
 * to the frame.
 */

/** The subset of an ffprobe video-stream object the orientation logic reads. */
export interface ProbeVideoStream {
  width?: number;
  height?: number;
  /** ffmpeg < 5 wrote the mov rotation as a tag: `"rotate": "90"`. */
  tags?: { rotate?: string | number } & Record<string, unknown>;
  /** ffmpeg ≥ 5 reports it as Display Matrix side data: `rotation: -90` (CCW-positive). */
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

/**
 * The stream's rotation normalised to 0 | 90 | 180 | 270. Side data wins over
 * the legacy tag (ffmpeg itself reads the display matrix first). Anything
 * unreadable is 0 — an unknown rotation must not flip a correct canvas.
 */
export function streamRotation(stream: ProbeVideoStream | undefined): 0 | 90 | 180 | 270 {
  if (!stream) return 0;
  let raw: number | undefined;
  const sd = stream.side_data_list?.find((d) => typeof d?.rotation === "number" && Number.isFinite(d.rotation));
  if (sd) raw = sd.rotation;
  else if (stream.tags?.rotate !== undefined) {
    const n = Number(stream.tags.rotate);
    if (Number.isFinite(n)) raw = n;
  }
  if (raw === undefined) return 0;
  // Only quarter turns are meaningful for an axis swap; a display matrix with
  // an arbitrary angle (rare, e.g. a 45° flip) is rounded to the nearest one.
  const q = ((Math.round(raw / 90) % 4) + 4) % 4;
  return ([0, 90, 180, 270] as const)[q]!;
}

/**
 * The pixel size the video has AFTER ffmpeg's auto-rotation, which is the size
 * the strip PNG must be rendered at for `overlay=0:0` to line up with the CSS
 * preview. 90°/270° swap width and height; 0°/180° keep them.
 */
export function displayDimensions(stream: ProbeVideoStream | undefined): {
  width?: number;
  height?: number;
  rotation: 0 | 90 | 180 | 270;
} {
  const rotation = streamRotation(stream);
  const w = stream?.width;
  const h = stream?.height;
  if (rotation === 90 || rotation === 270) return { width: h, height: w, rotation };
  return { width: w, height: h, rotation };
}
