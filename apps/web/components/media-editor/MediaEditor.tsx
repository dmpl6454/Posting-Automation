"use client";

import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Check, X, Save, Loader2 } from "lucide-react";
import { useToast } from "~/hooks/use-toast";
import { FabricCanvas } from "./FabricCanvas";
import { BottomBar } from "./BottomBar";
import { useFabricCanvas, CANVAS_PRESETS } from "./hooks/useFabricCanvas";
import { useEditorHistory } from "./hooks/useEditorHistory";
import { useCanvasExport } from "./hooks/useCanvasExport";
import { EditorSidebar, type SidebarPanel } from "./EditorSidebar";
import { ElementsPanel } from "./panels/ElementsPanel";
import { TextPanel } from "./panels/TextPanel";
import { UploadsPanel } from "./panels/UploadsPanel";
import { DrawPanel } from "./panels/DrawPanel";
import { AIPanel } from "./panels/AIPanel";
import { EditorToolbar } from "./toolbars/EditorToolbar";

interface MediaEditorProps {
  initialImage?: string;
  onApply: (blobUrl: string) => void;
  onSaveToLibrary?: (dataUrl: string) => void;
  onCancel: () => void;
  onPreviewUpdate?: (thumbnailUrl: string) => void;
}

export function MediaEditor({
  initialImage,
  onApply,
  onSaveToLibrary,
  onCancel,
  onPreviewUpdate,
}: MediaEditorProps) {
  const { toast } = useToast();
  const [isDirty, setIsDirty] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [activePanel, setActivePanel] = useState<SidebarPanel>(null);

  const {
    canvasRef,
    canvas,
    isReady,
    canvasSize,
    zoom,
    selectedObject,
    resizeCanvas,
    setCanvasZoom,
    exportCanvas,
  } = useFabricCanvas({ initialImage, initialSize: CANVAS_PRESETS[0] });

  const { undo, redo, canUndo, canRedo } = useEditorHistory(canvas);
  const { exportBlobUrl, exportPreviewThumbnail } = useCanvasExport(canvas);

  useEffect(() => {
    if (!canvas) return;
    const markDirty = () => setIsDirty(true);
    canvas.on("object:modified", markDirty);
    canvas.on("object:added", markDirty);
    canvas.on("object:removed", markDirty);
    return () => {
      canvas.off("object:modified", markDirty);
      canvas.off("object:added", markDirty);
      canvas.off("object:removed", markDirty);
    };
  }, [canvas]);

  useEffect(() => {
    if (!canvas || !onPreviewUpdate) return;
    const updatePreview = () => exportPreviewThumbnail(onPreviewUpdate);
    canvas.on("object:modified", updatePreview);
    canvas.on("object:added", updatePreview);
    canvas.on("object:removed", updatePreview);
    updatePreview();
    return () => {
      canvas.off("object:modified", updatePreview);
      canvas.off("object:added", updatePreview);
      canvas.off("object:removed", updatePreview);
    };
  }, [canvas, onPreviewUpdate, exportPreviewThumbnail]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (canvas && canvas.getActiveObject()) {
          canvas.remove(canvas.getActiveObject()!);
          canvas.renderAll();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canvas, undo, redo]);

  const handleApply = async () => {
    setIsExporting(true);
    try {
      const blobUrl = await exportBlobUrl("png");
      onApply(blobUrl);
      toast({ title: "Applied to post" });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
    setIsExporting(false);
  };

  const handleCancel = () => {
    if (isDirty) {
      if (!confirm("You have unsaved changes. Discard?")) return;
    }
    onCancel();
  };

  return (
    <div className="flex h-[calc(100vh-200px)] min-h-[500px] flex-col overflow-hidden rounded-xl border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <h3 className="text-sm font-semibold">Design Editor</h3>
        <div className="flex items-center gap-2">
          {onSaveToLibrary && (
            <Button variant="outline" size="sm" onClick={() => onSaveToLibrary(exportCanvas("png"))}>
              <Save className="mr-1.5 h-3.5 w-3.5" />
              Save to Library
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button size="sm" onClick={handleApply} disabled={isExporting}>
            {isExporting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            )}
            Apply to Post
          </Button>
        </div>
      </div>

      {/* Contextual Toolbar */}
      <EditorToolbar
        canvas={canvas}
        selectedObject={selectedObject}
        canvasSize={canvasSize}
        onResizeCanvas={resizeCanvas}
      />

      <div className="flex flex-1 overflow-hidden">
        <EditorSidebar activePanel={activePanel} onPanelChange={setActivePanel}>
          {activePanel === "elements" && <ElementsPanel canvas={canvas} />}
          {activePanel === "text" && <TextPanel canvas={canvas} />}
          {activePanel === "uploads" && <UploadsPanel canvas={canvas} />}
          {activePanel === "draw" && <DrawPanel canvas={canvas} />}
          {activePanel === "ai" && <AIPanel canvas={canvas} exportCanvasDataUrl={exportCanvas} />}
          {activePanel === "templates" && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              Templates coming soon
            </div>
          )}
        </EditorSidebar>

        <FabricCanvas
          canvasRef={canvasRef}
          zoom={zoom}
          canvasWidth={canvasSize.width}
          canvasHeight={canvasSize.height}
        />
      </div>

      <BottomBar
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        zoom={zoom}
        onZoomChange={setCanvasZoom}
      />
    </div>
  );
}
