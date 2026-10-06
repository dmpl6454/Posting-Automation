"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CommentSentimentPanel } from "~/components/listening/comment-sentiment-panel";
import {
  DEFAULT_FEED_FILTERS,
  MIN_REACH_OPTIONS,
  PERIOD_OPTIONS,
  SENTIMENT_FILTER_OPTIONS,
  applyFeedFilters,
  compactCount,
  isFiltered,
  parseFeedFilters,
  reachLabel,
  type FeedFilters,
} from "~/lib/listening-feed";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Ear,
  Plus,
  TrendingUp,
  MessageCircle,
  Users,
  Bell,
  RefreshCw,
  Loader2,
  Trash2,
  Power,
  PowerOff,
  ExternalLink,
  Smile,
  Frown,
  Meh,
  Info,
  Eye,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

/**
 * Design: sentiment is a 26px tinted glyph tile beside each mention. Literal
 * hex from the mockup — this project's Tailwind config FLATTENS the
 * green/red/amber scales onto the palette's status triplets, so a named shade
 * like `bg-emerald-100 text-emerald-600` renders the icon the SAME colour as
 * its own background (the bug already hit the Insights stat tiles).
 */
const SENTIMENT_STYLE: Record<
  string,
  { icon: typeof Smile; bg: string; color: string }
> = {
  POSITIVE: { icon: Smile, bg: "rgba(92,184,92,0.15)", color: "#5cb85c" },
  NEGATIVE: { icon: Frown, bg: "rgba(217,105,95,0.15)", color: "#d9695f" },
  NEUTRAL: { icon: Meh, bg: "hsl(var(--tile))", color: "hsl(var(--muted-foreground))" },
  MIXED: { icon: Meh, bg: "rgba(224,184,74,0.15)", color: "#e0b84a" },
};

/** The four segments of the Sentiment Distribution bar, in the design's order. */
const SENTIMENT_BAR = [
  { key: "positive", value: "POSITIVE", label: "Positive", color: "#5cb85c" },
  { key: "neutral", value: "NEUTRAL", label: "Neutral", color: "#8a8578" },
  { key: "mixed", value: "MIXED", label: "Mixed", color: "#e0b84a" },
  { key: "negative", value: "NEGATIVE", label: "Negative", color: "#d9695f" },
] as const;
const SENTIMENT_DOT: Record<string, string> = Object.fromEntries(SENTIMENT_BAR.map((s) => [s.value, s.color]));

const PLATFORMS = [
  { id: "twitter", label: "X / Twitter" },
  { id: "instagram", label: "Instagram" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "reddit", label: "Reddit (posts + comments)" },
  // Videos matching the keywords and their comments (2026-10-05). Every 6
  // hours per query (and on Sync Now), within a daily YouTube API budget.
  { id: "youtube", label: "YouTube (videos + comments)" },
  // Free public sources, no account needed (2026-10-05).
  { id: "hackernews", label: "Hacker News (stories + comments)" },
  { id: "bluesky", label: "Bluesky" },
  { id: "mastodon", label: "Mastodon (hashtags)" },
  { id: "lemmy", label: "Lemmy (posts + comments)" },
  { id: "tiktok", label: "TikTok" },
  { id: "news", label: "News (Google News, Bing News, GDELT)" },
  // Facebook has no keyword search for anyone; this reads the public posts that
  // TAG your connected Pages (Graph /{page}/tagged) — brand mentions, not a web search.
  { id: "facebook", label: "Facebook (posts tagging your Pages)" },
];

/**
 * Per-source tag hue, tinted to 13% for the fill. Same literal-hex reasoning as
 * SENTIMENT_STYLE. The mockup covers seven sources; the four this app also
 * stores (YOUTUBE/BLOG/FORUM/OTHER) take neighbouring hues from the palette so
 * nothing falls through to an untinted grey.
 */
const SOURCE_TAG: Record<string, string> = {
  TWITTER: "#C9A356",
  FACEBOOK: "#5b9bd5",
  INSTAGRAM: "#d15a9e",
  LINKEDIN: "#3c6fa8",
  REDDIT: "#e08a4a",
  TIKTOK: "#8a8578",
  NEWS: "#5cb85c",
  YOUTUBE: "#d9695f",
  BLOG: "#9a8a5c",
  FORUM: "#a183c9",
  OTHER: "#7e8a9a",
  HACKERNEWS: "#e08a4a",
  BLUESKY: "#5b9bd5",
  MASTODON: "#a183c9",
  LEMMY: "#9a8a5c",
};
const SOURCE_TAG_FALLBACK = "#7e8a9a";

/**
 * Friendly source names for the Sources card. The mockup lists "Google News"
 * and "X / Twitter"; the API returns the raw `MentionSource` enum, so without
 * this the card reads NEWS / TWITTER in shouty uppercase.
 *
 * ⚠️ Deliberately NOT applied to the per-mention source tag — the mockup keeps
 * THAT one as the raw uppercase enum (TWITTER, REDDIT, NEWS), because a 9.5px
 * pill needs a short token, not a sentence.
 */
const SOURCE_LABEL: Record<string, string> = {
  TWITTER: "X / Twitter",
  NEWS: "Google News",
  REDDIT: "Reddit",
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TIKTOK: "TikTok",
  YOUTUBE: "YouTube",
  BLOG: "Blog",
  FORUM: "Forum",
  OTHER: "Other",
  HACKERNEWS: "Hacker News",
  BLUESKY: "Bluesky",
  MASTODON: "Mastodon",
  LEMMY: "Lemmy",
};

/**
 * A comment mention (Reddit / YouTube, 2026-10-05) carries the post or video
 * it was left on. Only an https link is rendered as a link.
 */
function commentParent(metadata: unknown): { title: string; url: string | null } | null {
  const m = metadata as { kind?: unknown; parentTitle?: unknown; parentUrl?: unknown } | null;
  if (!m || m.kind !== "comment" || typeof m.parentTitle !== "string" || !m.parentTitle) return null;
  const url = typeof m.parentUrl === "string" && /^https:\/\//i.test(m.parentUrl) ? m.parentUrl : null;
  return { title: m.parentTitle, url };
}

/**
 * The design prints "+0.34" — a sentiment score is signed, and a bare "0.34"
 * loses the one thing that makes it readable at a glance.
 */
function formatSentimentScore(n: number): string {
  const v = n.toFixed(2);
  return n > 0 ? `+${v}` : v;
}

/**
 * The design's compact count — "482K", "1.2M". Measured against the mockup:
 * its reach/engagement figures render as `210.0K`, never `210,000`. A
 * comma-grouped six-digit number does not fit the 26px stat slot or the 10px
 * sources caption, which is why the design compacts them.
 *
 * Deliberately NOT applied to Total Mentions — the mockup shows a bare `221`
 * there, because a mention count is small enough to read exactly.
 */
function formatCompact(n: number): string {
  return compactCount(n);
}

/**
 * New mentions arrive from a 30-minute sync (plus a manual "Sync now", whose
 * onSuccess invalidates directly), so polling three endpoints every 15s per
 * open tab bought nothing but load. 60s keeps a background tab roughly
 * current; focus/reconnect refetches are React Query defaults and still fire.
 */
const LISTENING_POLL_MS = 60_000;

function ListeningPageInner() {
  // "Keyword mentions" (listening queries) or "Comments on your posts"
  // (comment sentiment, 2026-10-05). ?view=comments is the deep link the
  // negative-comments alert opens.
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "comments" ? "comments" : "mentions";
  const showView = (next: "mentions" | "comments") => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "comments") params.set("view", "comments");
    else params.delete("view");
    const qs = params.toString();
    router.replace(`/dashboard/listening${qs ? `?${qs}` : ""}`, { scroll: false });
  };
  // Mention feed sort / minimum reach / period (2026-10-06), kept in the URL.
  const feed = parseFeedFilters(searchParams);
  const setFeed = (patch: Partial<FeedFilters>) => {
    const qs = applyFeedFilters(new URLSearchParams(searchParams.toString()), { ...feed, ...patch }).toString();
    router.replace(`/dashboard/listening${qs ? `?${qs}` : ""}`, { scroll: false });
  };
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [excludeWords, setExcludeWords] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [selectedQuery, setSelectedQuery] = useState<string | undefined>();

  const { data: queries, isLoading: queriesLoading } = trpc.listening.listQueries.useQuery(
    undefined,
    { refetchInterval: LISTENING_POLL_MS }
  );
  const { data: overview, isLoading: overviewLoading } = trpc.listening.sentimentOverview.useQuery(
    {
      queryId: selectedQuery,
      days: 30,
    },
    { refetchInterval: LISTENING_POLL_MS }
  );
  const mentionsQuery = trpc.listening.mentions.useInfiniteQuery(
    {
      queryId: selectedQuery,
      sort: feed.sort,
      minReach: feed.minReach,
      ...(feed.days !== null ? { days: feed.days } : {}),
      ...(feed.sentiment ? { sentiment: feed.sentiment } : {}),
      limit: 20,
    },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const mentionItems = mentionsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const mentionsLoading = mentionsQuery.isLoading;
  const { data: alerts } = trpc.listening.alerts.useQuery(
    {
      queryId: selectedQuery,
      unreadOnly: true,
    },
    { refetchInterval: LISTENING_POLL_MS }
  );
  const { data: sources } = trpc.listening.sourceBreakdown.useQuery({
    queryId: selectedQuery,
    days: 30,
  });

  const utils = trpc.useUtils();

  const createMutation = trpc.listening.createQuery.useMutation({
    onSuccess: () => {
      utils.listening.listQueries.invalidate();
      setDialogOpen(false);
      setName("");
      setKeywords("");
      setExcludeWords("");
      setSelectedPlatforms([]);
    },
  });

  const updateMutation = trpc.listening.updateQuery.useMutation({
    onSuccess: () => utils.listening.listQueries.invalidate(),
  });

  const deleteMutation = trpc.listening.deleteQuery.useMutation({
    onSuccess: () => {
      utils.listening.listQueries.invalidate();
      if (selectedQuery) setSelectedQuery(undefined);
    },
  });

  const syncMutation = trpc.listening.triggerSync.useMutation({
    onSuccess: () => {
      utils.listening.mentions.invalidate();
      utils.listening.sentimentOverview.invalidate();
      // SL-1: the per-query tab badge reads q._count.mentions from listQueries,
      // so it must be refetched after a sync brings in new mentions — otherwise
      // the badge stays stale (shows the old count) until a manual page refresh.
      utils.listening.listQueries.invalidate();
    },
  });

  const markAlertRead = trpc.listening.markAlertRead.useMutation({
    onSuccess: () => utils.listening.alerts.invalidate(),
  });

  const handleCreate = () => {
    createMutation.mutate({
      name,
      keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
      excludeWords: excludeWords ? excludeWords.split(",").map((w) => w.trim()).filter(Boolean) : [],
      platforms: selectedPlatforms,
    });
  };

  const togglePlatform = (id: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const sentimentPercent = (count: number) => {
    const total = overview?.total ?? 0;
    return total > 0 ? Math.round((count / total) * 100) : 0;
  };

  return (
    /* Design stacks its sections on `margin-top: 20px`, not 24px. Measured
       against the mockup, every section on this page sat exactly 4px low. */
    <div className="space-y-5">
      {/* Page header — design pattern (eyebrow, display headline, gold CTA). */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <span className="eyebrow">Social Listening</span>
          <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
            Hear what they&apos;re saying.
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Monitor brand mentions, sentiment, and competitor activity
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="pa-cta-gold h-9 shrink-0 gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold">
              <Plus className="h-3.5 w-3.5" />
              New Query
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Listening Query</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Query Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Brand Mentions, Competitor Watch"
                />
              </div>
              <div>
                <Label>Keywords to Track</Label>
                <Input
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="brand name, product, @handle (comma separated)"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Enter brand names, product names, or handles to monitor
                </p>
              </div>
              <div>
                <Label>Exclude Words (optional)</Label>
                <Input
                  value={excludeWords}
                  onChange={(e) => setExcludeWords(e.target.value)}
                  placeholder="spam, sale (comma separated)"
                />
              </div>
              <div>
                <Label>Platforms to Monitor</Label>
                <p className="mb-2 text-xs text-muted-foreground">
                  Select platforms to search. Leave empty to search all.
                </p>
                <div className="flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => togglePlatform(p.id)}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                        selectedPlatforms.includes(p.id)
                          ? "border-foreground/20 bg-foreground/[0.08] text-foreground"
                          : "border-border/40 text-muted-foreground hover:border-border/60"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <Button
                onClick={handleCreate}
                disabled={!name || !keywords || createMutation.isPending}
                className="w-full"
              >
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Query
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex w-fit gap-1 rounded-[11px] border border-border bg-surface1 p-1" role="tablist" aria-label="Listening view">
        {(
          [
            ["mentions", "Keyword mentions"],
            ["comments", "Comments on your posts"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => showView(id)}
            className={`flex h-8 items-center whitespace-nowrap rounded-[8px] px-3.5 text-[12px] transition-colors ${
              view === id
                ? "pa-gold-glow bg-gold font-semibold text-[hsl(var(--gold-foreground))]"
                : "font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
            }`}
            data-testid={`listening-view-${id}`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "comments" ? (
        <CommentSentimentPanel />
      ) : (
      <>
      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.65] text-muted-foreground">
          <b className="text-foreground">How Listening works:</b> create a query of keywords and
          optionally pick platforms. The system polls those sources every 30 minutes, saves matching
          mentions, and scores each one’s sentiment. Click <b className="text-foreground">Sync Now</b>{" "}
          to fetch immediately.
          <span className="mt-1 block text-[11px] leading-[1.6] text-faint">
            Google News, Bing News, GDELT, Hacker News, Bluesky, Mastodon and Lemmy work out of the box —
            they are public and need no account (Mastodon follows your keywords as hashtags). Twitter/X, Reddit, TikTok and Instagram/LinkedIn only
            return mentions when their API keys are configured (or, for IG/LinkedIn, a channel is
            connected) — otherwise those sources are simply skipped. Facebook has no keyword search:
            the Facebook source lists public posts that tag one of your connected Pages (when a keyword
            matches the post or the Page name), a rotating batch of Pages per sync. Reddit also reads the
            comments on the most-discussed matching posts. YouTube finds videos from the last 7 days and
            their comments; it needs a connected YouTube channel, and runs about every 6 hours per query
            (or when you click Sync Now) within a daily YouTube API budget. A comment counts when it names
            a keyword or sits under a post or video whose title does.
          </span>
        </p>
      </div>

      {/* Alerts Banner — design: a gold-keyed surface-1 panel, not an amber
          alert box. Rows are separated by a faint gold rule rather than each
          sitting in its own container. */}
      {alerts && alerts.length > 0 && (
        <div className="rounded-[12px] border border-border bg-surface1 px-[18px] py-4">
          <div className="flex items-center gap-[7px] text-[12.5px] font-semibold leading-none text-gold">
            <Bell className="h-3.5 w-3.5" />
            {alerts.length} Unread Alert{alerts.length > 1 ? "s" : ""}
          </div>
          <div className="mt-3 flex flex-col">
            {alerts.slice(0, 3).map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between gap-4 border-t border-[rgba(201,163,86,0.18)] py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold leading-[1.4]">{alert.title}</p>
                  <p className="mt-1 text-[11.5px] leading-[1.55] text-muted-foreground">
                    {alert.description.slice(0, 120)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 rounded-[7px] px-3 text-[11px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
                  disabled={markAlertRead.isPending && markAlertRead.variables?.id === alert.id}
                  onClick={() => markAlertRead.mutate({ id: alert.id })}
                >
                  {markAlertRead.isPending && markAlertRead.variables?.id === alert.id && (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  )}
                  Dismiss
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Query Tabs — design: one segmented pill row on a surface-1 track, gold
          fill + halo on the active pill (the app had loose outline buttons). */}
      {queries && queries.length > 0 && (
        <div className="flex flex-wrap gap-1 rounded-[11px] border border-border bg-surface1 p-1">
          <button
            type="button"
            aria-pressed={!selectedQuery}
            onClick={() => setSelectedQuery(undefined)}
            className={`flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] px-3.5 text-[12px] transition-colors ${
              !selectedQuery
                ? "pa-gold-glow bg-gold font-semibold text-[hsl(var(--gold-foreground))]"
                : "font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
            }`}
          >
            All Queries
          </button>
          {queries.map((q) => {
            const on = selectedQuery === q.id;
            return (
              <button
                key={q.id}
                type="button"
                aria-pressed={on}
                onClick={() => setSelectedQuery(q.id)}
                className={`flex h-8 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-[8px] px-[13px] text-[12px] transition-colors ${
                  on
                    ? "pa-gold-glow bg-gold font-semibold text-[hsl(var(--gold-foreground))]"
                    : "font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
                }`}
              >
                {q.name}
                <span
                  className={`rounded-full px-1.5 py-px text-[10px] font-semibold leading-[1.5] ${
                    on ? "bg-[rgba(26,23,18,0.25)] text-[hsl(var(--gold-foreground))]" : "bg-tile text-muted-foreground"
                  }`}
                >
                  {q._count.mentions}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Sentiment Overview — design: 3px accent rail + tinted icon tile. */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Total Mentions", value: overview?.total ?? 0, icon: MessageCircle, color: "#5b9bd5", tint: "rgba(91,155,213,0.12)" },
          { title: "Total Reach", value: formatCompact(overview?.totalReach ?? 0), icon: Users, color: "hsl(var(--accent-gold))", tint: "hsl(var(--accent-gold) / 0.12)" },
          { title: "Avg Sentiment", value: formatSentimentScore(overview?.avgSentimentScore ?? 0), icon: TrendingUp, color: "#5cb85c", tint: "rgba(92,184,92,0.12)" },
          { title: "Total Engagements", value: formatCompact(overview?.totalEngagements ?? 0), icon: TrendingUp, color: "#e0b84a", tint: "rgba(224,184,74,0.12)" },
        ].map((stat) => (
          <div
            key={stat.title}
            className="relative overflow-hidden rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]"
          >
            <span
              className="absolute left-0 top-0 h-full w-[3px]"
              style={{ background: stat.color }}
            />
            <div className="flex items-start justify-between gap-2.5">
              <span className="max-w-[110px] text-[11px] font-medium leading-[1.4] text-muted-foreground">
                {stat.title}
              </span>
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
                style={{ background: stat.tint }}
              >
                <stat.icon className="h-[15px] w-[15px] shrink-0" style={{ color: stat.color }} />
              </div>
            </div>
            {overviewLoading ? (
              <Skeleton className="mt-2.5 h-[26px] w-20" />
            ) : (
              <div className="mt-2.5 text-[26px] font-bold leading-none tracking-[-0.01em]">
                {stat.value}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Sentiment Breakdown Bar.
          Design keeps this card on the page ALWAYS. It used to be gated on
          `overview.total > 0`, so a query with no mentions in the window made
          the whole card vanish and the page collapse — the sections below it
          jumped up and the layout stopped matching the design. With zero
          mentions the bar simply shows its empty tile track and the legend
          reads 0%, which is the honest state, not a missing one. */}
      {(
        <div className="rounded-[14px] border border-border bg-card p-[22px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]">
          <h2 className="text-[14px] font-medium leading-[1.2] text-muted-foreground">
            Sentiment Distribution
          </h2>
          {/* The track carries `bg-tile`, so a partially-classified set leaves a
              neutral remainder rather than a white gap. */}
          <div className="mt-3.5 flex h-3.5 w-full overflow-hidden rounded-full bg-tile">
            {SENTIMENT_BAR.map((s) => (
              <div
                key={s.key}
                className="h-full transition-all"
                style={{
                  width: `${sentimentPercent(overview?.[s.key] ?? 0)}%`,
                  background: s.color,
                }}
              />
            ))}
          </div>
          {/* Each legend item filters the mentions below to that sentiment
              (click again to clear) — the same filter as the chips there. */}
          <div className="mt-3.5 flex flex-wrap items-center gap-2 text-[12px] leading-none text-muted-foreground">
            {SENTIMENT_BAR.map((s) => {
              const active = feed.sentiment === s.value;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFeed({ sentiment: active ? null : s.value })}
                  title={active ? "Show all mentions" : `Show only ${s.label.toLowerCase()} mentions`}
                  className={
                    active
                      ? "flex items-center gap-[7px] rounded-full border border-border2 bg-surface1 px-2.5 py-1.5 font-semibold text-foreground"
                      : "flex items-center gap-[7px] rounded-full border border-transparent px-2.5 py-1.5 hover:bg-hover hover:text-foreground"
                  }
                  data-testid={`sentiment-legend-${s.key}`}
                >
                  <span className="h-[9px] w-[9px] rounded-full" style={{ background: s.color }} />
                  {s.label} {sentimentPercent(overview?.[s.key] ?? 0)}%
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Design: a 2fr / 1fr split with both columns top-aligned. */}
      <div className="grid items-start gap-5 lg:grid-cols-3">
        {/* Recent Mentions */}
        <div className="lg:col-span-2">
          {/* Fixed-height header row so this column's box lines up with the
              sidebar's, in both the with- and without-"Sync Now" states. */}
          <div className="mb-2.5 flex h-8 items-center justify-between">
            <h2 className="text-[12.5px] font-semibold uppercase leading-none tracking-[0.06em] text-muted-foreground">
              {feed.sort === "reach" ? "Top Mentions by Reach" : "Recent Mentions"}
            </h2>
            {/* The design keeps Sync Now in this header at all times, so the row
                never changes shape between the All-Queries and per-query views.
                It only ACTS on a single query, though — `listening.triggerSync`
                requires a queryId and enqueues one job — so on All Queries it
                renders disabled with the reason, rather than being hidden (a
                control that appears and disappears) or lying about what it can
                do. Making it sync every query is a backend change; not made. */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 rounded-[7px] px-2.5 text-[11.5px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-40"
              title={
                selectedQuery
                  ? "Fetch new mentions for this query now"
                  : "Pick a query above to sync it"
              }
              onClick={() =>
                selectedQuery && syncMutation.mutate({ queryId: selectedQuery })
              }
              disabled={!selectedQuery || syncMutation.isPending}
            >
              {syncMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Sync Now
            </Button>
          </div>
          {/* Sort / minimum reach / period (2026-10-06). */}
          <div className="mb-2.5 flex flex-wrap items-center gap-2" data-testid="mention-filters">
            <div className="flex rounded-[9px] border border-border bg-surface1 p-0.5" role="group" aria-label="Sort mentions">
              {(
                [
                  { id: "recent", label: "Newest" },
                  { id: "reach", label: "Most reach" },
                ] as const
              ).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={feed.sort === o.id}
                  onClick={() => setFeed({ sort: o.id })}
                  className={
                    feed.sort === o.id
                      ? "h-7 rounded-[7px] bg-card px-3 text-[12px] font-semibold text-foreground shadow-sm"
                      : "h-7 rounded-[7px] px-3 text-[12px] text-muted-foreground hover:text-foreground"
                  }
                  data-testid={`mention-sort-${o.id}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <select
              value={feed.minReach}
              onChange={(e) => setFeed({ minReach: Number(e.target.value) })}
              className="h-8 rounded-[9px] border border-border bg-card px-2 text-[12px]"
              aria-label="Minimum reach"
              data-testid="mention-min-reach"
            >
              {MIN_REACH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              value={feed.days ?? ""}
              onChange={(e) => setFeed({ days: e.target.value ? Number(e.target.value) : null })}
              className="h-8 rounded-[9px] border border-border bg-card px-2 text-[12px]"
              aria-label="Period"
              data-testid="mention-period"
            >
              {PERIOD_OPTIONS.map((o) => (
                <option key={o.label} value={o.value ?? ""}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="flex w-full flex-wrap rounded-[9px] border border-border bg-surface1 p-0.5 sm:w-auto" role="group" aria-label="Sentiment">
              {SENTIMENT_FILTER_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={feed.sentiment === o.value}
                  onClick={() => setFeed({ sentiment: o.value })}
                  className={
                    feed.sentiment === o.value
                      ? "flex h-7 items-center gap-1.5 rounded-[7px] bg-card px-2 text-[12px] font-semibold text-foreground shadow-sm sm:px-2.5"
                      : "flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12px] text-muted-foreground hover:text-foreground sm:px-2.5"
                  }
                  data-testid={`mention-sentiment-${(o.value ?? "all").toLowerCase()}`}
                >
                  {o.value && <span className="h-2 w-2 rounded-full" style={{ background: SENTIMENT_DOT[o.value] }} />}
                  {o.label}
                </button>
              ))}
            </div>
            {isFiltered(feed) && (
              <button
                type="button"
                onClick={() => setFeed(DEFAULT_FEED_FILTERS)}
                className="text-[11.5px] text-muted-foreground underline hover:text-foreground"
              >
                Reset
              </button>
            )}
          </div>
          {(feed.sort === "reach" || feed.minReach > 0) && (
            <p className="mb-2.5 text-[11px] leading-[1.5] text-faint" data-testid="mention-reach-note">
              Reach is what each source reports: views on YouTube and TikTok, impressions on X, upvotes on Reddit posts.
              Other sources (news, Hacker News, Bluesky, Mastodon, Lemmy, Facebook, Instagram, LinkedIn, comments) report
              none, so {feed.minReach > 0 ? "a minimum reach hides them" : "they sort last"}.
            </p>
          )}
          <div className="flex flex-col gap-2">
            {mentionsLoading ? (
              [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[78px] rounded-[12px]" />)
            ) : mentionItems.length > 0 ? (
              mentionItems.map((mention) => {
                const sent = SENTIMENT_STYLE[mention.sentiment] ?? SENTIMENT_STYLE.NEUTRAL!;
                const SentimentIcon = sent.icon;
                const tag = SOURCE_TAG[mention.source] ?? SOURCE_TAG_FALLBACK;
                return (
                  <div
                    key={mention.id}
                    className="flex items-start gap-3 rounded-[12px] border border-border bg-card p-3.5 shadow-[0_6px_14px_-10px_rgba(0,0,0,.45)] transition-colors hover:border-border2"
                  >
                    <div
                      className="mt-px flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px]"
                      style={{ background: sent.bg, color: sent.color }}
                    >
                      <SentimentIcon className="h-[13px] w-[13px]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      {commentParent(mention.metadata) && (
                        <p className="mb-1 truncate text-[11px] leading-[1.4] text-faint" data-testid="mention-comment-on">
                          Comment on{" "}
                          {commentParent(mention.metadata)!.url ? (
                            <a
                              href={commentParent(mention.metadata)!.url!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground underline hover:text-foreground"
                            >
                              “{commentParent(mention.metadata)!.title}”
                            </a>
                          ) : (
                            <span className="text-muted-foreground">“{commentParent(mention.metadata)!.title}”</span>
                          )}
                        </p>
                      )}
                      <p className="text-[12.5px] leading-[1.5]">{mention.content}</p>
                      <div className="mt-[7px] flex flex-wrap items-center gap-[9px] text-[11px] leading-none text-faint">
                        {mention.authorName && (
                          <span className="font-medium text-muted-foreground">
                            {mention.authorName}
                          </span>
                        )}
                        <span
                          className="rounded-[5px] px-[7px] py-px text-[9.5px] font-semibold leading-[1.6]"
                          style={{ background: `${tag}22`, color: tag }}
                        >
                          {mention.source}
                        </span>
                        <span>
                          {formatDistanceToNow(new Date(mention.mentionedAt), { addSuffix: true })}
                        </span>
                        {reachLabel(mention.source, mention.reach) && (
                          <span className="inline-flex items-center gap-1 font-medium text-muted-foreground" data-testid="mention-reach">
                            <Eye className="h-3 w-3" />
                            {reachLabel(mention.source, mention.reach)}
                          </span>
                        )}
                      </div>
                    </div>
                    {mention.sourceUrl && (
                      <a href={mention.sourceUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3 w-3 shrink-0 text-faint hover:text-foreground" />
                      </a>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="flex flex-col items-center rounded-[12px] border border-border bg-card px-4 py-8 text-center">
                <Ear className="mb-3 h-10 w-10 text-muted-foreground/30" />
                <p className="text-[12.5px] leading-[1.5] text-muted-foreground">
                  {isFiltered(feed)
                    ? "No mentions match these filters. Try a lower minimum reach or a longer period."
                    : queries && queries.length > 0
                      ? "No mentions found yet. Try syncing or adjusting your keywords."
                      : "Create a listening query to start monitoring mentions."}
                </p>
              </div>
            )}
            {mentionsQuery.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-[12px]"
                onClick={() => void mentionsQuery.fetchNextPage()}
                disabled={mentionsQuery.isFetchingNextPage}
                data-testid="mention-load-more"
              >
                {mentionsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )}
          </div>
        </div>

        {/* Sidebar: Sources + Queries */}
        <div className="space-y-6">
          {/* Source Breakdown — the heading sits ABOVE the card (matching
              "Recent Mentions") rather than inside a CardHeader, so the two
              columns' boxes start at the same y instead of being offset by the
              height of the heading. */}
          {/* Design keeps this card on the page ALWAYS. It used to be gated on
              `sources.length > 0`, so an empty query dropped the whole Sources
              column and "Your Queries" slid up into its place — the sidebar
              stopped matching the design exactly when the page had least to
              show. An empty card that says so is the honest state. */}
          <div>
            <h2 className="mb-2.5 flex h-8 items-center text-[12.5px] font-semibold uppercase leading-none tracking-[0.06em] text-muted-foreground">
              Sources
            </h2>
            <div className="flex flex-col gap-[11px] rounded-[14px] border border-border bg-card p-4 shadow-[0_6px_14px_-10px_rgba(0,0,0,.4)]">
              {sources && sources.length > 0 ? (
                sources.map((s) => (
                  <div key={s.source} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[12.5px] leading-none">
                      {SOURCE_LABEL[s.source] ?? s.source}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[12.5px] font-semibold leading-none">{s.count}</span>
                      <span className="text-[10px] leading-none text-faint">
                        {formatCompact(s.reach)} reach
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <p className="py-2 text-center text-[12px] leading-[1.5] text-muted-foreground">
                  No mentions in this range yet
                </p>
              )}
            </div>
          </div>

          {/* Listening Queries — same heading-above-card pattern as above. */}
          <div>
            <h2 className="mb-2.5 flex h-8 items-center text-[12.5px] font-semibold uppercase leading-none tracking-[0.06em] text-muted-foreground">
              Your Queries
            </h2>
            <div className="flex flex-col gap-1.5 rounded-[14px] border border-border bg-card p-2.5 shadow-[0_6px_14px_-10px_rgba(0,0,0,.4)]">
              {queriesLoading ? (
                [1, 2].map((i) => <Skeleton key={i} className="h-[52px] rounded-[9px]" />)
              ) : queries && queries.length > 0 ? (
                queries.map((q) => (
                  <div
                    key={q.id}
                    className="flex items-center justify-between gap-2.5 rounded-[9px] border border-border px-3 py-2.5 transition-colors hover:border-border2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium leading-[1.3]">{q.name}</p>
                      <p className="mt-[3px] truncate text-[10.5px] leading-[1.3] text-faint">
                        {q.keywords.slice(0, 3).join(", ")}
                        {q._count.mentions > 0 && ` · ${q._count.mentions} mentions`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={q.isActive ? `Pause ${q.name}` : `Activate ${q.name}`}
                        className="h-6 w-6 rounded-[6px] hover:bg-hover"
                        disabled={updateMutation.isPending && updateMutation.variables?.id === q.id}
                        onClick={() =>
                          updateMutation.mutate({ id: q.id, isActive: !q.isActive })
                        }
                      >
                        {updateMutation.isPending && updateMutation.variables?.id === q.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : q.isActive ? (
                          <Power className="h-3 w-3 text-[#5cb85c]" />
                        ) : (
                          <PowerOff className="h-3 w-3 text-muted-foreground" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${q.name}`}
                        className="h-6 w-6 rounded-[6px] text-faint hover:bg-hover hover:text-[#c96b56]"
                        disabled={deleteMutation.isPending && deleteMutation.variables?.id === q.id}
                        onClick={() => {
                          if (confirm("Delete this query and all its mentions?")) {
                            deleteMutation.mutate({ id: q.id });
                          }
                        }}
                      >
                        {deleteMutation.isPending && deleteMutation.variables?.id === q.id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Trash2 className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="py-4 text-center text-[12.5px] text-muted-foreground">
                  No queries yet
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function ListeningPage() {
  return (
    <RequireAppAdmin>
      {/* useSearchParams needs a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <ListeningPageInner />
      </Suspense>
    </RequireAppAdmin>
  );
}
