"use client";

import { useState, useEffect } from "react";
import type { Canvas } from "fabric";
import { Button } from "~/components/ui/button";
import { Eye, EyeOff, Lock, Unlock, Trash2, ChevronUp, ChevronDown, Layers } from "lucide-react";

interface LayerPanelProps {
  canvas: Canvas | null;
  isOpen: boolean;
  onToggle: () => void;
}

export function LayerPanel({ canvas, isOpen, onToggle }: LayerPanelProps) {
  const [objects, setObjects] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    if (!canvas) return;
    const refresh = () => {
      const objs = canvas.getObjects().map((obj, idx) => ({
        index: idx,
        type: obj.type,
        name: obj.type === "i-text" ? (obj as any).text?.slice(0, 20) || "Text" :
              obj.type === "image" ? "Image" :
              obj.type || "Object",
        visible: obj.visible !== false,
        selectable: obj.selectable !== false,
      }));
      setObjects(objs.reverse());
    };
    refresh();
    canvas.on("object:added", refresh);
    canvas.on("object:removed", refresh);
    canvas.on("object:modified", refresh);
    canvas.on("selection:created", (e) => {
      const idx = canvas.getObjects().indexOf(e.selected?.[0]!);
      setSelectedId(idx);
    });
    canvas.on("selection:cleared", () => setSelectedId(null));
    return () => {
      canvas.off("object:added", refresh);
      canvas.off("object:removed", refresh);
      canvas.off("object:modified", refresh);
    };
  }, [canvas]);

  const toggleVisibility = (idx: number) => {
    if (!canvas) return;
    const realIdx = canvas.getObjects().length - 1 - idx;
    const obj = canvas.getObjects()[realIdx];
    if (obj) {
      obj.set("visible", !obj.visible);
      canvas.renderAll();
    }
  };

  const toggleLock = (idx: number) => {
    if (!canvas) return;
    const realIdx = canvas.getObjects().length - 1 - idx;
    const obj = canvas.getObjects()[realIdx];
    if (obj) {
      obj.set("selectable", !obj.selectable);
      obj.set("evented", !obj.evented);
      canvas.renderAll();
    }
  };

  const deleteObject = (idx: number) => {
    if (!canvas) return;
    const realIdx = canvas.getObjects().length - 1 - idx;
    const obj = canvas.getObjects()[realIdx];
    if (obj) {
      canvas.remove(obj);
      canvas.renderAll();
    }
  };

  const moveObject = (idx: number, direction: "up" | "down") => {
    if (!canvas) return;
    const realIdx = canvas.getObjects().length - 1 - idx;
    const obj = canvas.getObjects()[realIdx];
    if (!obj) return;
    if (direction === "up") canvas.bringObjectForward(obj);
    else canvas.sendObjectBackwards(obj);
    canvas.renderAll();
  };

  return (
    <div className="flex flex-col border-l">
      <button
        onClick={onToggle}
        className="flex h-10 items-center gap-2 border-b px-3 text-xs font-medium hover:bg-muted/50"
      >
        <Layers className="h-4 w-4" />
        Layers ({objects.length})
      </button>

      {isOpen && (
        <div className="w-48 overflow-y-auto">
          {objects.length === 0 ? (
            <p className="p-3 text-center text-[10px] text-muted-foreground">No objects</p>
          ) : (
            objects.map((obj, idx) => (
              <div
                key={`${obj.index}-${obj.type}`}
                className={`flex items-center gap-1 border-b px-2 py-1.5 text-[10px] ${
                  selectedId === obj.index ? "bg-primary/10" : "hover:bg-muted/30"
                }`}
              >
                <span className="flex-1 truncate">{obj.name}</span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => toggleVisibility(idx)}>
                  {obj.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => toggleLock(idx)}>
                  {obj.selectable ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveObject(idx, "up")}>
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveObject(idx, "down")}>
                  <ChevronDown className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-5 w-5 text-destructive" onClick={() => deleteObject(idx)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
