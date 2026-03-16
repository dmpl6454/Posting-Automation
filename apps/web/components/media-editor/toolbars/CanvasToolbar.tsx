"use client";

import { useState } from "react";
import type { Canvas } from "fabric";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { CANVAS_PRESETS, type CanvasSize } from "../hooks/useFabricCanvas";

interface CanvasToolbarProps {
  canvas: Canvas | null;
  canvasSize: CanvasSize;
  onResizeCanvas: (size: CanvasSize) => void;
}

export function CanvasToolbar({ canvas, canvasSize, onResizeCanvas }: CanvasToolbarProps) {
  const [bgColor, setBgColor] = useState("#ffffff");

  const updateBackground = (color: string) => {
    if (!canvas) return;
    setBgColor(color);
    canvas.backgroundColor = color;
    canvas.renderAll();
  };

  return (
    <div className="flex items-center gap-2">
      <Label className="text-[10px]">Size</Label>
      <select
        value={canvasSize.label}
        onChange={(e) => {
          const preset = CANVAS_PRESETS.find((p) => p.label === e.target.value);
          if (preset) onResizeCanvas(preset);
        }}
        className="h-7 rounded border bg-background px-1.5 text-xs"
      >
        {CANVAS_PRESETS.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label} ({p.width}x{p.height})
          </option>
        ))}
      </select>

      <div className="mx-1 h-5 w-px bg-border" />

      <Label className="text-[10px]">Background</Label>
      <input
        type="color"
        value={bgColor}
        onChange={(e) => updateBackground(e.target.value)}
        className="h-7 w-7 cursor-pointer rounded border"
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-[10px]"
        onClick={() => updateBackground("transparent")}
      >
        Transparent
      </Button>
    </div>
  );
}
