"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import type { Canvas } from "fabric";

const MAX_HISTORY = 50;

export function useEditorHistory(canvas: Canvas | null) {
  const historyRef = useRef<string[]>([]);
  const currentIndexRef = useRef(-1);
  const isUndoRedoRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncButtonState = useCallback(() => {
    setCanUndo(currentIndexRef.current > 0);
    setCanRedo(currentIndexRef.current < historyRef.current.length - 1);
  }, []);

  const saveState = useCallback(() => {
    if (!canvas || isUndoRedoRef.current) return;
    const json = JSON.stringify((canvas as any).toJSON(["isPlaceholder", "placeholderKey"]));
    historyRef.current = historyRef.current.slice(0, currentIndexRef.current + 1);
    historyRef.current.push(json);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    } else {
      currentIndexRef.current++;
    }
    syncButtonState();
  }, [canvas, syncButtonState]);

  useEffect(() => {
    if (!canvas) return;
    const handler = () => saveState();
    canvas.on("object:modified", handler);
    canvas.on("object:added", handler);
    canvas.on("object:removed", handler);
    saveState();
    return () => {
      canvas.off("object:modified", handler);
      canvas.off("object:added", handler);
      canvas.off("object:removed", handler);
    };
  }, [canvas, saveState]);

  const undo = useCallback(async () => {
    if (!canvas || currentIndexRef.current <= 0) return;
    isUndoRedoRef.current = true;
    currentIndexRef.current--;
    const json = historyRef.current[currentIndexRef.current];
    if (json) {
      await canvas.loadFromJSON(JSON.parse(json));
      canvas.renderAll();
    }
    isUndoRedoRef.current = false;
    syncButtonState();
  }, [canvas, syncButtonState]);

  const redo = useCallback(async () => {
    if (!canvas || currentIndexRef.current >= historyRef.current.length - 1) return;
    isUndoRedoRef.current = true;
    currentIndexRef.current++;
    const json = historyRef.current[currentIndexRef.current];
    if (json) {
      await canvas.loadFromJSON(JSON.parse(json));
      canvas.renderAll();
    }
    isUndoRedoRef.current = false;
    syncButtonState();
  }, [canvas, syncButtonState]);

  return { undo, redo, canUndo, canRedo, saveState };
}
