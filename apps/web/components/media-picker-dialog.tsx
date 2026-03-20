"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ImageIcon, Film, Check } from "lucide-react";

interface MediaPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (url: string, fileName: string, mediaId?: string) => void;
  title?: string;
}

export function MediaPickerDialog({
  open,
  onOpenChange,
  onSelect,
  title = "Choose from Media Library",
}: MediaPickerDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string>("");
  const [selectedName, setSelectedName] = useState<string>("");
  const [mediaType, setMediaType] = useState<"all" | "image" | "video">("all");

  const { data, isLoading } = trpc.media.list.useQuery(
    { limit: 50, type: mediaType },
    { enabled: open }
  );

  const items = data?.items ?? [];

  const handleConfirm = () => {
    if (selectedUrl) {
      onSelect(selectedUrl, selectedName, selectedId ?? undefined);
      onOpenChange(false);
      setSelectedId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {/* Type filter tabs */}
        <div className="flex gap-1 border-b pb-2">
          {(["all", "image", "video"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setMediaType(t); setSelectedId(null); }}
              className={`rounded px-3 py-1 text-sm capitalize transition-colors ${
                mediaType === t
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {t === "all" ? "All" : t === "image" ? "Images" : "Videos"}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ImageIcon className="mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No {mediaType === "all" ? "media" : mediaType + "s"} in your library yet.
            </p>
          </div>
        ) : (
          <div className="grid max-h-[400px] grid-cols-4 gap-2 overflow-y-auto pr-1">
            {items.map((item) => {
              const isVideo = item.fileType?.startsWith("video/");
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setSelectedId(item.id);
                    setSelectedUrl(item.url);
                    setSelectedName(item.fileName);
                  }}
                  className={`group relative aspect-square overflow-hidden rounded-lg border-2 transition-all ${
                    selectedId === item.id
                      ? "border-primary ring-2 ring-primary/30"
                      : "border-transparent hover:border-muted-foreground/30"
                  }`}
                >
                  {isVideo ? (
                    <div className="relative h-full w-full bg-black">
                      <video
                        src={item.url}
                        className="h-full w-full object-cover"
                        preload="metadata"
                        muted
                        playsInline
                      />
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <div className="rounded-full bg-black/50 p-1.5">
                          <Film className="h-4 w-4 text-white" />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <img
                      src={item.thumbnailUrl || item.url}
                      alt={item.fileName}
                      className="h-full w-full object-cover"
                    />
                  )}
                  {selectedId === item.id && (
                    <div className="absolute inset-0 flex items-center justify-center bg-primary/20">
                      <div className="rounded-full bg-primary p-1">
                        <Check className="h-4 w-4 text-primary-foreground" />
                      </div>
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <p className="truncate text-[10px] text-white">{item.fileName}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedId}>
            Select
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
