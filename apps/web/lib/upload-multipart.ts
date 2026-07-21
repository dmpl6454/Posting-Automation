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
export const PART_ATTEMPTS = 6; // 1 initial + 5 retries
// Finalize converts 30-90 minutes of transferred bytes into a Media row — its
// budget must outlast an incident-class outage (deploy window, container
// crash-loop), not just a Wi-Fi blip. A lost part costs 8MB; a lost complete()
// costs the entire file — the asymmetry is why these differ from PART_*.
export const COMPLETE_ATTEMPTS = 10;
const COMPLETE_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000; // 1s → 3s → 9s → 27s → 30s (capped, + jitter)
// Cap the exponential growth so the total tolerated outage stays ~70s of
// fast-fail attempts — long enough for a typical Wi-Fi/router blip, short
// enough that a genuinely dead link surfaces an error in about a minute.
const MAX_RETRY_DELAY_MS = 30_000;
// Generous per-part ceiling: 8 MiB at even ~150 kbit/s fits in 10 minutes.
// Catches genuinely hung sockets without killing slow-but-alive links.
const PART_TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors that retrying can never fix — user aborts and hung-abort signals. */
const isAbortError = (err: unknown) =>
  err instanceof Error && err.message === "Upload aborted";

/**
 * Terminal upload errors: retrying is provably futile (e.g. storage full).
 * The message doubles as user-facing copy — humanizeError passes short
 * human-readable messages through untouched at every toast site.
 */
const isTerminalUploadError = (err: unknown) =>
  err instanceof Error && err.name === "TerminalUploadError";

/**
 * While the browser is provably offline, retry attempts fail instantly and
 * burn the whole budget in seconds. Pause until connectivity returns (bounded
 * by PART_TIMEOUT_MS; abort-aware) instead of failing a multi-GB upload over
 * a longer blip. No-op wherever navigator.onLine is unavailable (tests/SSR).
 */
function waitForOnline(stop: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("online", onOnline);
      stop.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Upload aborted"));
    };
    const timer = setTimeout(onOnline, PART_TIMEOUT_MS); // give up waiting, let the attempt fail
    window.addEventListener("online", onOnline, { once: true });
    stop.addEventListener("abort", onAbort, { once: true });
  });
}

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
      } else if (xhr.status === 507) {
        // MinIO disk-full (XMinioStorageFull). Unambiguously terminal —
        // burning the retry ladder just hammers an already-stressed box.
        const err = new Error("Upload storage is full. Please try again later or contact support.");
        err.name = "TerminalUploadError";
        reject(err);
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

  // Internal stop signal, aggregating the caller's. When ONE part exhausts its
  // attempts, Promise.all rejects while up to 3 sibling workers are still
  // mid-PUT or mid-backoff — without this they'd keep retrying (with fresh
  // signPart URLs) against an uploadId the abort below already killed, burning
  // up to ~8MB per pointless attempt. Firing this controller kills sibling
  // XHRs immediately (xhr.abort → "Upload aborted" → non-retryable).
  const internal = new AbortController();
  const stop = internal.signal;
  if (signal) {
    if (signal.aborted) internal.abort();
    else signal.addEventListener("abort", () => internal.abort(), { once: true });
  }

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
      if (stop.aborted) throw new Error("Upload aborted");
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
          stop
        );

        parts.push({ partNumber, etag });
        return;
      } catch (err) {
        lastErr = err;
        if (stop.aborted || isAbortError(err) || isTerminalUploadError(err)) throw err;
        // Roll this part's progress back so the bar doesn't lie during retry.
        loadedPerPart[partNumber - 1] = 0;
        reportTotal();
        if (attempt < PART_ATTEMPTS) {
          // Don't burn attempts while provably offline — wait for connectivity.
          await waitForOnline(stop);
          // Capped exponential backoff (1s → 3s → 9s → 27s → 30s) + jitter.
          await sleep(
            Math.min(MAX_RETRY_DELAY_MS, retryBaseDelayMs * 3 ** (attempt - 1)) +
              Math.random() * (retryBaseDelayMs / 2)
          );
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
    // Stop the sibling workers FIRST (kills their in-flight XHRs), then free
    // the stored parts server-side. Promise.all has already subscribed to every
    // worker, so the siblings' knock-on "Upload aborted" rejections are handled
    // and the ORIGINAL error (the first rejection) is what we rethrow.
    internal.abort();
    try {
      await api.abort({ key: initiate.key, uploadId: initiate.uploadId });
    } catch {}
    throw err;
  }

  // 4. Complete — retried like parts: this ONE call converts 30-90 minutes of
  // transferred bytes into a Media row; a transient blip here must not discard
  // the whole upload. On definitive failure, best-effort abort so S3 frees the
  // parts (if a prior attempt DID complete server-side and only the response
  // was lost, the retry surfaces the server's error and the abort is a
  // harmless no-op — the server already swallows S3 abort errors).
  let result: CompleteResult | undefined;
  let completeErr: unknown;
  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt++) {
    if (stop.aborted) {
      completeErr = new Error("Upload aborted");
      break;
    }
    try {
      result = await api.complete({
        key: initiate.key,
        uploadId: initiate.uploadId,
        parts,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        category,
      });
      break;
    } catch (err) {
      completeErr = err;
      if (stop.aborted || isAbortError(err)) break;
      // Deterministic tRPC rejections (oversize BAD_REQUEST, org-scope
      // FORBIDDEN) can't succeed on retry — don't burn ~5.7 min re-asking.
      const trpcCode = (err as { data?: { code?: string } })?.data?.code;
      if (trpcCode === "BAD_REQUEST" || trpcCode === "FORBIDDEN") break;
      if (attempt < COMPLETE_ATTEMPTS) {
        await waitForOnline(stop);
        // ~5.7 min total window (1+3+9+27+60×5) — rides out a deploy.
        await sleep(
          Math.min(COMPLETE_MAX_RETRY_DELAY_MS * (retryBaseDelayMs / DEFAULT_RETRY_BASE_DELAY_MS), retryBaseDelayMs * 3 ** (attempt - 1)) +
            Math.random() * (retryBaseDelayMs / 2)
        );
      }
    }
  }
  if (!result) {
    try {
      await api.abort({ key: initiate.key, uploadId: initiate.uploadId });
    } catch {}
    throw completeErr;
  }

  onProgress?.(100);
  return result;
}
