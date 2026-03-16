"use client";

import { useCallback, useRef } from "react";
import type { Canvas } from "fabric";

const MAX_EXPORT_SIZE = 10 * 1024 * 1024;

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
      const dataUrl = canvas.toDataURL({ format, quality, multiplier: 1 });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      if (blob.size > MAX_EXPORT_SIZE && format === "png") {
        const jpgUrl = canvas.toDataURL({ format: "jpeg", quality: 0.8, multiplier: 1 });
        const jpgRes = await fetch(jpgUrl);
        const jpgBlob = await jpgRes.blob();
        return URL.createObjectURL(jpgBlob);
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
