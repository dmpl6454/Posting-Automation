"use client";

import { Card, CardContent } from "~/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import {
  MessageCircle,
  Repeat2,
  Heart,
  Bookmark,
  Share2,
  AlertCircle,
  CheckCircle2,
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

const TWITTER_CHAR_LIMIT = 280;

function formatTimestamp(date?: Date): string {
  if (!date) return "Just now";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function TwitterPreview({
  content,
  mediaUrls,
  authorName = "Your Name",
  authorHandle = "yourhandle",
  authorAvatar,
  timestamp,
}: PostPreviewProps) {
  const charCount = content.length;
  const isOverLimit = charCount > TWITTER_CHAR_LIMIT;

  return (
    <Card className="overflow-hidden border border-zinc-200 dark:border-zinc-800">
      <CardContent className="p-4">
        {/* Character limit warning */}
        {charCount > 0 && (
          <div className="mb-3 flex items-center justify-between text-xs">
            {isOverLimit ? (
              <Badge variant="destructive" className="gap-1">
                <AlertCircle className="h-3 w-3" />
                {charCount - TWITTER_CHAR_LIMIT} characters over limit
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                {TWITTER_CHAR_LIMIT - charCount} characters remaining
              </Badge>
            )}
          </div>
        )}

        {/* Post header */}
        <div className="flex gap-3">
          <Avatar className="h-10 w-10 flex-shrink-0">
            {authorAvatar ? (
              <AvatarImage src={authorAvatar} alt={authorName} />
            ) : null}
            <AvatarFallback className="bg-sky-100 text-sky-700 text-xs dark:bg-sky-900 dark:text-sky-300">
              {getInitials(authorName)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            {/* Name row */}
            <div className="flex items-center gap-1">
              <span className="truncate text-sm font-bold text-foreground">
                {authorName}
              </span>
              <svg
                viewBox="0 0 22 22"
                className="h-4 w-4 flex-shrink-0 text-sky-500"
                fill="currentColor"
              >
                <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.855-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.69-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.636.433 1.221.878 1.69.47.446 1.055.752 1.69.883.635.13 1.294.083 1.902-.143.271.586.702 1.084 1.24 1.438.54.354 1.167.551 1.813.568.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.225 1.261.272 1.893.143.636-.131 1.222-.437 1.69-.883.445-.47.751-1.054.882-1.69.132-.633.084-1.29-.139-1.896.587-.273 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
              </svg>
              <span className="truncate text-sm text-muted-foreground">
                @{authorHandle}
              </span>
              <span className="text-sm text-muted-foreground">·</span>
              <span className="flex-shrink-0 text-sm text-muted-foreground">
                {formatTimestamp(timestamp)}
              </span>
              <div className="ml-auto flex-shrink-0">
                <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            {/* Post content */}
            <div className="mt-1">
              <p className="whitespace-pre-wrap text-[15px] leading-5 text-foreground">
                {content || (
                  <span className="italic text-muted-foreground">
                    Your post content will appear here...
                  </span>
                )}
              </p>
            </div>

            {/* Media grid */}
            {mediaUrls && mediaUrls.length > 0 && (
              <div
                className={`mt-3 grid gap-0.5 overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-700 ${
                  mediaUrls.length === 1
                    ? "grid-cols-1"
                    : mediaUrls.length === 2
                    ? "grid-cols-2"
                    : mediaUrls.length === 3
                    ? "grid-cols-2"
                    : "grid-cols-2"
                }`}
              >
                {mediaUrls.slice(0, 4).map((url, i) => (
                  <div
                    key={i}
                    className={`relative bg-zinc-100 dark:bg-zinc-800 ${
                      mediaUrls.length === 1
                        ? "aspect-video"
                        : mediaUrls.length === 3 && i === 0
                        ? "row-span-2 aspect-square"
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

            {/* Engagement row */}
            <div className="mt-3 flex max-w-md items-center justify-between">
              <button className="group flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-sky-500">
                <div className="rounded-full p-1.5 group-hover:bg-sky-500/10">
                  <MessageCircle className="h-4 w-4" />
                </div>
                <span className="text-xs">12</span>
              </button>
              <button className="group flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-green-500">
                <div className="rounded-full p-1.5 group-hover:bg-green-500/10">
                  <Repeat2 className="h-4 w-4" />
                </div>
                <span className="text-xs">5</span>
              </button>
              <button className="group flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-pink-500">
                <div className="rounded-full p-1.5 group-hover:bg-pink-500/10">
                  <Heart className="h-4 w-4" />
                </div>
                <span className="text-xs">48</span>
              </button>
              <button className="group flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-sky-500">
                <div className="rounded-full p-1.5 group-hover:bg-sky-500/10">
                  <Bookmark className="h-4 w-4" />
                </div>
              </button>
              <button className="group flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-sky-500">
                <div className="rounded-full p-1.5 group-hover:bg-sky-500/10">
                  <Share2 className="h-4 w-4" />
                </div>
              </button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
