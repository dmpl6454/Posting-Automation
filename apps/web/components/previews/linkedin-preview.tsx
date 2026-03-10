"use client";

import { Card, CardContent } from "~/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import {
  ThumbsUp,
  MessageCircle,
  Repeat2,
  Send,
  Globe,
  MoreHorizontal,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";

export interface PostPreviewProps {
  content: string;
  mediaUrls?: string[];
  authorName?: string;
  authorHandle?: string;
  authorAvatar?: string;
  timestamp?: Date;
}

const LINKEDIN_CHAR_LIMIT = 3000;

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
  return `${Math.floor(diffDays / 7)}w`;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function LinkedInPreview({
  content,
  mediaUrls,
  authorName = "Your Name",
  authorHandle = "Your Headline",
  authorAvatar,
  timestamp,
}: PostPreviewProps) {
  const charCount = content.length;
  const isOverLimit = charCount > LINKEDIN_CHAR_LIMIT;

  return (
    <Card className="overflow-hidden border border-zinc-200 dark:border-zinc-700">
      <CardContent className="p-0">
        {/* Character limit warning */}
        {charCount > 0 && (
          <div className="flex items-center justify-between px-4 pt-3 text-xs">
            {isOverLimit ? (
              <Badge variant="destructive" className="gap-1">
                <AlertCircle className="h-3 w-3" />
                {charCount - LINKEDIN_CHAR_LIMIT} characters over limit
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                {LINKEDIN_CHAR_LIMIT - charCount} remaining
              </Badge>
            )}
          </div>
        )}

        {/* Post header */}
        <div className="flex items-start gap-2 px-4 pt-3">
          <Avatar className="h-12 w-12 flex-shrink-0">
            {authorAvatar ? (
              <AvatarImage src={authorAvatar} alt={authorName} />
            ) : null}
            <AvatarFallback className="bg-blue-100 text-sm text-blue-700 dark:bg-blue-900 dark:text-blue-300">
              {getInitials(authorName)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {authorName}
                </p>
                <p className="text-xs text-muted-foreground line-clamp-1">
                  {authorHandle}
                </p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span>{formatTimestamp(timestamp)}</span>
                  <span>·</span>
                  <Globe className="h-3 w-3" />
                </div>
              </div>
              <MoreHorizontal className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
            </div>
          </div>
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
            ) : (
              <div className="grid grid-cols-2 gap-0.5">
                {mediaUrls.slice(0, 4).map((url, i) => (
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
                    {i === 3 && mediaUrls.length > 4 && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <span className="text-lg font-bold text-white">
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

        {/* Reaction bar */}
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-1.5 dark:border-zinc-700">
          <div className="flex -space-x-1">
            <div className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-600">
              <ThumbsUp className="h-2.5 w-2.5 text-white" fill="white" />
            </div>
            <div className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500">
              <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="white">
                <path d="M8 14s-5.5-3.5-5.5-8A3.5 3.5 0 0 1 6 2.5c.94 0 1.79.5 2.25 1.25A2.76 2.76 0 0 1 10.5 2.5 3.5 3.5 0 0 1 14 6c0 4.5-6 8-6 8z" />
              </svg>
            </div>
            <div className="flex h-4 w-4 items-center justify-center rounded-full bg-green-600">
              <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="white">
                <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.5 5.5l-4 5.5L4 7.5l1-1 2.5 2.5 3-4z" />
              </svg>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">42</span>
          <div className="ml-auto flex gap-2 text-xs text-muted-foreground">
            <span>3 comments</span>
            <span>·</span>
            <span>1 repost</span>
          </div>
        </div>

        {/* Engagement row */}
        <div className="grid grid-cols-4 px-2 py-1">
          <button className="flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <ThumbsUp className="h-4 w-4" />
            <span className="text-xs font-medium">Like</span>
          </button>
          <button className="flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <MessageCircle className="h-4 w-4" />
            <span className="text-xs font-medium">Comment</span>
          </button>
          <button className="flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <Repeat2 className="h-4 w-4" />
            <span className="text-xs font-medium">Repost</span>
          </button>
          <button className="flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <Send className="h-4 w-4" />
            <span className="text-xs font-medium">Send</span>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
