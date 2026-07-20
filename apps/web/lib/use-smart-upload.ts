"use client";

/**
 * Shared upload hook: small files (≤8MB) go through the proxied /api/upload
 * (fast, no CORS prerequisite); anything larger streams browser→S3 via the
 * hardened multipart path (per-part retry, progress, abort) so multi-hundred-MB
 * files never buffer in the web container's memory — the exact branch
 * ComposeTab uses. Adopted by the Media page and both chat paperclips, which
 * previously pushed up to 500MB through the buffering route (web-OOM vector).
 */
import { useCallback } from "react";
import { trpc } from "~/lib/trpc/client";

const MULTIPART_THRESHOLD = 8 * 1024 * 1024;

export interface SmartUploadResult {
  id: string;
  url: string;
  fileName: string;
  fileType: string;
}

export function useSmartUpload() {
  const initiate = trpc.upload.initiate.useMutation();
  const signPart = trpc.upload.signPart.useMutation();
  const complete = trpc.upload.complete.useMutation();
  const abort = trpc.upload.abort.useMutation();

  const uploadFile = useCallback(
    async (
      file: File,
      opts?: { onProgress?: (percent: number) => void; signal?: AbortSignal; category?: string }
    ): Promise<SmartUploadResult> => {
      if (file.size <= MULTIPART_THRESHOLD) {
        const form = new FormData();
        form.append("file", file);
        if (opts?.category) form.append("category", opts.category);
        const res = await fetch("/api/upload", { method: "POST", body: form, signal: opts?.signal });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || "Upload failed");
        }
        const data = (await res.json()) as Partial<SmartUploadResult>;
        return {
          id: data.id!,
          url: data.url ?? "",
          fileName: data.fileName ?? file.name,
          fileType: data.fileType ?? file.type,
        };
      }

      const { uploadFileMultipart } = await import("~/lib/upload-multipart");
      return uploadFileMultipart({
        file,
        category: opts?.category,
        onProgress: opts?.onProgress,
        signal: opts?.signal,
        api: {
          initiate: (input) => initiate.mutateAsync(input),
          signPart: (input) => signPart.mutateAsync(input),
          complete: (input) => complete.mutateAsync(input),
          abort: (input) => abort.mutateAsync(input),
        },
      });
    },
    // mutateAsync handles are stable per mutation instance; the mutation
    // objects themselves are not — intentionally excluded to keep uploadFile
    // referentially useful. eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return { uploadFile };
}
