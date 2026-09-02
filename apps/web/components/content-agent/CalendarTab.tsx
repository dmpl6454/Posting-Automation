"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  addMonths,
  subMonths,
  isToday as isDateToday,
} from "date-fns";

/*
 * Status colours. The design's legend renders a SOLID 8px dot per status
 * (`background:{{ l.color }}`) and tints the day chip from the same hue.
 *
 * These are palette colours, not raw Tailwind ones. The previous version used
 * `bg-blue-500/15` etc. and derived the legend dot by regex-stripping the text
 * class off the chip class — which left a 15%-alpha fill, i.e. an effectively
 * INVISIBLE dot on true black. Keeping `dot` and `chip` as separate explicit
 * values is what stops that from happening again.
 */
const STATUS_STYLES: Record<
  string,
  { label: string; dot: string; chip: string }
> = {
  SCHEDULED: {
    label: "Scheduled",
    // Gold is the design's "state" accent — a queued post is the calendar's
    // primary subject, so it gets the accent rather than a stray blue.
    dot: "bg-gold",
    chip: "border-[hsl(var(--accent-border))] bg-gold/[0.14] text-gold",
  },
  PUBLISHED: {
    label: "Published",
    dot: "bg-[var(--pa-success)]",
    chip:
      "border-[color:rgb(127_182_155_/_0.32)] bg-[color:rgb(127_182_155_/_0.12)] text-[var(--pa-success)]",
  },
  PUBLISHING: {
    label: "Publishing",
    dot: "bg-[var(--pa-warning)]",
    chip:
      "border-[color:rgb(245_158_11_/_0.4)] bg-[color:rgb(245_158_11_/_0.12)] text-[var(--pa-warning)]",
  },
  FAILED: {
    label: "Failed",
    dot: "bg-[var(--pa-danger)]",
    chip:
      "border-[color:rgb(217_138_126_/_0.32)] bg-[color:rgb(217_138_126_/_0.12)] text-[var(--pa-danger)]",
  },
  DRAFT: {
    label: "Draft",
    dot: "bg-faint",
    chip: "border-border2 bg-tile text-muted-foreground",
  },
};

const FILTER_OPTIONS = ["ALL", "SCHEDULED", "PUBLISHED", "FAILED", "DRAFT"] as const;

/* `post.list` caps `limit` at 100 server-side (`z.number().max(100)`). */
const PAGE_SIZE = 100;
/*
 * Pages fetched before we stop and hand the user an explicit "Load more".
 * A month view genuinely needs more than one page once an org is busy, but an
 * unbounded auto-fetch would walk the whole post history on mount. When we stop
 * with more still available we SAY SO (see the footer note) rather than letting
 * a partial grid read as the complete month.
 */
const AUTO_PAGES = 4;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarTab() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [statusFilter, setStatusFilter] =
    useState<(typeof FILTER_OPTIONS)[number]>("ALL");

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  /*
   * useInfiniteQuery, not a single 200-limit query. The old code asked for
   * `limit: 200` against a `.max(100)` input, so EVERY request failed zod
   * validation — `data` stayed undefined, `posts` fell back to `[]`, and the
   * calendar rendered a permanently empty month with no error surfaced.
   */
  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.post.list.useInfiniteQuery(
    {
      status: statusFilter === "ALL" ? undefined : statusFilter,
      limit: PAGE_SIZE,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const pageCount = data?.pages.length ?? 0;
  const posts = data?.pages.flatMap((p) => p.posts) ?? [];

  /*
   * Walk up to AUTO_PAGES without user interaction, then stop and disclose.
   * In an effect, NOT inline in render — a render-phase fetchNextPage() is a
   * side effect during render and can re-enter before the page count updates.
   * Deps are primitives + the stable fetchNextPage identity, so this settles
   * (see the ActivityPanel SSE-storm rule: never depend on a query object).
   */
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && pageCount > 0 && pageCount < AUTO_PAGES) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, pageCount, fetchNextPage]);

  const stoppedShort = Boolean(hasNextPage) && pageCount >= AUTO_PAGES;

  const postDate = (p: { scheduledAt?: unknown; publishedAt?: unknown; createdAt: unknown }) =>
    (p.scheduledAt ?? p.publishedAt ?? p.createdAt) as Date | string | null;

  /* Leading + TRAILING pads so the grid is always a clean rectangle. Without
     the trailing pads the last row collapsed to the width of its real days. */
  const leadPads = monthStart.getDay();
  const trailPads = (7 - ((leadPads + days.length) % 7)) % 7;

  return (
    /* Design: `border-radius:14px; background:var(--card); padding:22px`. */
    <Card className="p-[22px]">
      {/* ── Header: month, status filters, month nav ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[16px] font-medium leading-[1.2]">
          {format(currentDate, "MMMM yyyy")}
        </h2>
        <div className="flex flex-wrap items-center gap-3.5">
          <div className="flex flex-wrap items-center gap-1">
            <Filter className="mr-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {FILTER_OPTIONS.map((opt) => {
              const active = statusFilter === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  data-compact
                  aria-pressed={active}
                  onClick={() => setStatusFilter(opt)}
                  className={cn(
                    "h-[26px] whitespace-nowrap rounded-full border px-2.5 text-[11.5px] transition-colors",
                    active
                      ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] font-semibold text-gold"
                      : "border-border2 bg-surface2 font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
                  )}
                >
                  {opt === "ALL"
                    ? "All"
                    : STATUS_STYLES[opt]?.label ?? opt}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              data-compact
              aria-label="Previous month"
              onClick={() => setCurrentDate(subMonths(currentDate, 1))}
              className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <ChevronLeft className="h-[15px] w-[15px]" />
            </button>
            <button
              type="button"
              data-compact
              onClick={() => setCurrentDate(new Date())}
              className="flex h-[30px] items-center rounded-[7px] px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              Today
            </button>
            <button
              type="button"
              data-compact
              aria-label="Next month"
              onClick={() => setCurrentDate(addMonths(currentDate, 1))}
              className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <ChevronRight className="h-[15px] w-[15px]" />
            </button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="mt-[18px] h-96 rounded-[9px]" />
      ) : isError ? (
        <p className="mt-[18px] rounded-[9px] border border-border2 bg-surface2 p-4 text-[12.5px] text-muted-foreground">
          Couldn&apos;t load your posts. Reload the page to try again.
        </p>
      ) : (
        <>
          {/* ── Weekday header ── */}
          <div className="mt-[18px] grid grid-cols-7 gap-px text-center text-[10.5px] font-medium uppercase leading-none tracking-[0.06em] text-muted-foreground">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1.5">
                {/* Three letters is unreadable-narrow at 375px; one is not. */}
                <span className="sm:hidden">{d.charAt(0)}</span>
                <span className="hidden sm:inline">{d}</span>
              </div>
            ))}
          </div>

          {/* ── Day grid ── */}
          <div className="mt-0.5 grid grid-cols-7 gap-1">
            {Array.from({ length: leadPads }).map((_, i) => (
              <div key={`lead-${i}`} className="min-h-[62px] sm:min-h-[104px]" />
            ))}

            {days.map((day) => {
              const dayPosts = posts.filter((p) => {
                const d = postDate(p);
                return d ? isSameDay(new Date(d), day) : false;
              });
              const isToday = isDateToday(day);

              return (
                <div
                  key={day.toISOString()}
                  className={cn(
                    "min-h-[62px] rounded-[9px] border p-[5px] transition-colors sm:min-h-[104px] sm:p-[7px]",
                    isToday
                      ? "border-[hsl(var(--accent-border))] bg-gold/[0.06]"
                      : "border-border bg-surface2 hover:border-border2 hover:bg-hover"
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex items-center justify-center text-[11.5px] font-medium leading-none",
                      isToday
                        ? "h-[19px] w-[19px] rounded-full bg-gold font-semibold text-[color:hsl(var(--gold-foreground))]"
                        : "text-muted-foreground"
                    )}
                  >
                    {format(day, "d")}
                  </span>

                  <div className="mt-1 flex flex-col gap-0.5">
                    {dayPosts.slice(0, 3).map((post) => {
                      const s =
                        STATUS_STYLES[post.status as string] ?? STATUS_STYLES.DRAFT!;
                      return (
                        <Link
                          key={post.id}
                          href={`/dashboard/posts/${post.id}`}
                          title={post.content}
                          className={cn(
                            "block truncate rounded-[5px] border px-[5px] py-[2px] text-[9.5px] font-medium leading-[1.35] transition-opacity hover:opacity-80",
                            s.chip
                          )}
                        >
                          {post.content || "Untitled post"}
                        </Link>
                      );
                    })}
                    {dayPosts.length > 3 && (
                      <span className="pl-[5px] text-[9.5px] font-medium leading-[1.4] text-faint">
                        +{dayPosts.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {Array.from({ length: trailPads }).map((_, i) => (
              <div key={`trail-${i}`} className="min-h-[62px] sm:min-h-[104px]" />
            ))}
          </div>

          {/* ── Status legend ── */}
          <div className="mt-4 flex flex-wrap items-center gap-3.5 border-t border-border pt-3.5">
            <span className="text-[11px] leading-none text-muted-foreground">
              Status:
            </span>
            {FILTER_OPTIONS.filter((o) => o !== "ALL").map((status) => {
              const s = STATUS_STYLES[status]!;
              return (
                <div key={status} className="flex items-center gap-1.5">
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", s.dot)}
                  />
                  <span className="text-[11.5px] leading-none text-muted-foreground">
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/*
            An incomplete month must never read as an empty one. Only shown
            once the auto-fetch budget is spent AND more pages remain.
          */}
          {stoppedShort && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <p className="text-[11.5px] text-muted-foreground">
                Showing your {posts.length} most recent posts — older ones
                aren&apos;t on the grid yet.
              </p>
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="h-[26px] rounded-full border border-border2 bg-surface2 px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-60"
              >
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
