"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import {
  Upload,
  Trash2,
  Loader2,
  ImageIcon,
  Film,
  Search,
  X,
} from "lucide-react";

const PAGE_SIZE = 40;

export default function MediaPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = trpc.media.list.useInfiniteQuery(
    {
      limit: PAGE_SIZE,
      type: typeFilter,
      ...(debouncedSearch && { search: debouncedSearch }),
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const deleteMedia = trpc.media.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Media deleted" });
    },
  });

  // Infinite scroll with IntersectionObserver
  const observerCallback = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage]
  );

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(observerCallback, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [observerCallback]);

  const allItems = data?.pages.flatMap((p) => p.items) ?? [];

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Media Library</h1>
          <p className="text-muted-foreground">
            Upload and manage your media files
            {allItems.length > 0 && (
              <span className="ml-1">({allItems.length}{hasNextPage ? "+" : ""} files)</span>
            )}
          </p>
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

      {/* Search & Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search files by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-8"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {(["all", "image", "video"] as const).map((t) => (
            <Button
              key={t}
              variant={typeFilter === t ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTypeFilter(t)}
            >
              {t === "all" ? "All" : t === "image" ? "Images" : "Videos"}
            </Button>
          ))}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : allItems.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <ImageIcon className="h-12 w-12 text-muted-foreground/30" />
            <h3 className="mt-4 text-lg font-medium">
              {debouncedSearch ? "No files match your search" : "No media uploaded"}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {debouncedSearch
                ? "Try a different search term"
                : "Upload images and videos for your posts"}
            </p>
            {!debouncedSearch && (
              <Button variant="outline" className="mt-4" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                Upload Files
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {allItems.map((media: any) => (
              <Card key={media.id} className="group overflow-hidden">
                <div className="relative aspect-square w-full overflow-hidden bg-muted">
                  {media.fileType.startsWith("video/") ? (
                    <div className="absolute inset-0 bg-black">
                      <video
                        src={media.url}
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
                      src={media.thumbnailUrl || media.url}
                      alt={media.fileName}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
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
                      {media.fileSize > 1024 * 1024
                        ? `${(media.fileSize / (1024 * 1024)).toFixed(1)} MB`
                        : `${(media.fileSize / 1024).toFixed(0)} KB`}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Infinite scroll trigger */}
          <div ref={loadMoreRef} className="flex justify-center py-4">
            {isFetchingNextPage && (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
            {!hasNextPage && allItems.length > PAGE_SIZE && (
              <p className="text-xs text-muted-foreground">All files loaded</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
