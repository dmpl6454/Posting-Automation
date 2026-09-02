"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Skeleton } from "~/components/ui/skeleton";
import { Button } from "~/components/ui/button";
import { Send, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";

/**
 * Design: platform dots and status pills are literal hex from the mockup. This
 * project's Tailwind config flattens the green/red/amber scales onto the
 * palette's status triplets, so a named shade would render a pill's text the
 * same colour as its own background.
 */
const PLATFORM_DOT: Record<string, string> = {
  TWITTER: "#5b9bd5",
  INSTAGRAM: "#d15a9e",
  FACEBOOK: "#4a6fa5",
  LINKEDIN: "#3c6fa8",
  YOUTUBE: "#d9695f",
  TIKTOK: "#7e8a9a",
  REDDIT: "#e08a4a",
  PINTEREST: "#b85c5c",
  THREADS: "#8a9a7e",
  TELEGRAM: "#6b7d9e",
  DISCORD: "#6b7d9e",
  SLACK: "#a183c9",
  MASTODON: "#a183c9",
  BLUESKY: "#5b9bd5",
  MEDIUM: "#7e8a9a",
  DEVTO: "#9a8a5c",
};
const PLATFORM_DOT_FALLBACK = "#7e8a9a";

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  PUBLISHED: { label: "Published", className: "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]" },
  SCHEDULED: { label: "Scheduled", className: "bg-[rgba(224,184,74,0.15)] text-[#e0b84a]" },
  FAILED: { label: "Failed", className: "bg-[rgba(217,105,95,0.15)] text-[#d9695f]" },
  DRAFT: { label: "Draft", className: "bg-tile text-muted-foreground" },
  PUBLISHING: { label: "Publishing", className: "bg-[rgba(91,155,213,0.15)] text-[#5b9bd5]" },
  CANCELLED: { label: "Cancelled", className: "bg-tile text-faint" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? {
    label: status,
    className: "bg-tile text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold leading-[1.6] ${s.className}`}
    >
      {s.label}
    </span>
  );
}

function PlatformDot({ platform }: { platform: string }) {
  const color = PLATFORM_DOT[platform] ?? PLATFORM_DOT_FALLBACK;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
      <span
        className="h-[7px] w-[7px] rounded-full"
        style={{ background: color }}
      />
      {platform ? platform.charAt(0) + platform.slice(1).toLowerCase() : "—"}
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
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] leading-none text-muted-foreground">
          Showing autopilot-generated posts and their performance
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-[8px] border-border2 bg-surface2 px-[13px] text-[12px] font-medium hover:bg-hover"
            disabled={!hasPrev}
            onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-[8px] border-border2 bg-surface2 px-[13px] text-[12px] font-medium hover:bg-hover"
            disabled={!hasNext}
            onClick={() => setSkip(skip + PAGE_SIZE)}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[220px] w-full rounded-[14px]" />
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
        <div className="flex flex-col gap-3.5">
          {items.map((item: any) => {
            const post = item;
            const targets: any[] = item.targets ?? [];
            const trendingItem = item.autopilotPost?.trendingItem;
            const agent = item.autopilotPost?.agent;

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
              <div
                key={item.id}
                className="rounded-[14px] border border-border bg-card p-5 shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]"
              >
                {/* Header row */}
                <div className="flex flex-wrap items-center gap-2">
                  {agent && (
                    <span className="rounded-[5px] bg-tile px-[9px] py-0.5 text-[10.5px] font-semibold leading-[1.6] text-muted-foreground">
                      {agent.name}
                    </span>
                  )}
                  <span className="text-[11px] leading-none text-faint">
                    {formatDate(publishedAt)}
                  </span>
                  <div className="ml-auto flex flex-wrap gap-2">
                    {targets.map((t: any) => (
                      <span key={t.id} className="inline-flex items-center gap-1.5">
                        <StatusBadge status={t.status} />
                        <span className="text-[10px] leading-none text-faint">
                          {t.channel?.name ?? t.channel?.platform ?? "Channel"}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Content preview */}
                {post?.content && (
                  <p className="mt-3 line-clamp-2 text-[13px] leading-[1.55]">
                    {post.content}
                  </p>
                )}

                {/* Platform badges */}
                {targets.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-3">
                    {targets.map((t: any) => (
                      <PlatformDot
                        key={t.id}
                        platform={t.channel?.platform ?? ""}
                      />
                    ))}
                  </div>
                )}

                {/* Analytics row */}
                <div className="mt-3.5 flex items-center gap-6 border-t border-border pt-3.5">
                  <div>
                    <div className="text-[10.5px] leading-none text-muted-foreground">Impressions</div>
                    <div className="mt-1 text-[13px] font-semibold leading-none">
                      {statValue(totalImpressions)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10.5px] leading-none text-muted-foreground">Likes</div>
                    <div className="mt-1 text-[13px] font-semibold leading-none">
                      {statValue(totalLikes)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10.5px] leading-none text-muted-foreground">Comments</div>
                    <div className="mt-1 text-[13px] font-semibold leading-none">
                      {statValue(totalComments)}
                    </div>
                  </div>

                  {/* Source news */}
                  {trendingItem?.title && (
                    <div className="ml-auto max-w-[240px] truncate">
                      {trendingItem.sourceUrl ? (
                        <a
                          href={trendingItem.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-[11px] leading-[1.4] text-muted-foreground hover:underline"
                          title={trendingItem.title}
                        >
                          {trendingItem.title}
                        </a>
                      ) : (
                        <span
                          className="truncate text-[11px] leading-[1.4] text-muted-foreground"
                          title={trendingItem.title}
                        >
                          {trendingItem.title}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Published links */}
                {targets.some((t: any) => t.publishedUrl) && (
                  <div className="mt-3.5 flex flex-wrap gap-2 border-t border-border pt-3.5">
                    {targets
                      .filter((t: any) => t.publishedUrl)
                      .map((t: any) => (
                        <a
                          key={t.id}
                          href={t.publishedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-[7px] border border-border2 px-2 py-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {t.channel?.platform ?? "View"}
                        </a>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
