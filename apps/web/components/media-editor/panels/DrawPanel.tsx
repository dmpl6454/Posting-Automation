"use client";

import { useState, useEffect } from "react";
import { Canvas, PencilBrush } from "fabric";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Input } from "~/components/ui/input";
import { Pencil } from "lucide-react";

interface DrawPanelProps {
  canvas: Canvas | null;
}

export function DrawPanel({ canvas }: DrawPanelProps) {
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(5);
  const [brushColor, setBrushColor] = useState("#000000");

  useEffect(() => {
    if (!canvas) return;
    canvas.isDrawingMode = isDrawing;
    if (isDrawing) {
      const brush = new PencilBrush(canvas);
      brush.width = brushSize;
      brush.color = brushColor;
      canvas.freeDrawingBrush = brush;
    }
    return () => {
      if (canvas) canvas.isDrawingMode = false;
    };
  }, [canvas, isDrawing, brushSize, brushColor]);

  const toggleDrawing = () => {
    setIsDrawing(!isDrawing);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Drawing</h3>

      <Button
        variant={isDrawing ? "default" : "outline"}
        className="w-full gap-2"
        onClick={toggleDrawing}
      >
        <Pencil className="h-4 w-4" />
        {isDrawing ? "Stop Drawing" : "Start Drawing"}
      </Button>

      <div className="space-y-3">
        <div>
          <Label className="text-xs">Brush Size: {brushSize}px</Label>
          <input
            type="range"
            min={1}
            max={50}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="mt-1 w-full"
          />
        </div>

        <div>
          <Label className="text-xs">Brush Color</Label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              value={brushColor}
              onChange={(e) => setBrushColor(e.target.value)}
              className="h-8 w-8 cursor-pointer rounded border"
            />
            <Input
              value={brushColor}
              onChange={(e) => setBrushColor(e.target.value)}
              className="h-8 flex-1 text-xs"
            />
          </div>
        </div>

        {/* Quick Colors */}
        <div className="flex flex-wrap gap-1.5">
          {["#000000", "#FFFFFF", "#EF4444", "#F59E0B", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899"].map(
            (color) => (
              <button
                key={color}
                onClick={() => setBrushColor(color)}
                className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  backgroundColor: color,
                  borderColor: brushColor === color ? "#000" : "transparent",
                }}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
