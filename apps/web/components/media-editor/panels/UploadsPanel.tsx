"use client";

import { useRef } from "react";
import { Canvas, FabricImage } from "fabric";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Upload, Loader2 } from "lucide-react";

interface UploadsPanelProps {
  canvas: Canvas | null;
}

export function UploadsPanel({ canvas }: UploadsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: mediaList, isLoading } = trpc.media.list.useQuery({ limit: 50, type: "image" });

  const addImageToCanvas = async (url: string) => {
    if (!canvas) return;
    try {
      const img = await FabricImage.fromURL(url, { crossOrigin: "anonymous" });
      const maxDim = Math.min(canvas.width || 800, canvas.height || 800) * 0.6;
      const scale = Math.min(maxDim / (img.width || 1), maxDim / (img.height || 1), 1);
      img.set({
        left: 100,
        top: 100,
        scaleX: scale,
        scaleY: scale,
      });
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.renderAll();
    } catch {
      console.error("Failed to load image");
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        addImageToCanvas(reader.result);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Upload</h3>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileUpload}
      />
      <Button
        variant="outline"
        className="w-full gap-2"
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-4 w-4" />
        Upload Image
      </Button>

      <h3 className="text-sm font-semibold">Media Library</h3>
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : mediaList?.items?.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground">No images in library</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {mediaList?.items?.map((media: any) => (
            <button
              key={media.id}
              onClick={() => addImageToCanvas(media.url)}
              className="group relative aspect-square overflow-hidden rounded-md border transition-all hover:ring-2 hover:ring-primary"
            >
              <img
                src={media.thumbnailUrl || media.url}
                alt={media.fileName}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
