"use client";

import { useCallback, useRef } from "react";
import type { Canvas } from "fabric";

const MAX_EXPORT_SIZE = 10 * 1024 * 1024;

/** Convert a data: URL to a Blob without fetch() — immune to CSP connect-src
 *  restrictions and works in every browser. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(header ?? "")?.[1] || "image/png";
  const binary = atob(base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function useCanvasExport(canvas: Canvas | null) {
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const exportDataUrl = useCallback(
    (format: "png" | "jpeg" = "png", quality = 1): string => {
      if (!canvas) return "";
      return canvas.toDataURL({ format, quality, multiplier: 1 });
    },
    [canvas]
  );

  const exportBlobUrl = useCallback(
    async (format: "png" | "jpeg" = "png", quality = 1): Promise<string> => {
      if (!canvas) return "";
      // toDataURL throws SecurityError if the canvas was tainted by a
      // cross-origin image (loaded without crossOrigin:"anonymous") — the
      // caller surfaces that message instead of a blank "Export failed".
      const dataUrl = canvas.toDataURL({ format, quality, multiplier: 1 });
      const blob = dataUrlToBlob(dataUrl);
      if (blob.size > MAX_EXPORT_SIZE && format === "png") {
        const jpgUrl = canvas.toDataURL({ format: "jpeg", quality: 0.8, multiplier: 1 });
        return URL.createObjectURL(dataUrlToBlob(jpgUrl));
      }
      return URL.createObjectURL(blob);
    },
    [canvas]
  );

  const exportPreviewThumbnail = useCallback(
    (callback: (url: string) => void) => {
      if (!canvas) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const url = canvas.toDataURL({ format: "jpeg", quality: 0.5, multiplier: 0.3 });
        callback(url);
      }, 500);
    },
    [canvas]
  );

  const exportTemplateThumbnail = useCallback(
    (): string => {
      if (!canvas) return "";
      const scale = 300 / Math.max(canvas.width || 1, canvas.height || 1);
      return canvas.toDataURL({ format: "jpeg", quality: 0.7, multiplier: scale });
    },
    [canvas]
  );

  return { exportDataUrl, exportBlobUrl, exportPreviewThumbnail, exportTemplateThumbnail };
}
