"use client";

import { Card, CardContent } from "~/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";
import {
  ThumbsUp,
  MessageCircle,
  Share2,
  Globe,
  MoreHorizontal,
} from "lucide-react";

export interface PostPreviewProps {
  content: string;
  mediaUrls?: string[];
  authorName?: string;
  authorHandle?: string;
  authorAvatar?: string;
  timestamp?: Date;
}

function formatTimestamp(date?: Date): string {
  if (!date) return "Just now";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function FacebookPreview({
  content,
  mediaUrls,
  authorName = "Your Name",
  authorAvatar,
  timestamp,
}: PostPreviewProps) {
  return (
    <Card className="overflow-hidden border border-zinc-200 dark:border-zinc-700">
      <CardContent className="p-0">
        {/* Post header */}
        <div className="flex items-start gap-2.5 px-4 pt-3">
          <Avatar className="h-10 w-10 flex-shrink-0">
            {authorAvatar ? (
              <AvatarImage src={authorAvatar} alt={authorName} />
            ) : null}
            <AvatarFallback className="bg-blue-100 text-sm text-blue-600 dark:bg-blue-900 dark:text-blue-300">
              {getInitials(authorName)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {authorName}
            </p>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>{formatTimestamp(timestamp)}</span>
              <span>·</span>
              <Globe className="h-3 w-3" />
            </div>
          </div>

          <MoreHorizontal className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
        </div>

        {/* Post content */}
        <div className="px-4 pb-2 pt-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {content || (
              <span className="italic text-muted-foreground">
                Your post content will appear here...
              </span>
            )}
          </p>
        </div>

        {/* Media */}
        {mediaUrls && mediaUrls.length > 0 && (
          <div className="mt-1">
            {mediaUrls.length === 1 ? (
              <div className="relative aspect-video w-full bg-zinc-100 dark:bg-zinc-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaUrls[0]}
                  alt="Post media"
                  className="h-full w-full object-cover"
                />
              </div>
            ) : mediaUrls.length === 2 ? (
              <div className="grid grid-cols-2 gap-0.5">
                {mediaUrls.map((url, i) => (
                  <div
                    key={i}
                    className="relative aspect-square bg-zinc-100 dark:bg-zinc-800"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`Media ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-0.5">
                {mediaUrls.slice(0, 4).map((url, i) => (
                  <div
                    key={i}
                    className={`relative bg-zinc-100 dark:bg-zinc-800 ${
                      mediaUrls.length === 3 && i === 0
                        ? "col-span-2 aspect-video"
                        : "aspect-square"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`Media ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
                    {i === 3 && mediaUrls.length > 4 && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <span className="text-xl font-bold text-white">
                          +{mediaUrls.length - 4}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Reactions summary */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-700">
          <div className="flex items-center gap-1.5">
            <div className="flex -space-x-1">
              <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-blue-500 ring-2 ring-white dark:ring-zinc-900">
                <ThumbsUp
                  className="h-2.5 w-2.5 text-white"
                  fill="white"
                />
              </div>
              <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-red-500 ring-2 ring-white dark:ring-zinc-900">
                <svg
                  viewBox="0 0 16 16"
                  className="h-2.5 w-2.5"
                  fill="white"
                >
                  <path d="M8 14s-5.5-3.5-5.5-8A3.5 3.5 0 0 1 6 2.5c.94 0 1.79.5 2.25 1.25A2.76 2.76 0 0 1 10.5 2.5 3.5 3.5 0 0 1 14 6c0 4.5-6 8-6 8z" />
                </svg>
              </div>
            </div>
            <span className="text-xs text-muted-foreground">24</span>
          </div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>6 comments</span>
            <span>2 shares</span>
          </div>
        </div>

        {/* Engagement row */}
        <div className="grid grid-cols-3 px-2 py-1">
          <button className="flex items-center justify-center gap-2 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <ThumbsUp className="h-4.5 w-4.5" />
            <span className="text-sm font-medium">Like</span>
          </button>
          <button className="flex items-center justify-center gap-2 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <MessageCircle className="h-4.5 w-4.5" />
            <span className="text-sm font-medium">Comment</span>
          </button>
          <button className="flex items-center justify-center gap-2 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <Share2 className="h-4.5 w-4.5" />
            <span className="text-sm font-medium">Share</span>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
