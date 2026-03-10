"use client";

import { Card, CardContent } from "~/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Globe, Image as ImageIcon } from "lucide-react";

export interface PostPreviewProps {
  content: string;
  mediaUrls?: string[];
  authorName?: string;
  authorHandle?: string;
  authorAvatar?: string;
  timestamp?: Date;
}

interface GenericPreviewProps extends PostPreviewProps {
  platformName?: string;
}

function formatTimestamp(date?: Date): string {
  if (!date) return "Just now";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

export function GenericPreview({
  content,
  mediaUrls,
  authorName = "Your Name",
  authorHandle,
  authorAvatar,
  timestamp,
  platformName = "Platform",
}: GenericPreviewProps) {
  return (
    <Card className="overflow-hidden border border-zinc-200 dark:border-zinc-700">
      <CardContent className="p-4">
        {/* Platform badge */}
        <div className="mb-3">
          <Badge variant="outline" className="gap-1 text-xs">
            <Globe className="h-3 w-3" />
            {platformName} Preview
          </Badge>
        </div>

        {/* Author row */}
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10 flex-shrink-0">
            {authorAvatar ? (
              <AvatarImage src={authorAvatar} alt={authorName} />
            ) : null}
            <AvatarFallback className="bg-zinc-100 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {getInitials(authorName)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {authorName}
            </p>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {authorHandle && <span>@{authorHandle}</span>}
              {authorHandle && <span>·</span>}
              <span>{formatTimestamp(timestamp)}</span>
            </div>
          </div>
        </div>

        {/* Post content */}
        <div className="mt-3">
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
          <div className="mt-3">
            {mediaUrls.length === 1 ? (
              <div className="relative overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800">
                <div className="aspect-video">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mediaUrls[0]}
                    alt="Post media"
                    className="h-full w-full object-cover"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {mediaUrls.slice(0, 4).map((url, i) => (
                  <div
                    key={i}
                    className="relative overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800"
                  >
                    <div className="aspect-square">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={`Media ${i + 1}`}
                        className="h-full w-full object-cover"
                      />
                    </div>
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

        {/* Empty media placeholder */}
        {(!mediaUrls || mediaUrls.length === 0) && (
          <div className="mt-3 flex items-center justify-center rounded-lg border-2 border-dashed border-zinc-200 py-8 dark:border-zinc-700">
            <div className="text-center">
              <ImageIcon className="mx-auto mb-1 h-6 w-6 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">No media attached</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
