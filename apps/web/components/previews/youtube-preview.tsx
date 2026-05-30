"use client";

import { Card, CardContent } from "~/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";
import { Play, ThumbsUp, ThumbsDown, Share2, Bookmark, MoreHorizontal, AlertCircle } from "lucide-react";
import type { PostPreviewProps } from "./twitter-preview";

function getInitials(name: string): string {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(url) || url.startsWith("blob:") || url.includes("video");
}

export function YouTubePreview({
  content,
  mediaUrls,
  authorName = "Your Channel",
  authorHandle,
  authorAvatar,
  timestamp,
}: PostPreviewProps) {
  const hasMedia = mediaUrls && mediaUrls.length > 0;
  const firstMedia = hasMedia ? mediaUrls[0] : null;
  const isVideo = firstMedia ? isVideoUrl(firstMedia) : false;

  // First line of content is treated as the title (matches the worker which uses
  // payload.metadata?.title || payload.content.slice(0, 100) when publishing)
  const firstNewline = content.indexOf("\n");
  const title = firstNewline > 0 ? content.slice(0, firstNewline) : content.slice(0, 100);
  const description = firstNewline > 0 ? content.slice(firstNewline + 1).trim() : "";

  return (
    <Card className="overflow-hidden border border-zinc-200 dark:border-zinc-700">
      <CardContent className="p-0">
        {/* Video player frame */}
        <div className="relative aspect-video w-full overflow-hidden bg-black">
          {firstMedia && isVideo ? (
            <video
              src={firstMedia}
              className="h-full w-full object-contain"
              controls
              preload="metadata"
            />
          ) : firstMedia ? (
            <div className="relative h-full w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={firstMedia} alt="Preview" className="h-full w-full object-cover opacity-60" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50">
                <AlertCircle className="h-8 w-8 text-yellow-400" />
                <p className="px-4 text-center text-xs font-medium text-white">
                  YouTube requires a video. Images cannot be published.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-zinc-900 text-zinc-500">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600">
                <Play className="h-8 w-8 fill-white text-white" />
              </div>
              <p className="text-xs">Attach a video to preview</p>
            </div>
          )}
        </div>

        {/* Title */}
        <div className="px-3 pt-3">
          <p className="text-sm font-semibold leading-snug text-foreground line-clamp-2">
            {title || <span className="italic text-muted-foreground">Your video title…</span>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Views and timestamp will appear after publishing</p>
        </div>

        {/* Channel row */}
        <div className="flex items-center gap-2 px-3 pt-3">
          <Avatar className="h-9 w-9 flex-shrink-0">
            {authorAvatar ? <AvatarImage src={authorAvatar} alt={authorName} /> : null}
            <AvatarFallback className="bg-zinc-100 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {getInitials(authorName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{authorName}</p>
            {authorHandle && <p className="truncate text-xs text-muted-foreground">@{authorHandle}</p>}
          </div>
          <button className="rounded-full bg-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-900 dark:bg-zinc-100 dark:text-zinc-900">
            Subscribe
          </button>
        </div>

        {/* Action row */}
        <div className="flex items-center gap-2 px-3 pt-3 text-muted-foreground">
          <div className="flex items-center gap-0 rounded-full bg-muted">
            <button className="flex items-center gap-1.5 rounded-l-full px-3 py-1.5 text-xs hover:bg-muted/60">
              <ThumbsUp className="h-3.5 w-3.5" />
              <span>—</span>
            </button>
            <div className="h-4 w-px bg-border" />
            <button className="rounded-r-full px-3 py-1.5 hover:bg-muted/60">
              <ThumbsDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <button className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs hover:bg-muted/60">
            <Share2 className="h-3.5 w-3.5" />
            Share
          </button>
          <button className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs hover:bg-muted/60">
            <Bookmark className="h-3.5 w-3.5" />
            Save
          </button>
          <button className="ml-auto rounded-full p-2 hover:bg-muted/60">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>

        {/* Description */}
        {description && (
          <div className="m-3 rounded-lg bg-muted/50 p-3">
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{description}</p>
          </div>
        )}
        {!description && content && (
          <p className="m-3 text-xs italic text-muted-foreground">
            Tip: first line becomes the video title, the rest becomes the description.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
