/**
 * Browser-side helper for direct-to-S3 multipart uploads via presigned URLs.
 *
 * Bypasses the Next.js API route entirely — the file streams from the browser
 * straight to the S3/MinIO bucket. Raises the practical upload ceiling from
 * ~500 MB (proxied) to multiple GB without buffering on the web container.
 *
 * Caller supplies mutateAsync handles for the three tRPC mutations. We don't
 * import tRPC types here to keep this helper UI-framework-agnostic.
 */

interface InitiateResult {
  uploadId: string;
  key: string;
  bucket: string;
}

interface CompleteResult {
  id: string;
  url: string;
  fileName: string;
  fileType: string;
}

interface UploadParams {
  file: File;
  category?: string;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** Test hook — base backoff delay between part retries (default 1s). */
  retryBaseDelayMs?: number;
  api: {
    initiate: (input: { fileName: string; fileType: string; fileSize: number; category?: string }) => Promise<InitiateResult>;
    signPart: (input: { key: string; uploadId: string; partNumber: number }) => Promise<{ url: string }>;
    complete: (input: {
      key: string;
      uploadId: string;
      parts: { partNumber: number; etag: string }[];
      fileName: string;
      fileType: string;
      fileSize: number;
      category?: string;
    }) => Promise<CompleteResult>;
    abort: (input: { key: string; uploadId: string }) => Promise<{ success: boolean }>;
  };
}

// S3 minimum part size is 5 MiB except for the last part. 8 MiB is a good
// default — smaller parts mean more overhead, larger parts hurt parallelism.
const PART_SIZE = 8 * 1024 * 1024;
const MAX_PARALLEL_PARTS = 4;

// A 3–4GB upload is 400–500 parts over 30–90 minutes on a residential uplink —
// at least one transient network blip is near-certain in that window. Each part
// retries independently (with a FRESH presigned URL per attempt, so URL expiry
// can never fail a retry); only exhausting all attempts aborts the upload.
const PART_ATTEMPTS = 4; // 1 initial + 3 retries
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000; // 1s → 3s → 9s (+ jitter)
// Generous per-part ceiling: 8 MiB at even ~150 kbit/s fits in 10 minutes.
// Catches genuinely hung sockets without killing slow-but-alive links.
const PART_TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors that retrying can never fix — user aborts and hung-abort signals. */
const isAbortError = (err: unknown) =>
  err instanceof Error && err.message === "Upload aborted";

/**
 * PUT a single Blob to a presigned URL via XHR (so we get progress events).
 * Returns the ETag header from S3.
 */
function putPart(
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // S3 returns the part ETag in a quoted-string. CORS expose required.
        const etag = xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag");
        if (!etag) {
          reject(new Error("S3 did not return an ETag for part — check bucket CORS exposes the ETag header"));
          return;
        }
        resolve(etag.replace(/"/g, ""));
      } else {
        reject(new Error(`Part upload failed with status ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during part upload"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.timeout = PART_TIMEOUT_MS;
    xhr.ontimeout = () => reject(new Error("Part upload timed out"));
    if (signal) {
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

export async function uploadFileMultipart(params: UploadParams): Promise<CompleteResult> {
  const { file, category, onProgress, signal, api } = params;
  const retryBaseDelayMs = params.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  // 1. Initiate
  const initiate = await api.initiate({
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    category,
  });

  // 2. Split into parts
  const totalParts = Math.ceil(file.size / PART_SIZE);
  const parts: { partNumber: number; etag: string }[] = [];
  const loadedPerPart = new Array<number>(totalParts).fill(0);

  // Only report whole-percent CHANGES. XHR progress events fire many times per
  // second per worker; forwarding every event caused ~40-80 React state updates
  // per second in the compose UI for the whole duration of a multi-GB upload.
  let lastReportedPct = -1;
  const reportTotal = () => {
    if (!onProgress) return;
    const loaded = loadedPerPart.reduce((a, b) => a + b, 0);
    const pct = Math.min(99, Math.floor((loaded / file.size) * 100));
    if (pct === lastReportedPct) return;
    lastReportedPct = pct;
    onProgress(pct);
  };

  const uploadOne = async (partNumber: number): Promise<void> => {
    const start = (partNumber - 1) * PART_SIZE;
    const end = Math.min(start + PART_SIZE, file.size);
    const blob = file.slice(start, end);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new Error("Upload aborted");
      try {
        // Fresh presigned URL every attempt — an expired/consumed URL from a
        // failed attempt is never reused.
        const { url } = await api.signPart({
          key: initiate.key,
          uploadId: initiate.uploadId,
          partNumber,
        });

        const etag = await putPart(
          url,
          blob,
          (loaded) => {
            loadedPerPart[partNumber - 1] = loaded;
            reportTotal();
          },
          signal
        );

        parts.push({ partNumber, etag });
        return;
      } catch (err) {
        lastErr = err;
        if (signal?.aborted || isAbortError(err)) throw err;
        // Roll this part's progress back so the bar doesn't lie during retry.
        loadedPerPart[partNumber - 1] = 0;
        reportTotal();
        if (attempt < PART_ATTEMPTS) {
          // Exponential backoff (1s → 3s → 9s at the default base) + jitter.
          await sleep(retryBaseDelayMs * 3 ** (attempt - 1) + Math.random() * (retryBaseDelayMs / 2));
        }
      }
    }
    throw lastErr;
  };

  // 3. Parallel uploads (bounded)
  try {
    const queue = Array.from({ length: totalParts }, (_, i) => i + 1);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_PARALLEL_PARTS, totalParts); i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (next === undefined) return;
            await uploadOne(next);
          }
        })()
      );
    }
    await Promise.all(workers);
  } catch (err) {
    // Best-effort abort so S3 frees the in-progress parts
    try {
      await api.abort({ key: initiate.key, uploadId: initiate.uploadId });
    } catch {}
    throw err;
  }

  // 4. Complete
  const result = await api.complete({
    key: initiate.key,
    uploadId: initiate.uploadId,
    parts,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    category,
  });

  onProgress?.(100);
  return result;
}
