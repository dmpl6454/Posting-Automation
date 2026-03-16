"use client";

import { useState } from "react";
import { Canvas, FabricImage } from "fabric";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { useToast } from "~/hooks/use-toast";
import { Sparkles, Eraser, Loader2 } from "lucide-react";

interface AIPanelProps {
  canvas: Canvas | null;
  exportCanvasDataUrl: (format?: "png" | "jpeg") => string;
}

const STYLE_PRESETS = [
  { label: "Watercolor", prompt: "Transform this image into a watercolor painting style" },
  { label: "Oil Painting", prompt: "Transform this image into an oil painting style" },
  { label: "Pencil Sketch", prompt: "Transform this image into a pencil sketch" },
  { label: "Comic", prompt: "Transform this image into a comic book style" },
  { label: "Pop Art", prompt: "Transform this image into pop art style like Andy Warhol" },
  { label: "Vintage", prompt: "Apply a vintage retro film photography look to this image" },
];

export function AIPanel({ canvas, exportCanvasDataUrl }: AIPanelProps) {
  const { toast } = useToast();
  const [editPrompt, setEditPrompt] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const editImage = trpc.image.edit.useMutation();

  const applyAIEdit = async (prompt: string) => {
    if (!canvas) return;
    setIsProcessing(true);
    try {
      const dataUrl = exportCanvasDataUrl("png");
      const base64 = dataUrl.split(",")[1];
      if (!base64) throw new Error("Failed to export canvas");

      const result = await editImage.mutateAsync({
        imageBase64: base64,
        prompt,
      });

      const imageUrl = `data:${result.mimeType || "image/png"};base64,${result.imageBase64}`;
      const img = await FabricImage.fromURL(imageUrl);
      img.set({
        left: 0,
        top: 0,
        scaleX: (canvas.width || 1) / (img.width || 1),
        scaleY: (canvas.height || 1) / (img.height || 1),
      });
      canvas.add(img);
      canvas.renderAll();
      toast({ title: "AI edit applied" });
    } catch (err: any) {
      toast({
        title: "AI edit failed",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    }
    setIsProcessing(false);
    setEditPrompt("");
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">AI Tools</h3>

      {/* AI Edit Prompt */}
      <div className="space-y-2">
        <Textarea
          value={editPrompt}
          onChange={(e) => setEditPrompt(e.target.value)}
          placeholder='Describe what to change... e.g., "Remove background", "Add sunset sky"'
          className="min-h-[80px] resize-none text-sm"
          disabled={isProcessing}
        />
        <Button
          className="w-full gap-2"
          onClick={() => applyAIEdit(editPrompt)}
          disabled={!editPrompt.trim() || isProcessing}
        >
          {isProcessing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {isProcessing ? "Processing..." : "Apply AI Edit"}
        </Button>
      </div>

      {/* Quick Actions */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Quick Actions</h4>
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => applyAIEdit("Remove the background completely, make it transparent")}
          disabled={isProcessing}
        >
          <Eraser className="h-3.5 w-3.5" />
          Remove Background
        </Button>
      </div>

      {/* Style Transfer */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Style Transfer</h4>
        <div className="grid grid-cols-2 gap-1.5">
          {STYLE_PRESETS.map((style) => (
            <Button
              key={style.label}
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => applyAIEdit(style.prompt)}
              disabled={isProcessing}
            >
              {style.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
