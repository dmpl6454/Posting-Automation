"use client";

import { Card, CardContent } from "~/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";
import {
  Heart,
  MessageCircle,
  Send,
  Bookmark,
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
  if (!date) return "JUST NOW";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "JUST NOW";
  if (diffMins < 60) return `${diffMins} MINUTES AGO`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} HOURS AGO`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1 DAY AGO";
  if (diffDays < 7) return `${diffDays} DAYS AGO`;
  return date
    .toLocaleDateString("en-US", { month: "long", day: "numeric" })
    .toUpperCase();
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function InstagramPreview({
  content,
  mediaUrls,
  authorName = "yourname",
  authorHandle = "yourname",
  authorAvatar,
  timestamp,
}: PostPreviewProps) {
  const username = authorHandle || authorName.toLowerCase().replace(/\s+/g, "");

  return (
    <Card className="overflow-hidden border border-zinc-200 dark:border-zinc-800">
      <CardContent className="p-0">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div className="rounded-full bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600 p-[2px]">
            <Avatar className="h-8 w-8 border-2 border-white dark:border-zinc-900">
              {authorAvatar ? (
                <AvatarImage src={authorAvatar} alt={username} />
              ) : null}
              <AvatarFallback className="bg-zinc-100 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {getInitials(authorName)}
              </AvatarFallback>
            </Avatar>
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">
              {username}
            </p>
          </div>

          <MoreHorizontal className="h-5 w-5 flex-shrink-0 text-foreground" />
        </div>

        {/* Image area */}
        <div className="relative aspect-[4/5] w-full bg-zinc-100 dark:bg-zinc-800">
          {mediaUrls && mediaUrls.length > 0 ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaUrls[0]}
                alt="Post media"
                className="h-full w-full object-cover"
              />
              {mediaUrls.length > 1 && (
                <div className="absolute right-3 top-3 rounded-full bg-zinc-900/70 px-2 py-0.5">
                  <span className="text-xs font-medium text-white">
                    1/{mediaUrls.length}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-zinc-300 dark:border-zinc-600">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-8 w-8 text-zinc-400"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
                <p className="text-xs text-muted-foreground">
                  Add an image to preview
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Action icons */}
        <div className="flex items-center justify-between px-3 pt-2.5">
          <div className="flex items-center gap-4">
            <button className="text-foreground transition-colors hover:text-zinc-500">
              <Heart className="h-6 w-6" />
            </button>
            <button className="text-foreground transition-colors hover:text-zinc-500">
              <MessageCircle className="h-6 w-6" />
            </button>
            <button className="text-foreground transition-colors hover:text-zinc-500">
              <Send className="h-6 w-6" />
            </button>
          </div>

          {/* Carousel dots */}
          {mediaUrls && mediaUrls.length > 1 && (
            <div className="flex items-center gap-1">
              {mediaUrls.slice(0, 5).map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 w-1.5 rounded-full ${
                    i === 0
                      ? "bg-blue-500"
                      : "bg-zinc-300 dark:bg-zinc-600"
                  }`}
                />
              ))}
              {mediaUrls.length > 5 && (
                <div className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
              )}
            </div>
          )}

          <button className="text-foreground transition-colors hover:text-zinc-500">
            <Bookmark className="h-6 w-6" />
          </button>
        </div>

        {/* Likes */}
        <div className="px-3 pt-2">
          <p className="text-sm font-semibold text-foreground">128 likes</p>
        </div>

        {/* Caption */}
        <div className="px-3 pb-1 pt-1">
          {content ? (
            <p className="text-sm text-foreground">
              <span className="mr-1 font-semibold">{username}</span>
              <span className="leading-relaxed">{content}</span>
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              Your caption will appear here...
            </p>
          )}
        </div>

        {/* View comments */}
        <div className="px-3 pb-1">
          <p className="text-sm text-muted-foreground">
            View all 14 comments
          </p>
        </div>

        {/* Timestamp */}
        <div className="px-3 pb-3">
          <p className="text-[10px] tracking-wide text-muted-foreground">
            {formatTimestamp(timestamp)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
