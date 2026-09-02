"use client";

import { trpc } from "~/lib/trpc/client";
import { Skeleton } from "~/components/ui/skeleton";
import { TrendingUp, ExternalLink, Info, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

/**
 * Design: each source has its own hue, used for the card's left rail AND its
 * source pill, so a scan down the list reads "where did this come from" before
 * any text is read. Literal hex from the mockup — this project's Tailwind
 * config flattens the orange/green/amber scales, so a named shade would render
 * the pill's text the same colour as its own background.
 *
 * ⚠️ Keyed on this app's REAL `TrendingSource` enum, not the mockup's labels.
 * The mockup invents NEWS/HACKERNEWS; the schema has GOOGLE_NEWS/NEWSAPI and no
 * Hacker News at all. Keying on the mockup's names would drop every row to the
 * grey fallback — the design's whole source-at-a-glance idea, silently dead.
 */
const SOURCE_COLOR: Record<string, string> = {
  RSS: "#e08a4a",
  TWITTER: "#5b9bd5",
  REDDIT: "#d9695f",
  GOOGLE_NEWS: "#5cb85c",
  NEWSAPI: "#e0b84a",
};
const SOURCE_FALLBACK = "#7e8a9a";

/**
 * Status pill styles. Same note: the schema's statuses are
 * NEW/SCORED/GENERATING/GENERATED/POSTED/EXPIRED/REJECTED — the mockup's
 * ASSIGNED/DISMISSED do not exist here, so its blue "in progress" and outlined
 * "closed out" treatments are mapped onto the equivalents that do.
 */
const STATUS_STYLE: Record<string, string> = {
  NEW: "bg-gold/[0.12] text-gold border border-[hsl(var(--accent-border))]",
  SCORED: "bg-tile text-muted-foreground",
  GENERATING: "bg-[rgba(91,155,213,0.15)] text-[#5b9bd5] border border-[rgba(91,155,213,0.3)]",
  GENERATED: "bg-[rgba(92,184,92,0.15)] text-[#5cb85c] border border-[rgba(92,184,92,0.3)]",
  POSTED: "bg-[rgba(92,184,92,0.15)] text-[#5cb85c] border border-[rgba(92,184,92,0.3)]",
  EXPIRED: "bg-transparent text-faint border border-border2",
  REJECTED: "bg-transparent text-faint border border-border2",
};

/** GOOGLE_NEWS → "Google news"; keeps the pill readable at 9.5px. */
const prettyLabel = (s: string) =>
  s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export default function TrendingPage() {
  const { data, isLoading } = trpc.autopilot.trendingItems.useQuery({});

  const items = (data as any)?.items ?? [];
  const lastUpdatedAt = items[0]?.updatedAt ?? items[0]?.createdAt ?? null;

  return (
    <div className="space-y-4">
      {/* Fix #50: show last-discovered timestamp and workflow hint */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <p className="min-w-0 text-[12px] leading-[1.6] text-muted-foreground">
            Trending items are discovered by the Autopilot pipeline. Go to{" "}
            <a href="/dashboard/autopilot" className="text-foreground underline underline-offset-2">Autopilot</a>{" "}
            and click <b className="text-foreground">Run Pipeline Now</b> to refresh.
          </p>
          {lastUpdatedAt && (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] leading-none text-faint">
              <Clock className="h-3 w-3" />
              Last discovered {formatDistanceToNow(new Date(lastUpdatedAt), { addSuffix: true })}
            </span>
          )}
        </div>
      </div>
      {isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full rounded-[12px]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <TrendingUp className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No trending items yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Run the pipeline to discover trending topics from your configured
            sources.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((item: any) => {
            const sourceColor = SOURCE_COLOR[item.sourceType] ?? SOURCE_FALLBACK;
            return (
              <div
                key={item.id}
                className="relative overflow-hidden rounded-[12px] border border-border bg-card py-4 pl-[21px] pr-[18px] shadow-[0_6px_14px_-10px_rgba(0,0,0,.45)]"
              >
                <span
                  className="absolute left-0 top-0 h-full w-[3px]"
                  style={{ background: sourceColor }}
                />

                {/* Title + external link */}
                {item.sourceUrl ? (
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13px] font-medium leading-[1.4] hover:underline"
                  >
                    {item.title}
                    <ExternalLink className="ml-1 inline h-3 w-3 text-muted-foreground" />
                  </a>
                ) : (
                  <p className="text-[13px] font-medium leading-[1.4]">{item.title}</p>
                )}

                {/* Meta row */}
                <div className="mt-[9px] flex flex-wrap items-center gap-2">
                  <span
                    className="shrink-0 rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6]"
                    style={{ background: `${sourceColor}22`, color: sourceColor }}
                  >
                    {prettyLabel(item.sourceType)}
                  </span>
                  {item.sourceName && (
                    <span className="text-[11px] leading-none text-muted-foreground">
                      {item.sourceName}
                    </span>
                  )}
                  <span
                    className={`shrink-0 rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] ${
                      STATUS_STYLE[item.status] ?? "bg-tile text-muted-foreground"
                    }`}
                  >
                    {prettyLabel(item.status)}
                  </span>
                  {/* The design's "Score: N". The column is `trendScore` —
                      the old markup read `item.score`, which does not exist on
                      a TrendingItem, so this line never rendered at all. */}
                  {item.trendScore != null && (
                    <span className="text-[11px] font-medium leading-none text-muted-foreground">
                      Score: {Math.round(item.trendScore)}
                    </span>
                  )}
                  {item.publishedAt && (
                    <span className="text-[11px] leading-none text-faint">
                      {new Date(item.publishedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>

                {/* Topics */}
                {item.topics?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-[5px]">
                    {item.topics.map((topic: string, idx: number) => (
                      <span
                        key={idx}
                        className="rounded-[4px] bg-tile px-[7px] py-[1.5px] text-[9.5px] leading-[1.6] text-faint"
                      >
                        {topic}
                      </span>
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
