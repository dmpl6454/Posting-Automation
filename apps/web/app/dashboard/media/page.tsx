"use client";

import { useRef, useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import { ImageIcon, Upload, Trash2, Loader2 } from "lucide-react";

export default function MediaPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const { data, isLoading, refetch } = trpc.media.list.useQuery({ limit: 20 });
  const deleteMedia = trpc.media.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Media deleted" });
    },
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setIsUploading(true);
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          toast({ title: "Upload failed", description: err.error, variant: "destructive" });
        } else {
          toast({ title: `Uploaded ${file.name}` });
        }
      } catch {
        toast({ title: "Upload failed", variant: "destructive" });
      }
    }
    setIsUploading(false);
    refetch();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Media Library</h1>
          <p className="text-muted-foreground">Upload and manage your media files</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,video/*"
          multiple
          onChange={handleUpload}
        />
        <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
          {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
          {isUploading ? "Uploading..." : "Upload"}
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : data?.items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <ImageIcon className="h-12 w-12 text-muted-foreground/30" />
            <h3 className="mt-4 text-lg font-medium">No media uploaded</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload images and videos for your posts
            </p>
            <Button variant="outline" className="mt-4" onClick={() => fileInputRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />
              Upload Files
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {data?.items.map((media: any) => (
            <Card key={media.id} className="group overflow-hidden">
              <div className="relative aspect-square bg-muted">
                {media.fileType.startsWith("image/") ? (
                  <img
                    src={media.thumbnailUrl || media.url}
                    alt={media.fileName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <ImageIcon className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
                <Button
                  variant="destructive"
                  size="icon"
                  className="absolute right-2 top-2 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => deleteMedia.mutate({ id: media.id })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <CardContent className="p-3">
                <p className="truncate text-sm font-medium">{media.fileName}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {media.fileType.split("/")[1]?.toUpperCase()}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {(media.fileSize / 1024).toFixed(0)} KB
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
