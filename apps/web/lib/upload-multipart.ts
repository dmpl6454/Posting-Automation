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
    if (signal) {
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

export async function uploadFileMultipart(params: UploadParams): Promise<CompleteResult> {
  const { file, category, onProgress, signal, api } = params;

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

  const reportTotal = () => {
    if (!onProgress) return;
    const loaded = loadedPerPart.reduce((a, b) => a + b, 0);
    const pct = Math.min(99, Math.floor((loaded / file.size) * 100));
    onProgress(pct);
  };

  const uploadOne = async (partNumber: number): Promise<void> => {
    if (signal?.aborted) throw new Error("Upload aborted");
    const start = (partNumber - 1) * PART_SIZE;
    const end = Math.min(start + PART_SIZE, file.size);
    const blob = file.slice(start, end);

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
