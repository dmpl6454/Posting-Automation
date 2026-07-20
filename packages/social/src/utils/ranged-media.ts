/**
 * Ranged media access for STREAMING large-video publishes (Phase 4).
 *
 * The buffer-upload platforms (YouTube resumable, X chunked, LinkedIn
 * instruction-chunked) used to download the ENTIRE video into a Node Buffer
 * before uploading — a 4GB video meant 4GB of worker RAM per concurrent job.
 * These helpers let providers pull one chunk at a time via HTTP Range
 * requests (S3/MinIO — and nginx proxying it — support Range natively), so
 * per-job memory is bounded by the chunk size regardless of file size.
 *
 * Fail-closed: if the media host ignores Range and streams the whole body,
 * `fetchByteRange` THROWS instead of silently buffering gigabytes — callers
 * fall back to the classic buffered path only for small files.
 */

export interface RemoteMediaInfo {
  size: number;
  contentType: string;
}

/**
 * Size + content-type of a remote file without downloading it.
 * Tries HEAD first; falls back to a 1-byte ranged GET (some S3 proxies
 * don't expose Content-Length on HEAD) and parses Content-Range.
 */
export async function headRemoteMedia(url: string): Promise<RemoteMediaInfo> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    const len = parseInt(head.headers.get("content-length") ?? "", 10);
    if (head.ok && Number.isFinite(len) && len > 0) {
      return { size: len, contentType: head.headers.get("content-type") || "application/octet-stream" };
    }
  } catch {
    // fall through to ranged GET
  }

  const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
  // Content-Range: bytes 0-0/123456
  const contentRange = probe.headers.get("content-range") ?? "";
  const total = parseInt(contentRange.split("/")[1] ?? "", 10);
  // Validate BEFORE touching the body: a Range-ignoring host answers 200 with
  // the FULL object here — draining that would buffer gigabytes. Cancel the
  // stream unread instead (review finding, Phase 4).
  if (probe.status !== 206 || !Number.isFinite(total) || total <= 0) {
    await probe.body?.cancel().catch(() => undefined);
    throw new Error(
      `Media host did not honor the size probe for ${url} (HTTP ${probe.status}, content-range: "${contentRange}")`
    );
  }
  // Drain the single-byte body so the socket is released.
  await probe.arrayBuffer().catch(() => undefined);
  return { size: total, contentType: probe.headers.get("content-type") || "application/octet-stream" };
}

/**
 * Fetch bytes [start, endInclusive] of a remote file. Requires the host to
 * honor Range (206). A 200 response is accepted ONLY when the request covers
 * the entire file (start 0 and the body is exactly the full length) —
 * anything else throws rather than buffering an unbounded body.
 */
export async function fetchByteRange(url: string, start: number, endInclusive: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
  if (res.status === 206) {
    return Buffer.from(await res.arrayBuffer());
  }
  if (res.status === 200 && start === 0) {
    // Decide from the Content-Length HEADER, before reading a single byte —
    // reading first would materialize the full multi-GB body in RAM on
    // exactly the Range-ignoring hosts this guard exists for (review
    // finding, Phase 4). A 200 is acceptable only when the requested range
    // provably covers the entire file.
    const declared = parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared === endInclusive + 1) {
      return Buffer.from(await res.arrayBuffer());
    }
    await res.body?.cancel().catch(() => undefined);
    throw new Error(
      `Media host ignored Range for ${url} (HTTP 200, content-length ${declared || "unknown"} for a ${endInclusive + 1}-byte range) — refusing to buffer the full file`
    );
  }
  await res.body?.cancel().catch(() => undefined);
  throw new Error(`Ranged fetch failed (HTTP ${res.status}) for bytes=${start}-${endInclusive} of ${url}`);
}

/** [start, endInclusive] pairs covering totalBytes in chunkSize steps. Pure. */
export function computeByteRanges(totalBytes: number, chunkSize: number): Array<[number, number]> {
  if (totalBytes <= 0 || chunkSize <= 0) return [];
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < totalBytes; start += chunkSize) {
    ranges.push([start, Math.min(start + chunkSize, totalBytes) - 1]);
  }
  return ranges;
}
