"use client";

import { useState, useEffect } from "react";
import type { Canvas } from "fabric";
import * as fabric from "fabric";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { FlipHorizontal, FlipVertical } from "lucide-react";

interface ImageToolbarProps {
  canvas: Canvas | null;
  object: any;
}

const FILTER_PRESETS = [
  { name: "None", filters: [] },
  { name: "B&W", filters: [new fabric.filters.Grayscale()] },
  { name: "Sepia", filters: [new fabric.filters.Sepia()] },
  { name: "Vintage", filters: [new fabric.filters.Sepia(), new fabric.filters.Brightness({ brightness: -0.1 })] },
  { name: "Vivid", filters: [new fabric.filters.Saturation({ saturation: 0.5 })] },
  { name: "Warm", filters: [new fabric.filters.Brightness({ brightness: 0.05 }), new fabric.filters.Saturation({ saturation: 0.2 })] },
  { name: "Cool", filters: [new fabric.filters.Brightness({ brightness: -0.05 }), new fabric.filters.Saturation({ saturation: -0.1 })] },
  { name: "Dramatic", filters: [new fabric.filters.Contrast({ contrast: 0.3 }), new fabric.filters.Brightness({ brightness: -0.1 })] },
];

export function ImageToolbar({ canvas, object }: ImageToolbarProps) {
  const [opacity, setOpacity] = useState((object?.opacity ?? 1) * 100);

  useEffect(() => {
    if (object) setOpacity((object.opacity ?? 1) * 100);
  }, [object]);

  const applyFilter = (filters: any[]) => {
    if (!canvas || !object || object.type !== "image") return;
    object.filters = filters;
    object.applyFilters();
    canvas.renderAll();
  };

  const flip = (direction: "x" | "y") => {
    if (!canvas || !object) return;
    if (direction === "x") object.set("flipX", !object.flipX);
    if (direction === "y") object.set("flipY", !object.flipY);
    canvas.renderAll();
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <Label className="text-[10px]">Filter</Label>
        <select
          onChange={(e) => {
            const preset = FILTER_PRESETS.find((f) => f.name === e.target.value);
            if (preset) applyFilter(preset.filters);
          }}
          className="h-7 rounded border bg-background px-1.5 text-xs"
          defaultValue="None"
        >
          {FILTER_PRESETS.map((f) => (
            <option key={f.name} value={f.name}>{f.name}</option>
          ))}
        </select>
      </div>

      <div className="mx-1 h-5 w-px bg-border" />

      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => flip("x")} title="Flip horizontal">
        <FlipHorizontal className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => flip("y")} title="Flip vertical">
        <FlipVertical className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-1 h-5 w-px bg-border" />

      <div className="flex items-center gap-1">
        <Label className="text-[10px]">Opacity</Label>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOpacity(v);
            if (canvas && object) {
              object.set("opacity", v / 100);
              canvas.renderAll();
            }
          }}
          className="w-20"
        />
        <span className="text-[10px] text-muted-foreground">{Math.round(opacity)}%</span>
      </div>
    </div>
  );
}
