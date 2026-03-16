"use client";

import type { Canvas } from "fabric";
import { TextToolbar } from "./TextToolbar";
import { ShapeToolbar } from "./ShapeToolbar";
import { ImageToolbar } from "./ImageToolbar";
import { CanvasToolbar } from "./CanvasToolbar";
import type { CanvasSize } from "../hooks/useFabricCanvas";

interface EditorToolbarProps {
  canvas: Canvas | null;
  selectedObject: any;
  canvasSize: CanvasSize;
  onResizeCanvas: (size: CanvasSize) => void;
}

function getObjectType(obj: any): "text" | "shape" | "image" | null {
  if (!obj) return null;
  if (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text") return "text";
  if (obj.type === "image") return "image";
  return "shape";
}

export function EditorToolbar({ canvas, selectedObject, canvasSize, onResizeCanvas }: EditorToolbarProps) {
  const objectType = getObjectType(selectedObject);

  return (
    <div className="flex h-11 items-center gap-2 border-b bg-background px-3 overflow-x-auto">
      {objectType === "text" && <TextToolbar canvas={canvas} object={selectedObject} />}
      {objectType === "shape" && <ShapeToolbar canvas={canvas} object={selectedObject} />}
      {objectType === "image" && <ImageToolbar canvas={canvas} object={selectedObject} />}
      {!objectType && <CanvasToolbar canvas={canvas} canvasSize={canvasSize} onResizeCanvas={onResizeCanvas} />}
    </div>
  );
}
