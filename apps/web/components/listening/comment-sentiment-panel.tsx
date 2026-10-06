"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Clock, ExternalLink, MessageCircle, Smile, TrendingUp } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  SENTIMENT_META,
  SENTIMENT_ORDER,
  commentThreadHref,
  externalLinkTitle,
  fillDailySeries,
  formatAvgScore,
  opensOnPlatform,
  platformLabel,
  sentimentKey,
  sentimentPercents,
  type SentimentKey,
} from "~/lib/comment-sentiment";
import { cn } from "~/lib/utils";

/**
 * Social Listening → "Comments on your posts" (2026-10-05).
 *
 * Sentiment of the comments people leave on posts published through
 * PostAutomation to the workspace's Facebook Pages, Instagram accounts and
 * YouTube channels and LinkedIn Pages (both since 2026-10-06; their comments
 * open on the platform, since there is no Comments inbox for them here).
 * The comment sweep stores and scores them every 15 minutes once a workspace
 * switches "Comment sentiment" on (Comments → Automation). Unscored comments
 * are shown as "waiting", never folded into neutral.
 */

const RANGES = [7, 30, 90] as const;
type Filter = SentimentKey | "pending" | null;

export function CommentSentimentPanel() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(null);

  const overview = trpc.comment.sentimentOverview.useQuery(
    { days, channelId },
    { refetchInterval: 60_000, staleTime: 30_000 }
  );
  const list = trpc.comment.sentimentComments.useInfiniteQuery(
    { days, channelId, sentiment: filter === "pending" ? "PENDING" : filter ? (filter.toUpperCase() as "POSITIVE") : null, limit: 20 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, refetchInterval: 60_000, staleTime: 30_000 }
  );
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const data = overview.data;
  const totals = data?.totals ?? { positive: 0, neutral: 0, mixed: 0, negative: 0, pending: 0, scored: 0, total: 0 };
  const pct = sentimentPercents(totals);

  if (overview.isError) {
    return <p className="rounded-[12px] border border-border bg-card p-4 text-[12.5px] text-destructive">{humanizeError(overview.error)}</p>;
  }

  const off = data && !data.enabled;

  return (
    <div className="space-y-5" data-testid="comment-sentiment-panel">
      {/* Controls — one row above the charts. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-[9px] border border-border bg-surface1 p-0.5" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={days === r}
              onClick={() => setDays(r)}
              className={cn(
                "h-7 rounded-[7px] px-3 text-[12px]",
                days === r ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {r} days
            </button>
          ))}
        </div>
        <select
          value={channelId ?? ""}
          onChange={(e) => setChannelId(e.target.value || null)}
          className="h-8 max-w-[16rem] rounded-[9px] border border-border bg-card px-2 text-[12px]"
          aria-label="Account"
          data-testid="sentiment-account"
        >
          <option value="">All accounts</option>
          {(data?.byChannel ?? []).map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {platformLabel(c.platform)} · {c.name}
            </option>
          ))}
        </select>
        {data?.lastRunAt && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            Last check {formatDistanceToNow(new Date(data.lastRunAt), { addSuffix: true })}
          </span>
        )}
      </div>

      {off && (
        <div className="rounded-[12px] border border-border bg-surface1 px-4 py-3.5 text-[12px] leading-[1.6] text-muted-foreground" data-testid="sentiment-off">
          <b className="text-foreground">Comment sentiment is off for this workspace.</b>{" "}
          {totals.total > 0
            ? "Showing comments scored while it was on; no new comments are being collected."
            : "Turn it on to score the comments people leave on your Facebook, Instagram, YouTube and LinkedIn Page posts."}{" "}
          An owner or admin can switch it on in{" "}
          <Link href="/dashboard/comments?view=automation" className="font-medium text-foreground underline">
            Comments → Automation
          </Link>
          .
        </div>
      )}

      {/* Stat tiles */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Comments scored", value: totals.scored.toLocaleString(), icon: MessageCircle, color: "#5b9bd5" },
          { title: "Average sentiment", value: formatAvgScore(data?.avgScore), icon: TrendingUp, color: "#5cb85c", hint: "From −1 (negative) to +1 (positive)" },
          { title: "Negative", value: totals.scored ? `${pct.negative}%` : "—", icon: Smile, color: "#d9695f", hint: `${totals.negative.toLocaleString()} comments` },
          { title: "Waiting to be scored", value: totals.pending.toLocaleString(), icon: Clock, color: "#8a8578", hint: "Scored on the next checks" },
        ].map((s) => (
          <div key={s.title} className="relative overflow-hidden rounded-[14px] border border-border bg-card p-[18px]">
            <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: s.color }} />
            <div className="flex items-start justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">{s.title}</span>
              <s.icon className="h-[15px] w-[15px] shrink-0" style={{ color: s.color }} />
            </div>
            {overview.isLoading ? (
              <Skeleton className="mt-2.5 h-[26px] w-16" />
            ) : (
              <div className="mt-2.5 text-[26px] font-bold leading-none" data-testid={`stat-${s.title}`}>
                {s.value}
              </div>
            )}
            {s.hint && <p className="mt-1.5 text-[10.5px] text-faint">{s.hint}</p>}
          </div>
        ))}
      </div>

      {/* Distribution */}
      <div className="rounded-[14px] border border-border bg-card p-[22px]">
        <h2 className="text-[14px] font-medium text-muted-foreground">Sentiment of comments on your posts</h2>
        <div className="mt-3.5 flex h-3.5 w-full gap-[2px] overflow-hidden rounded-full bg-tile" data-testid="sentiment-bar">
          {SENTIMENT_ORDER.map((k) =>
            pct[k] > 0 ? (
              <div
                key={k}
                className="h-full"
                style={{ width: `${pct[k]}%`, background: SENTIMENT_META[k].color }}
                title={`${SENTIMENT_META[k].label}: ${totals[k].toLocaleString()} (${pct[k]}%)`}
              />
            ) : null
          )}
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-5 text-[12px] text-muted-foreground">
          {SENTIMENT_ORDER.map((k) => (
            <span key={k} className="flex items-center gap-[7px]">
              <span className="h-[9px] w-[9px] rounded-full" style={{ background: SENTIMENT_META[k].color }} />
              {SENTIMENT_META[k].label} {pct[k]}%
            </span>
          ))}
          {totals.pending > 0 && <span className="text-faint">· {totals.pending} waiting to be scored</span>}
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <DailyChart daily={data && totals.total > 0 ? fillDailySeries(data.daily, days) : []} loading={overview.isLoading} />

          {/* Comments */}
          <div>
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              <h2 className="mr-2 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Comments</h2>
              {([null, "negative", "mixed", "neutral", "positive", "pending"] as Filter[]).map((f) => (
                <button
                  key={f ?? "all"}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "h-7 rounded-[7px] border px-2.5 text-[11.5px]",
                    filter === f ? "border-foreground/20 bg-foreground/[0.08] font-semibold text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  )}
                  data-testid={`sentiment-filter-${f ?? "all"}`}
                >
                  {f === null ? "All" : f === "pending" ? "Waiting" : SENTIMENT_META[f].label}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-2" data-testid="sentiment-comments">
              {list.isLoading ? (
                [1, 2, 3].map((i) => <Skeleton key={i} className="h-[70px] rounded-[12px]" />)
              ) : items.length === 0 ? (
                <p className="rounded-[12px] border border-border bg-card px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                  No comments here in this range.
                </p>
              ) : (
                items.map((c: any) => {
                  const key = sentimentKey(c.sentiment);
                  const meta = key ? SENTIMENT_META[key] : null;
                  return (
                    <div key={c.id} className="flex items-start gap-3 rounded-[12px] border border-border bg-card p-3.5">
                      <span
                        className="mt-px shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold"
                        style={meta ? { background: meta.tint, color: meta.color } : undefined}
                      >
                        {meta ? meta.label : "Waiting"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.5]">{c.commentText}</p>
                        <div className="mt-[7px] flex flex-wrap items-center gap-[9px] text-[11px] text-faint">
                          {c.authorLabel && <span className="font-medium text-muted-foreground">{c.authorLabel}</span>}
                          {c.channelName && (
                            <span>
                              on {platformLabel(c.platform)} · {c.channelName}
                            </span>
                          )}
                          {c.isReply && <span>reply</span>}
                          <span>{formatDistanceToNow(new Date(c.commentedAt ?? c.createdAt), { addSuffix: true })}</span>
                        </div>
                      </div>
                      {opensOnPlatform(c.platform) ? (
                        c.externalUrl && (
                          <a
                            href={c.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-faint hover:text-foreground"
                            title={externalLinkTitle(c.platform)}
                            data-testid="sentiment-external-link"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )
                      ) : (
                        <Link
                          href={commentThreadHref(c.channelId, c.postTargetId)}
                          className="shrink-0 text-faint hover:text-foreground"
                          title="Open this post's comments to reply, hide or message privately"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      )}
                    </div>
                  );
                })
              )}
              {list.hasNextPage && (
                <Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                  {list.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          {/* By account */}
          <div>
            <h2 className="mb-2.5 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">By account</h2>
            <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-card p-4">
              {(data?.byChannel ?? []).length === 0 ? (
                <p className="py-2 text-center text-[12px] text-muted-foreground">Nothing scored yet</p>
              ) : (
                data!.byChannel.map((c) => {
                  const p = sentimentPercents(c);
                  const scored = c.positive + c.neutral + c.mixed + c.negative;
                  return (
                    <div key={c.channelId} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="min-w-0 truncate">
                          {platformLabel(c.platform)} · {c.name}
                        </span>
                        <span className="shrink-0 text-faint">
                          {scored} scored{c.pending ? ` · ${c.pending} waiting` : ""}
                        </span>
                      </div>
                      <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-tile">
                        {SENTIMENT_ORDER.map((k) =>
                          p[k] > 0 ? (
                            <div key={k} style={{ width: `${p[k]}%`, background: SENTIMENT_META[k].color }} title={`${SENTIMENT_META[k].label}: ${c[k]} (${p[k]}%)`} />
                          ) : null
                        )}
                      </div>
                      <p className="text-[10.5px] text-faint">
                        {p.positive}% positive · {p.negative}% negative
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Posts drawing negative comments */}
          <div>
            <h2 className="mb-2.5 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Most negative comments
            </h2>
            <div className="flex flex-col gap-1.5 rounded-[14px] border border-border bg-card p-2.5" data-testid="worst-posts">
              {(data?.worstPosts ?? []).length === 0 ? (
                <p className="py-3 text-center text-[12px] text-muted-foreground">No negative comments in this range</p>
              ) : (
                data!.worstPosts.map((p) => {
                  const body = (
                    <>
                      <p className="line-clamp-2 text-[12px] leading-[1.4]">{p.caption || "(no caption)"}</p>
                      <p className="mt-1 text-[10.5px] text-faint">
                        {p.negative} negative {p.negative === 1 ? "comment" : "comments"}
                        {p.channelName ? ` · ${opensOnPlatform(p.platform) ? `${platformLabel(p.platform)} · ` : ""}${p.channelName}` : ""}
                      </p>
                    </>
                  );
                  const cls = "rounded-[9px] border border-border px-3 py-2.5 hover:border-border2";
                  if (opensOnPlatform(p.platform)) {
                    return p.externalUrl ? (
                      <a key={p.targetId} href={p.externalUrl} target="_blank" rel="noopener noreferrer" className={cls}>
                        {body}
                      </a>
                    ) : (
                      <div key={p.targetId} className={cls}>
                        {body}
                      </div>
                    );
                  }
                  return (
                    <Link key={p.targetId} href={commentThreadHref(p.channelId, p.targetId)} className={cls}>
                      {body}
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="text-[11px] leading-[1.6] text-faint">
        Covers comments on posts published through PostAutomation to your Facebook Pages and Instagram accounts, collected
        every 15 minutes from posts of the last 3 days (the first page of comments on each). Videos published to your
        YouTube channels and posts published to your LinkedIn Pages are read about once an hour for 7 days, within a daily
        API budget (LinkedIn personal profiles aren't covered: LinkedIn doesn't let apps read their comments). Sentiment is
        scored by AI and can be wrong on sarcasm or slang.
      </p>
    </div>
  );
}

/** Comments per day, stacked by sentiment, with a hover tooltip per day. */
function DailyChart({
  daily,
  loading,
}: {
  daily: Array<{ day: string; positive: number; negative: number; neutral: number; mixed: number; pending: number }>;
  loading: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...daily.map((d) => d.positive + d.negative + d.neutral + d.mixed + d.pending));
  const stack: Array<{ key: SentimentKey | "pending"; label: string; color: string }> = [
    { key: "negative", label: "Negative", color: SENTIMENT_META.negative.color },
    { key: "mixed", label: "Mixed", color: SENTIMENT_META.mixed.color },
    { key: "neutral", label: "Neutral", color: SENTIMENT_META.neutral.color },
    { key: "positive", label: "Positive", color: SENTIMENT_META.positive.color },
    { key: "pending", label: "Waiting", color: "transparent" },
  ];
  const h = hover !== null ? daily[hover] : null;

  return (
    <div className="rounded-[14px] border border-border bg-card p-[18px]" data-testid="sentiment-daily">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-medium text-muted-foreground">Comments per day</h2>
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          {stack.slice(0, 4).map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full border border-dashed border-muted-foreground" /> Waiting
          </span>
        </div>
      </div>
      {loading ? (
        <Skeleton className="mt-4 h-[140px] w-full" />
      ) : daily.length === 0 ? (
        <p className="mt-4 py-10 text-center text-[12px] text-muted-foreground">No comments in this range</p>
      ) : (
        <div className="relative mt-4">
          <div className="flex h-[140px] items-end gap-[3px] border-b border-border" onMouseLeave={() => setHover(null)}>
            {daily.map((d, i) => (
              <div
                key={d.day}
                className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
                onMouseEnter={() => setHover(i)}
                aria-label={`${d.day}: ${d.positive} positive, ${d.neutral} neutral, ${d.mixed} mixed, ${d.negative} negative, ${d.pending} waiting`}
              >
                <div className={cn("flex flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]", hover === i && "opacity-90")}>
                  {stack.map((s) => {
                    const v = d[s.key];
                    if (!v) return null;
                    return (
                      <div
                        key={s.key}
                        style={{
                          height: `${(v / max) * 136}px`,
                          background: s.color,
                          ...(s.key === "pending" ? { border: "1px dashed hsl(var(--muted-foreground))" } : {}),
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-faint">
            <span>{daily[0]!.day}</span>
            <span>{daily[daily.length - 1]!.day}</span>
          </div>
          {/* Readout under the axis (reserved height) — never covers the bars. */}
          <p className="mt-2 min-h-[16px] text-[11px] text-muted-foreground" data-testid="daily-tooltip">
            {h ? (
              <>
                <span className="font-semibold text-foreground">{h.day}</span> · {h.positive} positive · {h.neutral} neutral ·{" "}
                {h.mixed} mixed · {h.negative} negative{h.pending ? ` · ${h.pending} waiting` : ""}
              </>
            ) : (
              "Hover a day to see its numbers."
            )}
          </p>
        </div>
      )}
    </div>
  );
}
