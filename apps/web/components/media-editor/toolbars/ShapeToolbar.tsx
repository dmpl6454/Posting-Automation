"use client";

import { useState, useEffect } from "react";
import type { Canvas } from "fabric";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

interface ShapeToolbarProps {
  canvas: Canvas | null;
  object: any;
}

export function ShapeToolbar({ canvas, object }: ShapeToolbarProps) {
  const [fill, setFill] = useState(object?.fill || "#4F46E5");
  const [stroke, setStroke] = useState(object?.stroke || "#000000");
  const [strokeWidth, setStrokeWidth] = useState(object?.strokeWidth || 2);
  const [opacity, setOpacity] = useState((object?.opacity ?? 1) * 100);

  useEffect(() => {
    if (!object) return;
    setFill(typeof object.fill === "string" ? object.fill : "#4F46E5");
    setStroke(object.stroke || "#000000");
    setStrokeWidth(object.strokeWidth || 0);
    setOpacity((object.opacity ?? 1) * 100);
  }, [object]);

  const update = (prop: string, value: any) => {
    if (!canvas || !object) return;
    object.set(prop, value);
    canvas.renderAll();
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <Label className="text-[10px]">Fill</Label>
        <input
          type="color"
          value={fill}
          onChange={(e) => { setFill(e.target.value); update("fill", e.target.value); }}
          className="h-7 w-7 cursor-pointer rounded border"
        />
      </div>

      <div className="flex items-center gap-1">
        <Label className="text-[10px]">Border</Label>
        <input
          type="color"
          value={stroke}
          onChange={(e) => { setStroke(e.target.value); update("stroke", e.target.value); }}
          className="h-7 w-7 cursor-pointer rounded border"
        />
      </div>

      <div className="flex items-center gap-1">
        <Label className="text-[10px]">Width</Label>
        <Input
          type="number"
          value={strokeWidth}
          onChange={(e) => { const v = Number(e.target.value); setStrokeWidth(v); update("strokeWidth", v); }}
          className="h-7 w-14 text-xs"
          min={0}
          max={20}
        />
      </div>

      <div className="flex items-center gap-1">
        <Label className="text-[10px]">Opacity</Label>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={(e) => { const v = Number(e.target.value); setOpacity(v); update("opacity", v / 100); }}
          className="w-20"
        />
        <span className="text-[10px] text-muted-foreground">{Math.round(opacity)}%</span>
      </div>
    </div>
  );
}
