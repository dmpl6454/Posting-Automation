"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Canvas, FabricImage } from "fabric";

export interface CanvasSize {
  width: number;
  height: number;
  label: string;
}

export const CANVAS_PRESETS: CanvasSize[] = [
  { width: 1080, height: 1080, label: "Instagram (1:1)" },
  { width: 1200, height: 628, label: "Facebook/Twitter (16:9)" },
  { width: 1080, height: 1920, label: "Story (9:16)" },
  { width: 1080, height: 1350, label: "Portrait (4:5)" },
];

interface UseFabricCanvasOptions {
  initialImage?: string;
  initialSize?: CanvasSize;
}

export function useFabricCanvas(options: UseFabricCanvasOptions = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(
    options.initialSize || CANVAS_PRESETS[0]!
  );
  const [zoom, setZoom] = useState(1);
  const [selectedObject, setSelectedObject] = useState<any>(null);

  useEffect(() => {
    if (!canvasRef.current || fabricRef.current) return;

    const canvas = new Canvas(canvasRef.current, {
      width: canvasSize.width,
      height: canvasSize.height,
      backgroundColor: "#ffffff",
      preserveObjectStacking: true,
      selection: true,
    });

    canvas.on("selection:created", (e) => setSelectedObject(e.selected?.[0] ?? null));
    canvas.on("selection:updated", (e) => setSelectedObject(e.selected?.[0] ?? null));
    canvas.on("selection:cleared", () => setSelectedObject(null));

    // Scroll wheel zoom
    canvas.on("mouse:wheel", (opt) => {
      const delta = opt.e.deltaY;
      let newZoom = canvas.getZoom() * (1 - delta / 500);
      newZoom = Math.max(0.25, Math.min(4, newZoom));
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, newZoom);
      setZoom(newZoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });

    fabricRef.current = canvas;
    setIsReady(true);

    if (options.initialImage) {
      FabricImage.fromURL(options.initialImage).then((img) => {
        const scaleX = canvasSize.width / (img.width || 1);
        const scaleY = canvasSize.height / (img.height || 1);
        const scale = Math.min(scaleX, scaleY);
        img.set({
          scaleX: scale,
          scaleY: scale,
          left: (canvasSize.width - (img.width || 0) * scale) / 2,
          top: (canvasSize.height - (img.height || 0) * scale) / 2,
          selectable: true,
        });
        canvas.add(img);
        canvas.renderAll();
      });
    }

    return () => {
      canvas.dispose();
      fabricRef.current = null;
      setIsReady(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resizeCanvas = useCallback((newSize: CanvasSize) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    canvas.setDimensions({ width: newSize.width, height: newSize.height });
    setCanvasSize(newSize);
    canvas.renderAll();
  }, []);

  const setCanvasZoom = useCallback((newZoom: number) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const clampedZoom = Math.max(0.25, Math.min(4, newZoom));
    canvas.setZoom(clampedZoom);
    setZoom(clampedZoom);
    canvas.renderAll();
  }, []);

  const exportCanvas = useCallback((format: "png" | "jpeg" = "png", quality = 1): string => {
    const canvas = fabricRef.current;
    if (!canvas) return "";
    return canvas.toDataURL({ format, quality, multiplier: 1 });
  }, []);

  const toJSON = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return null;
    return canvas.toJSON(["isPlaceholder", "placeholderKey"]);
  }, []);

  const loadJSON = useCallback(async (json: any) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    await canvas.loadFromJSON(json);
    canvas.renderAll();
  }, []);

  return {
    canvasRef,
    canvas: fabricRef.current,
    isReady,
    canvasSize,
    zoom,
    selectedObject,
    resizeCanvas,
    setCanvasZoom,
    exportCanvas,
    toJSON,
    loadJSON,
  };
}
