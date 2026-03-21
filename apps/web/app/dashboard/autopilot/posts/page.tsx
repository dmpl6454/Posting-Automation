"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Button } from "~/components/ui/button";
import { Send, ChevronLeft, ChevronRight } from "lucide-react";

const PLATFORM_COLORS: Record<string, string> = {
  TWITTER: "bg-sky-400",
  INSTAGRAM: "bg-pink-500",
  FACEBOOK: "bg-blue-600",
  LINKEDIN: "bg-blue-700",
  YOUTUBE: "bg-red-600",
  TIKTOK: "bg-black",
  REDDIT: "bg-orange-600",
  PINTEREST: "bg-red-500",
  THREADS: "bg-gray-800",
  TELEGRAM: "bg-sky-500",
  DISCORD: "bg-indigo-500",
  SLACK: "bg-purple-600",
  MASTODON: "bg-violet-600",
  BLUESKY: "bg-blue-400",
  MEDIUM: "bg-gray-700",
  DEVTO: "bg-gray-900",
};

const STATUS_STYLES: Record<
  string,
  { label: string; className: string }
> = {
  PUBLISHED: { label: "Published", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  SCHEDULED: { label: "Scheduled", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
  FAILED: { label: "Failed", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
  DRAFT: { label: "Draft", className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
  PUBLISHING: { label: "Publishing", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
  CANCELLED: { label: "Cancelled", className: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? { label: status, className: "bg-gray-100 text-gray-700" };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}
    >
      {s.label}
    </span>
  );
}

function PlatformDot({ platform }: { platform: string }) {
  const color = PLATFORM_COLORS[platform] ?? "bg-gray-400";
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className="text-xs text-muted-foreground capitalize">
        {platform.charAt(0) + platform.slice(1).toLowerCase()}
      </span>
    </span>
  );
}

function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  return new Date(dateString).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statValue(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const PAGE_SIZE = 20;

export default function AutopilotPostsPage() {
  const [skip, setSkip] = useState(0);

  const { data, isLoading } = trpc.autopilot.posts.useQuery(
    { skip },
    { keepPreviousData: true } as any
  );

  const items = (data as any[]) ?? [];
  const hasNext = items.length === PAGE_SIZE;
  const hasPrev = skip > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing autopilot-generated posts and their performance
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!hasPrev}
            onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasNext}
            onClick={() => setSkip(skip + PAGE_SIZE)}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-6">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <Skeleton className="h-12 w-full" />
                <div className="flex gap-3">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-20" />
                </div>
                <div className="flex gap-4">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Send className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No autopilot posts yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Trigger the pipeline to generate your first post.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item: any) => {
            const post = item.post;
            const targets: any[] = post?.targets ?? [];
            const trendingItem = item.trendingItem;
            const agent = item.agent;

            // Aggregate analytics across all targets
            const totalImpressions = targets.reduce(
              (sum: number, t: any) =>
                sum +
                (t.analyticsSnapshots?.[0]?.impressions ?? 0),
              0
            );
            const totalLikes = targets.reduce(
              (sum: number, t: any) =>
                sum + (t.analyticsSnapshots?.[0]?.likes ?? 0),
              0
            );
            const totalComments = targets.reduce(
              (sum: number, t: any) =>
                sum + (t.analyticsSnapshots?.[0]?.comments ?? 0),
              0
            );

            // Earliest published date
            const publishedAt =
              targets
                .map((t: any) => t.publishedAt)
                .filter(Boolean)
                .sort()[0] ?? post?.publishedAt ?? item.createdAt;

            return (
              <Card key={item.id} className="p-6">
                <div className="space-y-3">
                  {/* Header row */}
                  <div className="flex flex-wrap items-center gap-2">
                    {agent && (
                      <Badge variant="secondary" className="text-xs">
                        {agent.name}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDate(publishedAt)}
                    </span>
                    <div className="ml-auto flex flex-wrap gap-1">
                      {targets.map((t: any) => (
                        <StatusBadge key={t.id} status={t.status} />
                      ))}
                    </div>
                  </div>

                  {/* Content preview */}
                  {post?.content && (
                    <p className="line-clamp-2 text-sm leading-relaxed">
                      {post.content}
                    </p>
                  )}

                  {/* Platform badges */}
                  {targets.length > 0 && (
                    <div className="flex flex-wrap gap-3">
                      {targets.map((t: any) => (
                        <PlatformDot
                          key={t.id}
                          platform={t.channel?.platform ?? ""}
                        />
                      ))}
                    </div>
                  )}

                  {/* Analytics row */}
                  <div className="flex items-center gap-6 border-t pt-3">
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">Impressions</span>
                      <span className="text-sm font-medium">
                        {statValue(totalImpressions)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">Likes</span>
                      <span className="text-sm font-medium">
                        {statValue(totalLikes)}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">Comments</span>
                      <span className="text-sm font-medium">
                        {statValue(totalComments)}
                      </span>
                    </div>

                    {/* Source news */}
                    {trendingItem?.title && (
                      <div className="ml-auto max-w-xs truncate">
                        {trendingItem.sourceUrl ? (
                          <a
                            href={trendingItem.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate text-xs text-muted-foreground hover:underline"
                            title={trendingItem.title}
                          >
                            {trendingItem.title}
                          </a>
                        ) : (
                          <span
                            className="truncate text-xs text-muted-foreground"
                            title={trendingItem.title}
                          >
                            {trendingItem.title}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
