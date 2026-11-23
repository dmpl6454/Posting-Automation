/**
 * Snapchat Public Profile API — posting helpers (2026-11-23).
 *
 * Verified against developers.snap.com/marketing-api/Public-Profile-API
 * (ProfileAssetManagement + Metrics pages, read 2026-11-23):
 *
 *   1. Encrypt the file: AES-256-CBC, random 32-byte key + 16-byte IV, PKCS#7
 *      padding (what `openssl enc -aes-256-cbc -nosalt` produces).
 *   2. POST /v1/public_profiles/{profile_id}/media
 *        { type: VIDEO|IMAGE, name, key: base64, iv: base64 }
 *      → { media_id, add_path, finalize_path }. A media object lives 24h.
 *   3. POST https://businessapi.snapchat.com{add_path}  multipart/form-data
 *        action=ADD, file=<encrypted part ≤32 MB>, part_number=1..35
 *      then {finalize_path} with action=FINALIZE. Max file 1 GB.
 *   4. POST /v1/public_profiles/{profile_id}/spotlights
 *        { media_id, description ≤160, locale }  → { spotlight_id }
 *      or /stories { media_id } → { request_id, request_status } (NO id).
 *
 * Spotlight: mp4 video only, 5–300 s. Story: mp4 video 5–300 s, or an image.
 *
 * Pure decisions live here so they are unit-tested; the provider does the I/O.
 */
import { createCipheriv, randomBytes } from "node:crypto";

export const SNAP_API = "https://businessapi.snapchat.com";
/** Snap's part ceiling is 32 MB; parts are numbered 1..35. */
export const SNAP_PART_BYTES = 32 * 1024 * 1024;
export const SNAP_MAX_PARTS = 35;
export const SNAP_MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const SNAP_DESCRIPTION_MAX = 160;

export type SnapSurface = "SPOTLIGHT" | "STORY";

/**
 * Where a post goes. A STORY-format target is always a Story; an image can only
 * be a Story (Spotlight is video-only); a video defaults to Spotlight.
 */
export function chooseSnapSurface(opts: { format?: unknown; isVideo: boolean }): SnapSurface {
  if (opts.format === "STORY") return "STORY";
  return opts.isVideo ? "SPOTLIGHT" : "STORY";
}

export function isVideoMedia(mime: string | undefined, url: string): boolean {
  if (mime) return mime.startsWith("video/");
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(url);
}

/**
 * Spotlight description: ≤160 characters. Cut at a word boundary and end with
 * "…" rather than letting Snap reject the whole post.
 */
export function snapDescription(content: string): string {
  const text = content.trim();
  const chars = Array.from(text);
  if (chars.length <= SNAP_DESCRIPTION_MAX) return text;
  const head = chars.slice(0, SNAP_DESCRIPTION_MAX - 1).join("");
  const cut = head.lastIndexOf(" ");
  return (cut > SNAP_DESCRIPTION_MAX * 0.6 ? head.slice(0, cut) : head).trimEnd() + "…";
}

/** A fresh AES-256-CBC key + IV, plus the base64 forms Create Media wants. */
export function newSnapEncryption() {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  return { key, iv, key64: key.toString("base64"), iv64: iv.toString("base64") };
}

/**
 * Encrypt a stream of plaintext chunks and hand out ≤32 MB ciphertext parts in
 * order, so a 1 GB video never sits in memory at once (peak ≈ 2 parts).
 */
export async function* encryptedParts(
  source: AsyncIterable<Uint8Array>,
  key: Buffer,
  iv: Buffer,
  partBytes: number = SNAP_PART_BYTES
): AsyncGenerator<Buffer> {
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const take = function* (final: boolean): Generator<Buffer> {
    while (pendingBytes >= partBytes || (final && pendingBytes > 0)) {
      const all = Buffer.concat(pending);
      const n = Math.min(partBytes, all.length);
      yield all.subarray(0, n);
      const rest = all.subarray(n);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  };
  for await (const chunk of source) {
    const out = cipher.update(chunk);
    if (out.length) {
      pending.push(out);
      pendingBytes += out.length;
    }
    yield* take(false);
  }
  const last = cipher.final();
  if (last.length) {
    pending.push(last);
    pendingBytes += last.length;
  }
  yield* take(true);
}

/** Readable message from a Snap error body — never the raw JSON. */
export function snapErrorMessage(data: any, status: number): string {
  const code: string | undefined = data?.error_code;
  if (code === "AUTHORIZATION_PERMISSION_DENIED" || status === 403) {
    return (
      "Snapchat refused this request (AUTHORIZATION_PERMISSION_DENIED). Our app is not yet approved " +
      "for Snapchat's Public Profile API, or this account does not manage a Public Profile."
    );
  }
  if (code === "MEDIA_EXPIRED") return "Snapchat says the uploaded media expired (24h). Retry to upload it again.";
  const text = data?.display_message || data?.debug_message || data?.error_code;
  return `Snapchat returned an error (HTTP ${status})${text ? `: ${String(text).slice(0, 300)}` : ""}.`;
}

/** Snap answers 2xx with request_status ERROR on some failures. */
export function snapRequestOk(res: { ok: boolean }, data: any): boolean {
  return res.ok && (!data?.request_status || String(data.request_status).toUpperCase() === "SUCCESS");
}

/**
 * Stats response → field name → lifetime value. Snap returns values as strings.
 * With no breakdown each field has exactly one stat.
 */
export function readSnapStats(data: any): Map<string, number> {
  const out = new Map<string, number>();
  const asset = Array.isArray(data?.assets) ? data.assets[0] : undefined;
  if (!asset || (asset.sub_request_status && asset.sub_request_status !== "SUCCESS")) return out;
  const series = Array.isArray(asset.timeseries) ? asset.timeseries[0] : undefined;
  for (const f of Array.isArray(series?.fields) ? series.fields : []) {
    const name = f?.field?.field_name;
    const dim = f?.field?.report_dimension;
    if (typeof name !== "string" || (dim && dim !== "DEFAULT")) continue;
    const raw = Array.isArray(f.stats) ? f.stats[0]?.value : undefined;
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (Number.isFinite(n)) out.set(name, n);
  }
  return out;
}

/** Public Spotlight URL. Stories have no per-post URL; link the profile. */
export function spotlightUrl(spotlightId: string): string {
  return `https://www.snapchat.com/spotlight/${encodeURIComponent(spotlightId)}`;
}
export function profileUrl(username: string | undefined): string {
  return username ? `https://www.snapchat.com/add/${encodeURIComponent(username)}` : "https://www.snapchat.com/";
}
/** Stories return no id — the media id stands in, prefixed so it is never mistaken for a Spotlight id. */
export const STORY_ID_PREFIX = "story:";
