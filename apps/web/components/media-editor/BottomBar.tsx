"use client";

import { Button } from "~/components/ui/button";
import { Undo2, Redo2, ZoomIn, ZoomOut } from "lucide-react";

interface BottomBarProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

export function BottomBar({ canUndo, canRedo, onUndo, onRedo, zoom, onZoomChange }: BottomBarProps) {
  return (
    <div className="flex h-10 items-center justify-between border-t bg-background px-3">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
          <Redo2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoomChange(zoom - 0.1)} disabled={zoom <= 0.25}>
          <ZoomOut className="h-4 w-4" />
        </Button>
        <span className="min-w-[4ch] text-center text-xs text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoomChange(zoom + 0.1)} disabled={zoom >= 4}>
          <ZoomIn className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
