"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ReportsTab } from "~/components/analytics/ReportsTab";
import { PlatformPerformanceRadar } from "~/components/analytics/PlatformPerformanceRadar";
import { ChannelAvatar } from "~/components/channel-avatar";
import { trpc } from "~/lib/trpc/client";
import { useToast } from "~/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  BarChart3, TrendingUp, CheckCircle, XCircle, Heart, MessageCircle,
  Share, Users, Percent, Calendar, RefreshCw, AlertTriangle, PlayCircle,
} from "lucide-react";
import { format, subDays } from "date-fns";
import {
  metricCellValue,
  likeColumnLabel,
  engagementRateCell,
  type MetricKey,
  type MetricRowMeta,
} from "~/lib/metric-cell";
import { deriveInsightsEmptyState } from "~/lib/insights-empty-state";

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

/** Formats a metric cell honestly: "—" when the metric isn't real, else the number. */
function metricCell(key: MetricKey, value: number, meta: MetricRowMeta): string {
  const v = metricCellValue(key, value, meta);
  return v === null ? "—" : formatNumber(v);
}

const PLATFORM_COLORS: Record<string, string> = {
  TWITTER: "#1DA1F2",
  INSTAGRAM: "#E1306C",
  FACEBOOK: "#1877F2",
  LINKEDIN: "#0A66C2",
  YOUTUBE: "#FF0000",
  TIKTOK: "#010101",
  THREADS: "#000000",
  REDDIT: "#FF4500",
  PINTEREST: "#E60023",
  TELEGRAM: "#2CA5E0",
  DISCORD: "#5865F2",
  BLUESKY: "#0085FF",
  DEFAULT: "#8B5CF6",
};

/** The design's donut palette, assigned by slice rank (largest share first). */
const DONUT_PALETTE = [
  "#38bdf8", "#ec4899", "#a78bfa", "#4ade80",
  "#fb923c", "#C9A356", "#f87171", "#2dd4bf",
] as const;

function getPlatformColor(platform: string): string {
  // Literal fallback, not PLATFORM_COLORS.DEFAULT: under noUncheckedIndexedAccess
  // the indexed read is `string | undefined`, so the map can't guarantee a colour.
  return PLATFORM_COLORS[platform] ?? "#8B5CF6";
}


/** Design: platform names as people write them. The raw enum ("TWITTER") is
 *  right for the table's platform tag, but the donut legend reads as prose. */
const PLATFORM_DISPLAY: Record<string, string> = {
  TWITTER: "X (Twitter)",
  LINKEDIN: "LinkedIn",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  DEVTO: "DEV.to",
};

function platformDisplayName(platform: string): string {
  return (
    PLATFORM_DISPLAY[platform] ??
    platform.charAt(0) + platform.slice(1).toLowerCase()
  );
}

/* The mockup's header carries only the three range presets beside Sync Now.
   Our custom from/to inputs are a real control we can't drop, so they get
   their own line underneath instead of squeezing the headline column — that
   squeeze is what wrapped "Reach, likes, comments…" onto two lines. */
function RangePresets({
  from,
  onChange,
}: {
  from: string;
  onChange: (from: string, to: string) => void;
}) {
  const presets = [
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {presets.map((p) => {
        const pFrom = subDays(new Date(), p.days).toISOString();
        const pTo = new Date().toISOString();
        const active = from.startsWith(pFrom.slice(0, 10));
        return (
          <button
            key={p.label}
            onClick={() => onChange(pFrom, pTo)}
            className={`whitespace-nowrap rounded-[8px] border px-3 py-[7px] text-[11.5px] leading-none transition-all ${
              active
                ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] font-semibold text-gold"
                : "border-transparent bg-tile font-medium text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function CustomRange({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="date"
          value={from.slice(0, 10)}
          // Parse the date input as UTC midnight, not local — otherwise a UTC+5:30
          // user's "today" shifts a day and posts drop out (audit fix 2026-06-06).
          onChange={(e) => onChange(e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : from, to)}
          className="rounded-[8px] border border-border2 bg-background px-2 py-[5px] text-[11px] text-muted-foreground"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <input
          type="date"
          value={to.slice(0, 10)}
          onChange={(e) => onChange(from, e.target.value ? new Date(`${e.target.value}T23:59:59.999Z`).toISOString() : to)}
          className="rounded-[8px] border border-border2 bg-background px-2 py-[5px] text-[11px] text-muted-foreground"
        />
    </div>
  );
}

function InsightsAnalyticsView() {
  const [from, setFrom] = useState(() => subDays(new Date(), 30).toISOString());
  const [to, setTo] = useState(() => new Date().toISOString());
  const [syncing, setSyncing] = useState(false);
  /* The mockup's header carries ONLY the three presets and Sync Now. Our custom
     from/to range is a real capability we can't drop, so it hides behind a
     calendar chip: at rest the header is the mockup's, one click reveals it. */
  const [showCustomRange, setShowCustomRange] = useState(false);
  const { toast } = useToast();

  const dateInput = { from, to };
  const utils = trpc.useUtils();
  const triggerSync = trpc.analytics.triggerSync.useMutation({
    onSuccess: (data) => {
      // Sync Now refreshes the posts this workspace published through PostAutomation
      // (`queued`). `accountsQueued` is the direct-post population, which is 0 unless
      // INSIGHTS_INCLUDE_EXTERNAL_POSTS is on — so the copy is DERIVED from the counts
      // rather than asserting a population exists. Insights covers app-published posts
      // (owner decision 2026-08-19).
      const accounts = data.accountsQueued ?? 0;
      if (data.queued === 0 && accounts === 0) {
        toast({
          title: "Nothing to sync",
          description:
            "This workspace has no posts published through PostAutomation in the last 30 days. Insights cover posts sent through PostAutomation from this workspace — posts made directly on a platform, or in another workspace, aren't included.",
        });
        setSyncing(false);
        return;
      }
      const parts: string[] = [];
      if (data.queued > 0) parts.push(`${data.queued} post${data.queued === 1 ? "" : "s"}`);
      if (accounts > 0) parts.push(`${accounts} connected account${accounts === 1 ? "" : "s"}`);
      toast({
        title: "Analytics sync started",
        description: `Refreshing ${parts.join(" and ")}. Numbers update as each one completes.`,
      });
      // Worker jobs finish at different times; refetch a few times instead of a single
      // fixed cliff so slow syncs still surface without leaving stale data (audit #13).
      [4000, 9000, 15000, 30000, 60000].forEach((ms) =>
        setTimeout(() => { void utils.analytics.invalidate(); }, ms)
      );
      setTimeout(() => setSyncing(false), 4000);
    },
    onError: () => {
      toast({ title: "Sync failed", description: "Could not queue analytics sync.", variant: "destructive" });
      setSyncing(false);
    },
  });

  // Per-platform Insights view. `null` = All. Validated against the platforms
  // this org actually has before it is applied (see platformFilter below), so a
  // stale URL param or a channel disconnect can never strand the table empty.
  const [platformView, setPlatformView] = useState<string | null>(null);
  const { data: orgPlatforms } = trpc.analytics.platformsInWindow.useQuery();

  // ⚠️ Fall back to All for an unknown platform rather than returning nothing.
  // filterByPlatform's contract yields an empty list for an unknown platform —
  // right for a channel PICKER (showing everything would select unintended
  // channels) but wrong here, where an unexplained empty table reads as a bug.
  const platformFilter =
    platformView && (orgPlatforms ?? []).includes(platformView) ? platformView : undefined;

  const dateInputWithPlatform = { ...dateInput, platform: platformFilter };

  const { data: overview, isLoading: overviewLoading } = trpc.analytics.overview.useQuery(dateInput);
  // placeholderData on the platform-aware queries: a new `platform` in the key is
  // a NEW query, so without it every pill click collapses the table to skeletons.
  const { data: engagement, isLoading: engagementLoading } = trpc.analytics.engagement.useQuery(
    dateInputWithPlatform,
    { placeholderData: (prev) => prev }
  );
  const { data: platformBreakdown, isLoading: breakdownLoading } = trpc.analytics.platformBreakdown.useQuery(dateInput);
  const { data: postsOverTime, isLoading: chartLoading } = trpc.analytics.postsOverTime.useQuery(dateInput);
  const { data: channelStats, isLoading: channelLoading } = trpc.analytics.perChannelStats.useQuery(
    dateInputWithPlatform,
    { placeholderData: (prev) => prev }
  );
  // Unfiltered copy, used ONLY for org-wide statements ("connected but nothing
  // synced yet") that must not change meaning when a platform view is selected.
  // Same key as the All view, so it is a cache hit whenever no pill is active.
  const { data: unfilteredChannelStats } = trpc.analytics.perChannelStats.useQuery(dateInput);
  // keepPreviousData so a date-range change doesn't unmount the Group
  // Performance card mid-refetch (which would cause layout shift on every
  // range change for group-having orgs).
  const { data: groupStats, isLoading: groupLoading } = trpc.analytics.groupStats.useQuery(
    dateInput,
    { placeholderData: (prev) => prev }
  );
  // Which channels can't report Insights until reconnected. Not date-scoped —
  // it's a property of the channel's stored token, not of the selected range.
  const { data: health } = trpc.analytics.insightsHealth.useQuery();
  // Channels whose problem is the GRANT, not the credential: either the platform
  // account was left out of the last consent, or access to that one account
  // changed while the same login keeps working elsewhere. They need different
  // advice — "reconnect" alone is what the owner already tried, because the
  // reconnect never reaches a channel the consent did not include.
  const grantAffected =
    health?.channels.filter(
      (c) =>
        c.status === "needs_reconnect" &&
        (c.reason === "not_in_latest_grant" || c.reason === "page_access_lost")
    ) ?? [];

  const reportableStat = new Set(engagement?.reportableMetrics ?? []);
  const statReportable = (key: string) => reportableStat.size === 0 || reportableStat.has(key as any);
  const stats: Array<{ name: string; value: number; icon: any; color: string; format?: boolean; sub?: string; title?: string }> = [
    // ⚠️ These two cards count DIFFERENT things and were reported as a bug because
    // the labels never said so: one post sent to two channels shows as "3" here and
    // "4" below, which reads as arithmetic that does not add up. A post is what you
    // compose; a delivery is one copy of it arriving on one channel. Every other
    // number on this page (impressions, likes, reach) is per DELIVERY, so the
    // deliveries card is the one that reconciles with the table.
    {
      name: "Total Posts",
      value: overview?.totalPosts ?? 0,
      icon: BarChart3,
      color: "bg-[rgba(59,130,246,0.12)] text-[#60a5fa]",
      sub: overview && overview.published > overview.totalPosts
        ? `sent to ${overview.published} channel${overview.published === 1 ? "" : "s"}`
        : undefined,
      title: "Posts you composed in this date range. A post sent to several channels still counts once here.",
    },
    {
      name: "Published Targets",
      value: overview?.published ?? 0,
      icon: CheckCircle,
      color: "bg-[rgba(34,197,94,0.12)] text-[#4ade80]",
      sub: overview
        ? `from ${overview.totalPosts} post${overview.totalPosts === 1 ? "" : "s"}`
        : undefined,
      title: "Successful deliveries — one per channel a post reached. A post sent to 2 channels counts twice, which is why this can exceed Total Posts.",
    },
    { name: "Failed", value: overview?.failed ?? 0, icon: XCircle, color: "bg-[rgba(239,68,68,0.12)] text-[#f87171]" },
    // "Total Reach: 0" is actively misleading on an org whose platforms can't
    // report reach at all — swap in a metric that CAN be populated.
    // ⚠️ NOT "Total Reach": this is a sum of per-post reach, so it double-counts
    // anyone who saw more than one post. Naming it "Total Reach" would assert a
    // deduplicated audience size we cannot compute from per-post metrics.
    //
    // ⚠️ The views rung must come BEFORE the impressions one. This card used to
    // read `engagement.impressions` under the label "Total Views" — correct only
    // where the two are the same number, and wrong by 3.45x on Facebook (plays vs
    // qualified views) and wrong outright on Twitter/LinkedIn (genuine
    // impressions, no view count). Now each label names the field it sums.
    ...(statReportable("reach")
      ? [{ name: "Reach (summed)", value: engagement?.reach ?? 0, icon: TrendingUp, color: "bg-gold/[0.12] text-gold", format: true }]
      : statReportable("views")
        ? [{ name: "Total Views", value: engagement?.views ?? 0, icon: TrendingUp, color: "bg-gold/[0.12] text-gold", format: true }]
        : statReportable("impressions")
          ? [{ name: "Total Impressions", value: engagement?.impressions ?? 0, icon: TrendingUp, color: "bg-gold/[0.12] text-gold", format: true }]
          : [{ name: "Total Engagement", value: (engagement?.likes ?? 0) + (engagement?.comments ?? 0) + (engagement?.shares ?? 0), icon: TrendingUp, color: "bg-gold/[0.12] text-gold", format: true }]),
  ];

  // Only tile metrics that SOME connected platform can actually report. A metric
  // no channel can ever populate isn't a "0" and isn't even worth a "—" tile —
  // it's dead furniture that reads as "this product is broken", so the tile is
  // dropped rather than showing 0.
  //
  // NOTE (2026-08-11): this used to say an FB-only org "can never" have
  // Impressions or Reach because Meta deleted the Page-post metrics. Meta RENAMED
  // them (post_media_view / post_total_media_view_unique) and they work on the
  // already-approved scopes, so Facebook DOES populate both once captures carry
  // the new declaration. The gate below is still correct — it is driven by
  // per-capture capability, not by a hardcoded platform assumption.
  const reportable = new Set(engagement?.reportableMetrics ?? []);
  const canReport = (key: string) => reportable.size === 0 || reportable.has(key as any);
  /*
   * The design's Engagement Breakdown is exactly four tiles — Views, Likes,
   * Comments, Shares — in a 2x2, with Engagement Rate as the block beneath.
   * Impressions, Clicks and a summed-Reach tile were dropped to match it (owner
   * decision). None of that data is lost: every one of them is still a column in
   * Channel Performance, and Reach also has its own stat card at the top.
   */
  const engagementMetrics = [
    { key: "views", label: "Views", value: engagement?.views ?? 0, icon: PlayCircle, color: "text-[#38bdf8]" },
    { key: "likes", label: "Likes", value: engagement?.likes ?? 0, icon: Heart, color: "text-[#f87171]" },
    { key: "comments", label: "Comments", value: engagement?.comments ?? 0, icon: MessageCircle, color: "text-[#4ade80]" },
    { key: "shares", label: "Shares", value: engagement?.shares ?? 0, icon: Share, color: "text-gold" },
  ].filter((m) => canReport(m.key));

  // Compress chart data if more than 30 points
  const chartData = (postsOverTime ?? []).map((d) => ({
    ...d,
    label: format(new Date(d.date), "MMM d"),
  }));

  // Columns worth rendering: a metric that EVERY visible channel marks
  // unavailable can never hold a number, so the column is dropped instead of
  // showing a full column of "—". Derived from the per-row `unavailable` list the
  // server computes (static platform map ∪ per-capture overrides), so a Facebook
  // channel that posted a video keeps its Impressions column while a
  // feed-only Facebook org loses it. Falls back to showing everything while the
  // query is still loading so the header doesn't jump.
  const CHANNEL_METRIC_COLUMNS: Array<{ key: MetricKey; valueKey: string; label: string }> = [
    { key: "impressions", valueKey: "impressions", label: "Impressions" },
    // Summed across the channel's posts — see the engagementMetrics note above.
    { key: "reach", valueKey: "reach", label: "Reach (summed)" },
    // ⚠️ Views is NOT a duplicate of Impressions. On Facebook the two are
    // genuinely different numbers (post_media_view = renders/plays vs
    // post_video_views = qualified views; 5,063 vs 1,468 on one reel). On
    // Instagram / YouTube / Threads / dev.to / Reddit there IS no impressions
    // metric — those platforms declare impressions unavailable, so this column
    // replaces it rather than sitting beside it.
    { key: "views", valueKey: "views", label: "Views" },
    { key: "likes", valueKey: "likes", label: "Likes" },
    { key: "comments", valueKey: "comments", label: "Comments" },
    { key: "shares", valueKey: "shares", label: "Shares" },
    { key: "clicks", valueKey: "clicks", label: "Clicks" },
  ];
  const channelColumns = !channelStats?.length
    ? CHANNEL_METRIC_COLUMNS
    : CHANNEL_METRIC_COLUMNS.filter((c) =>
        channelStats.some((ch: any) => !(ch.unavailable ?? []).includes(c.key))
      );

  // Same capability-driven column filtering for Group Performance. Before this,
  // the group table rendered every metric as a raw formatNumber() sum with no
  // honesty gate — so an FB-only group showed "Reach 0" while the Channel
  // Performance table one card above showed "—" for the same underlying data.
  const groupRows = groupStats?.rows ?? [];
  const groupColumns = !groupRows.length
    ? CHANNEL_METRIC_COLUMNS
    : CHANNEL_METRIC_COLUMNS.filter((c) =>
        groupRows.some((g: any) => !(g.unavailable ?? []).includes(c.key))
      );

  /**
   * The "Likes" column means different things per platform — Facebook reports
   * ALL reaction types, Pinterest saves, Reddit upvotes. The API already ships
   * `likeKind` per row and `likeColumnLabel` already maps it, but the header was
   * hardcoded "Likes". With 975 of this deployment's channels on Facebook, that
   * mislabels the most common case. Only relabel when every visible channel
   * agrees; a mixed table keeps the neutral "Likes".
   */
  const likeKinds = new Set((channelStats ?? []).map((ch: any) => ch.likeKind).filter(Boolean));
  const likeHeader =
    likeKinds.size === 1 ? likeColumnLabel(likeKinds.values().next().value as string) : { label: "Likes" };

  /**
   * Does this page include posts made DIRECTLY on a platform?
   *
   * No, by default — Insights covers posts published through PostAutomation, end to
   * end (owner decision 2026-08-19). The server answers this rather than the client
   * inferring it, so every string below is driven by one authoritative flag instead
   * of guessing from whether some other field happens to be present.
   */
  const includesDirectPosts = engagement?.includesDirectPosts === true;

  /**
   * Direct-post coverage floor — only meaningful while direct posts ARE included.
   * The server returns these as undefined otherwise, so the notice disappears with
   * the population it describes rather than asserting a start date for data the page
   * no longer shows.
   */
  // ⚠️ The floor is CONFIGURABLE server-side (EXTERNAL_POST_FLOOR) — it was
  // hardcoded here and in five other strings on this page until 2026-08-18. The
  // server now returns the ACTIVE label so lowering the floor cannot leave this
  // copy asserting a start date that is no longer true.
  // ⚠️ BOTH halves come from the server. Deriving only the LABEL from config while
  // the gate kept a hardcoded date meant a lowered floor made the notice fire on
  // ranges it had just started covering. Until the query resolves there is no
  // floor to compare against, so the notice stays hidden rather than guessing.
  const directFloorLabel = engagement?.externalFloorLabel;
  const directFloorIso = engagement?.externalFloorIso;
  const rangeStartsBeforeFloor =
    includesDirectPosts && !!directFloorIso && new Date(from) < new Date(directFloorIso);
  const hasMetaChannel = (channelStats ?? []).some(
    (ch: any) => ch.platform === "FACEBOOK" || ch.platform === "INSTAGRAM"
  );

  // Channels are connected but no engagement has synced yet — distinct from
  // "no channels connected" so we don't imply zero performance (audit fix 2026-06-06).
  // ⚠️ Computed over the UNFILTERED stats. Deriving it from the platform-filtered
  // rows would flash "connected but nothing synced yet" across a healthy org the
  // moment someone views a quiet platform — a false statement about the org.
  //
  // ⚠️ TWO states, not one. "No engagement synced yet — try Sync Now" is only true
  // when a capture is outstanding. With Insights covering app-published posts, a
  // workspace that posts mainly DIRECTLY on the platform has nothing pending, so
  // that advice can never succeed. See insights-empty-state.ts.
  // `publishedAllTime` lets the empty state distinguish "never published through us"
  // from "published, but not in THIS range" — opposite advice, and the second is the
  // common case now that the window no longer gets filled by direct posts.
  const emptyState = deriveInsightsEmptyState(
    unfilteredChannelStats as any,
    includesDirectPosts,
    overview?.publishedAllTime ?? 0
  );

  // Engagement Breakdown all-zeros hint (mirrors the Channel Performance
  // empty-state convention) — display-only, tile data logic untouched.
  const engagementAllZero =
    !!engagement && engagementMetrics.every((m) => m.value === 0);

  // Donut legend/center-stat inputs. The legend is contained HTML below the
  // plot (never clipped outside labels); percent shares are derived here.
  const platformTotal = (platformBreakdown ?? []).reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <span className="eyebrow">Insights</span>
          <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
            See what&apos;s working.
          </h1>
          <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground">
            Reach, likes, comments, and shares across your channels
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <RangePresets
            from={from}
            onChange={(f, t) => { setFrom(f); setTo(t); }}
          />
          <button
            type="button"
            aria-pressed={showCustomRange}
            aria-label="Custom date range"
            title="Custom date range"
            onClick={() => setShowCustomRange((v) => !v)}
            className={`flex items-center rounded-[8px] border px-2.5 py-[7px] leading-none transition-all ${
              showCustomRange
                ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] text-gold"
                : "border-transparent bg-tile text-muted-foreground hover:text-foreground"
            }`}
          >
            <Calendar className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => { setSyncing(true); triggerSync.mutate(); }}
            disabled={syncing}
            className="pa-cta-gold flex h-9 items-center gap-[7px] rounded-[9px] px-3.5 text-[12px] font-semibold disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync Now"}
          </button>
          </div>
          {showCustomRange && (
            <CustomRange
              from={from}
              to={to}
              onChange={(f, t) => { setFrom(f); setTo(t); }}
            />
          )}
        </div>
      </div>

      {/* Reconnect banner. A Meta App Review approval does NOT add scopes to
          tokens that were already issued — scopes are granted only at consent
          time — so channels connected before approval keep reporting nothing
          until their owner reconnects once. Without this, a dead/under-scoped
          token is indistinguishable from genuinely zero engagement. */}
      {health && (health.needsReconnectCount > 0 || health.expiringSoonCount > 0) && (
        /* Design: the notice is a surface-1 card in the gold accent, not an
           amber alert box — amber is off-palette here and read as a third
           colour on a page that only uses gold + status tints. */
        <div className="rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-2.5">
              <AlertTriangle className="h-[15px] w-[15px] shrink-0 text-gold" />
              <div className="min-w-0">
                {health.needsReconnectCount > 0 ? (
                  <>
                    <p className="text-[12.5px] font-medium leading-[1.3] text-gold">
                      {health.needsReconnectCount} channel{health.needsReconnectCount === 1 ? "" : "s"} need
                      {health.needsReconnectCount === 1 ? "s" : ""} reconnecting to report Insights
                    </p>
                    <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-foreground">
                      The platform is refusing to return metrics for{" "}
                      {health.needsReconnectCount === 1 ? "this channel" : "these channels"}. Posting
                      still works; only metrics are affected.
                      {grantAffected.length < health.needsReconnectCount && (
                        <>
                          {" "}Usually the access token was rejected or the 90-day data-access window
                          closed — reconnecting takes a few seconds.
                        </>
                      )}
                      {health.missingScopes.length > 0 && (
                        <>
                          {" "}Missing permission{health.missingScopes.length === 1 ? "" : "s"}:{" "}
                          <span className="font-mono">{health.missingScopes.join(", ")}</span>.
                        </>
                      )}
                    </p>
                    {/* A channel left out of the last consent is never visited by
                        the reconnect upsert, so it survives every reconnect. Saying
                        "reconnect" without saying "and tick this one" is the exact
                        advice that failed the owner repeatedly. */}
                    {grantAffected.length > 0 && (
                      <p className="mt-1.5 text-[11.5px] font-medium leading-[1.5] text-gold">
                        {grantAffected.length === health.needsReconnectCount
                          ? grantAffected.length === 1
                            ? "This channel was"
                            : "These channels were"
                          : `${grantAffected.length} of them ${grantAffected.length === 1 ? "was" : "were"}`}{" "}
                        not included in your most recent connection, so reconnecting again the same
                        way will not fix{" "}
                        {grantAffected.length === 1 ? "it" : "them"}. Reconnect, choose{" "}
                        <span className="font-semibold">Edit settings</span>, and tick{" "}
                        {grantAffected.length === 1 ? "it" : "them"} in the list. If{" "}
                        {grantAffected.length === 1 ? "it is" : "they are"} not listed, the account is
                        no longer available to the profile you connect with — pause or disconnect{" "}
                        {grantAffected.length === 1 ? "it" : "them"} to clear this notice.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {/* Meta closes a 90-day DATA-ACCESS window that is separate from
                        token expiry, and a background refresh provably cannot extend
                        it — only the owner reconnecting resets it. So warning ahead of
                        the deadline is the only thing that actually prevents the
                        outage, which is why this gets a banner of its own. */}
                    <p className="text-[12.5px] font-medium leading-[1.3] text-gold">
                      {health.expiringSoonCount} channel{health.expiringSoonCount === 1 ? "" : "s"} will stop
                      reporting Insights soon
                    </p>
                    <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-foreground">
                      Meta closes a 90-day data-access window per connection. Reconnect before it
                      lapses to keep metrics flowing — a background refresh cannot extend it. Posting
                      is unaffected either way.
                    </p>
                  </>
                )}
                {health.channels.length > 0 && (
                  <p className="mt-1.5 truncate text-[11px] leading-none text-faint">
                    {health.channels
                      .slice(0, 6)
                      .map((c) =>
                        c.daysUntilDataAccessExpiry != null && c.status === "expiring_soon"
                          ? `${c.name} (${c.daysUntilDataAccessExpiry}d)`
                          : c.name
                      )
                      .join(", ")}
                    {health.needsReconnectCount + health.expiringSoonCount > 6 &&
                      ` and ${health.needsReconnectCount + health.expiringSoonCount - 6} more`}
                  </p>
                )}
              </div>
            </div>
            <Link
              href="/dashboard/channels"
              className="flex h-7 shrink-0 items-center self-start whitespace-nowrap rounded-[8px] bg-gold px-3 text-[11px] font-semibold text-[hsl(var(--gold-foreground))] transition-opacity hover:opacity-90"
            >
              Reconnect channels
            </Link>
          </div>
        </div>
      )}

      {/* Partial-coverage notice. Restrained on purpose: one line, no icon-shouting, and
          only when it is actually true (a Meta channel is present AND the range reaches
          back past the collection floor). Silence here would let a partial view read as
          a complete one. */}
      {rangeStartsBeforeFloor && hasMetaChannel && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Posts made directly on Facebook and Instagram are included from{" "}
          <strong>{directFloorLabel}</strong> onward. Earlier dates in this range show only posts sent
          through PostAutomation.
        </p>
      )}

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {overviewLoading || engagementLoading
          ? [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          : stats.map((stat) => (
              /* Design: 18px padding, a 38px/10px-radius tinted icon tile, then
                 label 11.5px muted → value 20px/600 → optional 10.5px faint sub.
                 Every line truncates so a long label ("Published Targets")
                 can't push the card to two rows and break the grid rhythm. */
              <Card key={stat.name}>
                <CardContent className="flex items-center gap-3.5 p-[18px]">
                  <div className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] ${stat.color}`}>
                    <stat.icon className="h-[17px] w-[17px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    {/* title explains cards whose counts legitimately differ
                        (Total Posts vs Published Targets) — reported as a bug
                        when the labels left the reader to guess. */}
                    <p className="truncate text-[11.5px] leading-[1.3] text-muted-foreground" title={stat.title}>
                      {stat.name}
                    </p>
                    <p className="mt-1 truncate text-[20px] font-semibold leading-none">
                      {stat.format ? formatNumber(stat.value) : stat.value}
                    </p>
                    {stat.sub && (
                      <p className="mt-0.5 truncate text-[10.5px] leading-[1.3] text-faint">{stat.sub}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      {/* Posts Over Time Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Posts Over Time</CardTitle>
          {/*
            Population: app-published posts (PostTarget rows) — the SAME population
            as Channel Performance and the engagement tiles since 2026-08-19, so the
            two agree by construction and no divergence disclaimer is needed.

            ⚠️ HISTORY, so the disclaimer is restored rather than reinvented if the
            direct-post population ever comes back: between 2026-08-07 and
            2026-08-19 the table unioned in ExternalPost while this chart did not.
            Measured on prod 2026-08-13, one workspace showed 0 here beside 28,401 in
            the table, and another 2 beside 28,439 — a 14,219x gap presented as if
            the two counted the same thing. That was the documented "no posts in the
            last 30 days" false bug report. Every qualifier below is therefore gated
            on `includesDirectPosts`, never deleted.
          */}
          <CardDescription>Posts you published through PostAutomation, per day</CardDescription>
        </CardHeader>
        <CardContent>
          {chartLoading ? (
            <Skeleton className="h-56 w-full rounded-lg" />
          ) : chartData.length > 0 ? (
            /* Design: this chart is plain CSS in the mockup, not a chart library —
               a 170px flex row of gold bars on a hairline baseline, each bar's
               OPACITY scaled with its value (0.55 → 1.0) and the peak day labelled
               in gold above its bar. recharts could not reproduce the per-bar
               opacity ramp or that label without fighting it, and its own axis
               furniture is what kept pulling the layout away from the mockup.
               Hover text comes from the native `title`, exactly as the mockup does. */
            (() => {
              const peak = Math.max(...chartData.map((d) => d.posts), 0);
              // 4px rather than the mockup's 6px: its window is 14 days, ours is
              // 30, so the tighter gutter buys each bar back the width it loses
              // to twice as many bars.
              const gap = "4px";
              // The mockup's window is 14 days, so every bar is labelled. Our
              // default range is 30, where 31 labels collide into an unreadable
              // smear — so show every Nth and keep the mockup's label DENSITY
              // rather than its literal one-per-bar rule.
              const labelEvery = Math.max(1, Math.ceil(chartData.length / 14));
              return (
                <div>
                  <div
                    className="flex items-end border-b border-border"
                    style={{ height: 170, gap, marginTop: 26 }}
                  >
                    {chartData.map((d) => (
                      <div
                        key={d.date}
                        className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                        title={`${d.label} — ${d.posts} post${d.posts === 1 ? "" : "s"}`}
                      >
                        {peak > 0 && d.posts === peak && (
                          <span className="absolute top-0 -translate-y-4 text-[10px] font-semibold leading-none text-gold">
                            {d.posts}
                          </span>
                        )}
                        <div
                          className="w-full rounded-t-[4px] bg-gold transition-opacity"
                          style={{
                            opacity: peak > 0 ? 0.55 + 0.45 * (d.posts / peak) : 0.55,
                            height: peak > 0 ? Math.max(6, Math.round((d.posts / peak) * 150)) : 6,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex" style={{ gap }}>
                    {chartData.map((d, i) => (
                      <span
                        key={d.date}
                        className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[9px] leading-none text-faint"
                      >
                        {i % labelEvery === 0 || i === chartData.length - 1 ? d.label : ""}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="flex h-56 items-center justify-center rounded-lg border border-dashed">
              <div className="text-center">
                <BarChart3 className="mx-auto h-8 w-8 text-muted-foreground/30" />
                <p className="mt-2 text-sm text-muted-foreground">
                  You didn&rsquo;t publish anything through PostAutomation in this period
                </p>
                {/*
                  Only shown while the direct-post population exists. With Insights
                  covering app-published posts only, pointing the user at Channel
                  Performance for direct posts would send them to a table that does
                  not contain them either — a disclaimer that has become misdirection.
                */}
                {includesDirectPosts && (
                  <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground/80">
                    Posts made directly on Facebook or Instagram aren&rsquo;t counted here —
                    see Channel Performance below for every post on your channels.
                  </p>
                )}
                {/* Fix #34: guide users to create posts */}
                <Link
                  href="/dashboard/content-agent"
                  className="mt-3 inline-block rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Create a post
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Engagement Metrics */}
        <Card>
          <CardHeader>
            <CardTitle>Engagement Breakdown</CardTitle>
            <CardDescription>Interactions across published content</CardDescription>
          </CardHeader>
          <CardContent>
            {engagementLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
              </div>
            ) : (
              <>
                {/* Design: icon + label share the top row, the number sits
                    underneath at 20px — not icon-beside-a-stacked-pair, which
                    left the figures visually smaller than the stat cards. */}
                <div className="grid grid-cols-2 gap-2.5">
                  {engagementMetrics.map((metric) => (
                    <div key={metric.label} className="min-w-0 rounded-[10px] border border-border p-3.5">
                      <div className="flex items-center gap-2">
                        <metric.icon className={`h-[15px] w-[15px] shrink-0 ${metric.color}`} />
                        <span className="truncate text-[12px] leading-none text-muted-foreground">{metric.label}</span>
                      </div>
                      <p className="mt-2 truncate text-[20px] font-semibold leading-none">{formatNumber(metric.value)}</p>
                    </div>
                  ))}
                </div>
                {engagementAllZero && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    No engagement synced for this window yet — Twitter needs a paid API tier;
                    Instagram/Facebook sync at publish + checkpoints.
                  </p>
                )}
                {/* Design: the rate gets its own full-width surface-1 block in
                    gold — it is the summary figure, so it reads apart from the
                    four raw-count tiles above it. */}
                <div className="mt-2.5 rounded-[10px] border border-border bg-surface1 p-3.5">
                  <div className="flex items-center gap-2">
                    <Percent className="h-[15px] w-[15px] shrink-0 text-gold" />
                    <span className="text-[12px] leading-none text-muted-foreground">Engagement Rate</span>
                  </div>
                  <div>
                    {(() => {
                      // This tile used to coalesce a null/impossible rate to
                      // 0 and print "0.00%" — the least honest surface of the
                      // four, since it also carried no base disclosure.
                      const cell = engagementRateCell({
                        engagementRate: engagement?.engagementRate,
                        engagementRateBasis: engagement?.engagementRateBasis,
                        engagementRateFlags: engagement?.engagementRateFlags,
                        unit: "post",
                      });
                      return (
                        <p
                          className={`mt-2 text-[20px] font-semibold leading-none ${
                            cell.text === null ? "text-muted-foreground" : "text-gold"
                          }`}
                          title={cell.title}
                        >
                          {cell.text ?? "—"}
                          {cell.lowBase && (
                            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                              · low base
                            </span>
                          )}
                        </p>
                      );
                    })()}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Platform Breakdown Pie */}
        <Card>
          <CardHeader>
            <CardTitle>Platform Breakdown</CardTitle>
            {/* Same narrower population as Posts Over Time — app-published only.
                "targets" was already an app-published-only concept (a PostTarget
                row), but the label never said so. */}
            <CardDescription>Posts you published through PostAutomation, per platform</CardDescription>
          </CardHeader>
          <CardContent>
            {breakdownLoading ? (
              <Skeleton className="h-56 w-full rounded-lg" />
            ) : platformBreakdown && platformBreakdown.length > 0 ? (
              /* Design: the donut is a CSS conic-gradient — a 150px disc with a
                 96px card-coloured hole — not a chart component. That is what
                 gives it segments which TOUCH (recharts' paddingAngle cut visible
                 wedges into the ring) at exactly the mockup's diameter. Colours
                 come from the design's own palette assigned BY RANK, not from
                 each platform's brand colour: four of our platforms are blue, so
                 brand colours produced an unreadable all-blue ring. */
              (() => {
                const ranked = [...platformBreakdown].sort((a, b) => b.count - a.count);
                let acc = 0;
                const slices = ranked.map((entry, i) => {
                  const color = DONUT_PALETTE[i % DONUT_PALETTE.length]!;
                  const start = acc;
                  acc += platformTotal > 0 ? (entry.count / platformTotal) * 360 : 0;
                  return { ...entry, color, stop: `${color} ${start}deg ${acc}deg` };
                });
                return (
                  <div>
                    <div className="mt-5 flex justify-center">
                      <div
                        className="flex h-[150px] w-[150px] items-center justify-center rounded-full"
                        style={{ background: `conic-gradient(${slices.map((s) => s.stop).join(", ")})` }}
                      >
                        {/* Total published targets in the hole. "Published" alone
                            invited comparison with the table's wider post count;
                            "Sent by you" names the narrower population. */}
                        <div className="flex h-24 w-24 flex-col items-center justify-center rounded-full bg-card">
                          <p className="text-[20px] font-semibold leading-none">{formatNumber(platformTotal)}</p>
                          <p className="mt-[3px] text-[8.5px] font-medium uppercase leading-none tracking-[0.08em] text-faint">
                            Sent by you
                          </p>
                        </div>
                      </div>
                    </div>
                    {/* Two-column legend, right-aligned percentages — but capped to
                        roughly the donut's own width and centred under it. Left to
                        fill the card, each cell stretched to ~340px and threw the
                        percentage far from the name it belongs to, which is what
                        made the legend read as two unrelated columns of numbers. */}
                    <ul className="mx-auto mt-5 grid max-w-[330px] grid-cols-2 gap-x-4 gap-y-[9px]">
                      {slices.map((entry) => (
                        <li key={entry.platform} className="flex min-w-0 items-center gap-[7px]">
                          <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: entry.color }}
                          />
                          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium leading-none">
                            {platformDisplayName(entry.platform)}
                          </span>
                          <span className="shrink-0 text-[11px] leading-none text-faint">
                            {platformTotal > 0 ? `${Math.round((entry.count / platformTotal) * 100)}%` : "0%"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()
            ) : (
              <div className="flex h-56 items-center justify-center rounded-lg border border-dashed">
                <div className="text-center">
                  <BarChart3 className="mx-auto h-8 w-8 text-muted-foreground/30" />
                  <p className="mt-2 text-sm text-muted-foreground">Publish posts to see breakdown</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Platform Performance — the design's five-axis radar. Reads the SAME
          perChannelStats rows the table below uses, so the two can never
          disagree; no new query. */}
      {channelStats && channelStats.length > 0 && (
        <Card className="shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]">
          <CardHeader>
            <CardTitle>Platform Performance</CardTitle>
            <CardDescription>
              Five metrics normalized to 0–100 per channel so they&rsquo;re comparable on one
              chart. Click a channel below to show or hide it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PlatformPerformanceRadar
              platformLabel={platformDisplayName}
              channels={channelStats.map((ch: any) => ({
                id: ch.id,
                name: ch.name,
                platform: ch.platform,
                color: getPlatformColor(ch.platform),
                unavailable: ch.unavailable ?? [],
                postCount: ch.postCount ?? 0,
                impressions: ch.impressions ?? 0,
                likes: ch.likes ?? 0,
                comments: ch.comments ?? 0,
                shares: ch.shares ?? 0,
                clicks: ch.clicks ?? 0,
                engagementRate: ch.engagementRate ?? null,
              }))}
            />
          </CardContent>
        </Card>
      )}

      {/* Per-Channel Stats Table */}
      <Card>
        <CardHeader>
          <CardTitle>Channel Performance</CardTitle>
          <CardDescription>Metrics per connected channel for the selected range</CardDescription>
          {/* Per-platform view. The container is ALWAYS mounted (min-h) so the
              table never shifts down once the platform list resolves. */}
          <div className="mt-2 flex min-h-[28px] flex-wrap items-center gap-1.5">
            {(orgPlatforms?.length ?? 0) > 1 && (
              <>
                <button
                  type="button"
                  aria-pressed={platformFilter === undefined}
                  onClick={() => setPlatformView(null)}
                  className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border px-3 py-[7px] text-[11.5px] leading-none transition-all ${
                    platformFilter === undefined
                      ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] font-semibold text-gold"
                      : "border-transparent bg-tile font-medium text-muted-foreground hover:text-foreground"
                  }`}
                >
                  All
                </button>
                {orgPlatforms!.map((p) => {
                  const active = platformFilter === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={active}
                      aria-label={`Show only ${p} channels`}
                      // Clicking the active pill clears back to All.
                      onClick={() => setPlatformView(active ? null : p)}
                      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border px-3 py-[7px] text-[11.5px] capitalize leading-none transition-all ${
                        active
                          ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] font-semibold text-gold"
                          : "border-transparent bg-tile font-medium text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p.toLowerCase()}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* ⚠️ Two different causes, two different messages. Suggesting "Sync Now"
              when nothing was published through us sends the user to a button that
              answers "Nothing to sync" — the banner and the button contradicting
              each other. See insights-empty-state.ts. */}
          {emptyState === "no_app_posts" && (
            <div className="m-4 mb-0 rounded-[10px] border border-border bg-surface1 px-3.5 py-2.5 text-[11.5px] leading-[1.5] text-muted-foreground">
              These channels haven&rsquo;t received any posts through PostAutomation yet. Insights
              measures posts sent from PostAutomation — anything you posted directly on the
              platform isn&rsquo;t counted here. Publish from Content Studio and metrics will
              appear here automatically.
            </div>
          )}
          {/* Published before, just not in this window. The advice is the OPPOSITE of
              the message above, which is why they are separate states: telling these
              users they haven't published would be flatly false. */}
          {emptyState === "no_app_posts_in_range" && (
            <div className="m-4 mb-0 rounded-[10px] border border-border bg-surface1 px-3.5 py-2.5 text-[11.5px] leading-[1.5] text-muted-foreground">
              No posts were published through PostAutomation in this date range, but this
              workspace has <strong>{overview?.publishedAllTime}</strong> in total — try{" "}
              <strong>90 days</strong> or a wider custom range to see them. Posts you made
              directly on the platform aren&rsquo;t counted here.
            </div>
          )}
          {/* Captured, and genuinely zero. Suggesting a refresh here would blame a
              pending sync for a settled fact — the exact falsehood this replaced. */}
          {emptyState === "zero_engagement" && (
            <div className="m-4 mb-0 rounded-[10px] border border-border bg-surface1 px-3.5 py-2.5 text-[11.5px] leading-[1.5] text-muted-foreground">
              Metrics have been collected for these posts and the platforms are reporting no
              engagement yet — this isn&rsquo;t a sync delay, so there&rsquo;s nothing to
              refresh. New posts usually take a few hours to accumulate views.
            </div>
          )}
          {emptyState === "no_metrics_yet" && (
            <div className="m-4 mb-0 rounded-[10px] border border-border bg-surface1 px-3.5 py-2.5 text-[11.5px] leading-[1.5] text-muted-foreground">
              Your channels are connected, but no engagement data has synced yet. Metrics appear
              after a sync cycle — try “Sync Now” above, or check back later.
              {health && health.needsReconnectCount > 0
                ? " Some channels also need reconnecting (see the notice above)."
                : ""}
            </div>
          )}
          {channelLoading ? (
            <div className="space-y-2 p-6">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
            </div>
          ) : channelStats && channelStats.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-[12.5px]">
                <thead>
                  <tr className="border-b border-border bg-surface1">
                    <th className="px-4 py-[11px] text-left text-[10.5px] font-medium leading-none text-muted-foreground">Channel</th>
                    {/* The header follows the POPULATION, in both directions.
                        "Posts" (bare) was correct only while direct posts were ingested;
                        with Insights covering app-published posts it would over-claim —
                        the platform's own count is legitimately higher (measured on prod:
                        Facebook reported 13 where we published 10), and a bare "Posts"
                        invites exactly the "your numbers are wrong" report that the
                        earlier rename was meant to settle. */}
                    <th
                      className="px-4 py-[11px] text-right text-[10.5px] font-medium leading-none text-muted-foreground"
                      title={
                        includesDirectPosts
                          ? `Posts on this channel within the selected date range — those sent through PostAutomation plus those posted directly on the platform (Facebook/Instagram, from ${directFloorLabel ?? "the coverage start date"}).`
                          : "Posts sent to this channel through PostAutomation within the selected date range. Posts you made directly on the platform aren't counted, so the platform's own total may be higher."
                      }
                    >
                      Posts
                    </th>
                    {channelColumns.map((c) => (
                      <th
                        key={c.key}
                        className="px-4 py-[11px] text-right text-[10.5px] font-medium leading-none text-muted-foreground"
                        title={c.key === "likes" ? likeHeader.tooltip : undefined}
                      >
                        {c.key === "likes" ? likeHeader.label : c.label}
                      </th>
                    ))}
                    {channelColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                      <th className="px-4 py-[11px] text-right text-[10.5px] font-medium leading-none text-muted-foreground">Eng. Rate</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {channelStats.map((ch, idx) => (
                    <tr
                      key={ch.id}
                      className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${
                        idx % 2 === 0 ? "" : "bg-muted/10"
                      }`}
                    >
                      <td className="px-4 py-[11px]">
                        {/* Design: 28px initials/avatar circle, the channel name at
                            12.5px/500, and everything else — platform, handle,
                            lifecycle, the reconnect hint — as one 9.5px line
                            beneath it. The platform is plain text in its brand
                            colour, not a bordered Badge; three stacked pills made
                            every row taller than the mockup's 11px cell padding. */}
                        <div className="flex items-center gap-[9px]">
                          <ChannelAvatar avatar={ch.avatar} name={ch.name} className="h-7 w-7 shrink-0" />
                          <div className="min-w-0">
                            <p className="whitespace-nowrap text-[12.5px] font-medium leading-[1.3]">{ch.name}</p>
                            <div className="mt-0.5 flex items-center gap-[5px] text-[9.5px] leading-[1.4]">
                              <span style={{ color: getPlatformColor(ch.platform) }}>{ch.platform}</span>
                              {ch.username && <span className="text-faint">@{ch.username}</span>}
                              {/* Lifecycle note. History from paused/disconnected
                                  channels now counts toward totals (a post that was
                                  published and earned engagement is a historical
                                  fact), so the row must say why it's still here. */}
                              {ch.channelStatus === "disconnected" && (
                                <span
                                  className="text-muted-foreground"
                                  title="This channel was disconnected. Its past posts still count here; reconnect it to resume collecting new metrics."
                                >
                                  Disconnected
                                </span>
                              )}
                              {ch.channelStatus === "paused" && (
                                <span
                                  className="text-muted-foreground"
                                  title="This channel is paused. Its past posts still count here."
                                >
                                  Paused
                                </span>
                              )}
                              {/* Per-channel reconnect hint: this row's "—"s are a
                                  token problem, not an absence of engagement. */}
                              {ch.insightsHealth?.status === "needs_reconnect" && (
                                <Link
                                  href="/dashboard/channels"
                                  title={
                                    ch.insightsHealth.missingScopes?.length
                                      ? `Reconnect to grant: ${ch.insightsHealth.missingScopes.join(", ")}`
                                      : "The platform rejected this channel's access token. Reconnect to restore Insights."
                                  }
                                  className="inline-flex items-center gap-0.5 text-gold hover:underline"
                                >
                                  <AlertTriangle className="h-[9px] w-[9px]" />
                                  Reconnect
                                </Link>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-[11px] text-right text-muted-foreground">{ch.postCount}</td>
                      {channelColumns.map((c) => (
                        <td key={c.key} className="px-4 py-[11px] text-right">
                          {metricCell(c.key, (ch as any)[c.valueKey] as number, ch)}
                        </td>
                      ))}
                      {channelColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                        <td className="px-4 py-[11px] text-right">
                          {/* Engagement rate is engagement ÷ impressions, so it is
                              only as honest as its denominator AND its base. It is
                              now pooled over ONLY the posts that reported
                              impressions (pooling over all posts produced 1400% on
                              prod), and the base is shown — on Facebook only video
                              posts carry an impression figure, so a channel rate is
                              often computed from a single post and must not read as
                              the channel's overall rate. */}
                          {(() => {
                            // ⚠️ The rate's denominator is impressions OR views.
                            // Five platforms have no impressions metric at all, so
                            // suppressing on impressions alone blanks the rate for
                            // every Instagram and YouTube channel — the largest
                            // population here. Must stay in step with the column
                            // gate above and with gatePostReportRow.
                            const hidden =
                              ch.hasSnapshot === false ||
                              ((ch.unavailable ?? []).includes("impressions") &&
                                (ch.unavailable ?? []).includes("views"));
                            const cell = engagementRateCell({
                              engagementRate: hidden ? null : ch.engagementRate,
                              engagementRateBasis: ch.engagementRateBasis,
                              engagementRateFlags: ch.engagementRateFlags,
                              unit: "post",
                            });
                            if (cell.text === null) {
                              return (
                                <span className="text-muted-foreground" title={cell.title}>
                                  —
                                </span>
                              );
                            }
                            return (
                              <span title={cell.title}>
                                {/* Design: one gold semibold figure. The old
                                    green/yellow/grey traffic light implied a
                                    universal "good rate" threshold that doesn't
                                    exist across platforms. */}
                                <span className="font-semibold text-gold">
                                  {cell.text}
                                </span>
                                {cell.basis && (
                                  <span className="ml-1 text-[10px] text-muted-foreground/70">
                                    {cell.basis}
                                  </span>
                                )}
                                {cell.lowBase && (
                                  <span className="ml-1 text-[10px] text-muted-foreground/70">
                                    · low base
                                  </span>
                                )}
                              </span>
                            );
                          })()}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-3 text-xs text-muted-foreground/70 border-t">
                &ldquo;—&rdquo; means the platform doesn&rsquo;t report that metric (or it hasn&rsquo;t synced yet), not zero.
                &ldquo;Likes&rdquo; counts reactions on Facebook, saves on Pinterest, and upvotes on Reddit. Reach is shown only
                where the platform reports it separately from impressions, and where it is summed across
                posts it is labelled &ldquo;summed&rdquo; — the same person seeing two posts counts twice, so it is
                not a deduplicated audience size.
                {includesDirectPosts ? (
                  <>
                    &ldquo;Posts&rdquo; counts every post on the channel in this date range — those sent
                    through PostAutomation plus those posted directly on the platform. Direct posts are
                    collected for Facebook Pages and Instagram accounts from {directFloorLabel ?? "the coverage start date"} onward,
                    and only while the channel&rsquo;s connection is healthy; a channel needing
                    reconnection shows its own posts only.
                  </>
                ) : (
                  <>
                    &ldquo;Posts sent&rdquo; counts the posts published to this channel through
                    PostAutomation in this date range. Anything you posted directly on the platform
                    isn&rsquo;t included, so the platform&rsquo;s own post count is usually higher — that
                    difference is expected, not missing data.
                  </>
                )}{" "}
                Engagement rate is pooled over only the posts that reported impressions, and shows that
                count in brackets when it is fewer than all of them.
              </p>
            </div>
          ) : (
            // Fix #34: empty state includes a CTA to connect channels
            <div className="flex h-48 items-center justify-center">
              {/* ⚠️ A platform view with no rows must NEVER claim the org has no
                  channels — that is flatly false and sends the user to connect a
                  channel they already have. Name the filter and offer a way out. */}
              {platformFilter ? (
                <div className="text-center">
                  <Users className="mx-auto h-8 w-8 text-muted-foreground/30" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    No {platformFilter.toLowerCase()} channels in this date range
                  </p>
                  <button
                    type="button"
                    onClick={() => setPlatformView(null)}
                    className="mt-3 inline-block rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Show all platforms
                  </button>
                </div>
              ) : (
                <div className="text-center">
                  <Users className="mx-auto h-8 w-8 text-muted-foreground/30" />
                  <p className="mt-2 text-sm text-muted-foreground">No active channels found</p>
                  <p className="mt-1 text-xs text-muted-foreground/70">Connect a channel to see analytics data</p>
                  <Link
                    href="/dashboard/channels"
                    className="mt-3 inline-block rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Connect a channel
                  </Link>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Group Performance — only when the org has channel groups. A channel
          in multiple groups counts in each; the Ungrouped bucket collects
          active channels that belong to no group. */}
      {/* Mount ONLY when the org actually has groups — never show a skeleton to
          zero-group orgs (which would then unmount, shifting layout on every
          visit). placeholderData keeps groupStats defined across refetches, so a
          group-having org's card never disappears mid-range-change. */}
      {/* ⚠️ Hidden entirely on a platform view. A ChannelGroup may span
          platforms, so groupStats deliberately IGNORES the platform input —
          leaving the card visible would show org-wide group totals next to a
          filtered channel table, i.e. two populations on one screen. */}
      {(groupStats?.groupCount ?? 0) > 0 && !platformFilter && (
        <Card>
          <CardHeader>
            <CardTitle>Group Performance</CardTitle>
            <CardDescription>Metrics summed per channel group</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {groupLoading ? (
              <div className="space-y-2 p-6">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border bg-surface1">
                      <th className="px-4 py-[11px] text-left text-[10.5px] font-medium leading-none text-muted-foreground">Group</th>
                      <th className="px-4 py-[11px] text-right text-[10.5px] font-medium leading-none text-muted-foreground">Channels</th>
                      <th className="px-4 py-[11px] text-right text-[10.5px] font-medium leading-none text-muted-foreground">Publishes</th>
                      {groupColumns.map((c) => (
                        <th key={c.key} className="px-4 py-[11px] text-right text-[10.5px] font-medium leading-none text-muted-foreground">
                          {c.label}
                        </th>
                      ))}
                      {groupColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                        <th className="px-4 py-[11px] text-right text-[10.5px] font-medium leading-none text-muted-foreground">Eng. %</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(groupStats?.rows ?? []).map((g, idx) => (
                      <tr
                        key={g.id}
                        className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${
                          idx % 2 === 0 ? "" : "bg-muted/10"
                        }`}
                      >
                        <td className="px-4 py-[11px]">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: g.color }}
                            />
                            <span className="font-medium">{g.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-[11px] text-right">{g.channelCount}</td>
                        <td className="px-4 py-[11px] text-right text-muted-foreground">{g.posts}</td>
                        {/* Same honesty gate as Channel Performance: a metric no
                            member channel can report renders "—", never a fake 0. */}
                        {groupColumns.map((c) => (
                          <td key={c.key} className="px-4 py-[11px] text-right">
                            {metricCell(c.key, (g as any)[c.valueKey] as number, g as MetricRowMeta)}
                          </td>
                        ))}
                        {groupColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                          <td className="px-4 py-[11px] text-right">
                            {/* Gated on the same base rule as the per-channel rate:
                                with no impressioned post there is no denominator,
                                so "0.00%" would misread as "no engagement". */}
                            {(() => {
                              // Same impressions-OR-views rule as the channel table.
                              const hidden =
                                g.hasSnapshot === false ||
                                ((g.unavailable ?? []).includes("impressions") &&
                                  (g.unavailable ?? []).includes("views"));
                              const cell = engagementRateCell({
                                engagementRate: hidden ? null : g.engagementRate,
                                engagementRateBasis: g.engagementRateBasis,
                                engagementRateFlags: g.engagementRateFlags,
                                unit: "publish",
                              });
                              if (cell.text === null) {
                                return (
                                  <span className="text-muted-foreground" title={cell.title}>
                                    —
                                  </span>
                                );
                              }
                              return (
                                <span title={cell.title}>
                                  <span
                                    className={`font-medium ${
                                      g.engagementRate! > 3
                                        ? "text-green-600 dark:text-green-400"
                                        : g.engagementRate! > 1
                                        ? "text-yellow-600 dark:text-yellow-400"
                                        : "text-muted-foreground"
                                    }`}
                                  >
                                    {cell.text}
                                  </span>
                                  {cell.basis && (
                                    <span className="ml-1 text-[10px] text-muted-foreground/70">
                                      {cell.basis}
                                    </span>
                                  )}
                                  {cell.lowBase && (
                                    <span className="ml-1 text-[10px] text-muted-foreground/70">
                                      · low base
                                    </span>
                                  )}
                                </span>
                              );
                            })()}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  Channels in multiple groups are counted in each group.
                  &ldquo;Publishes&rdquo; counts each post once per channel it
                  was published to, so a single post to several channels in a
                  group adds more than one.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * ?tab= deep-link reader (routing contract: emit ?tab=insights|reports).
 * Lives in its own Suspense-wrapped child so useSearchParams() doesn't opt the
 * whole page out of static generation (same pattern as OAuthCallbackToaster).
 */
function InsightsTabDeepLink({ onTab }: { onTab: (t: "insights" | "reports") => void }) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "reports" || t === "insights") onTab(t);
  }, [searchParams, onTab]);
  return null;
}

/**
 * Insights page (2026-07-17): two tabs —
 *  1. Insights (analytical): the existing analytics view, unchanged.
 *  2. Reports: structured, extractable per-post table over 24h/7d/15d/30d
 *     windows with CSV export (see components/analytics/ReportsTab).
 */
export default function InsightsPage() {
  const [tab, setTab] = useState<"insights" | "reports">("insights");

  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <InsightsTabDeepLink onTab={setTab} />
      </Suspense>

      {/* Design: a surface-1 pill rail (4px pad, 10px radius) whose ACTIVE tab is
          a gold chip with the gold glow — not the bone/foreground fill it used to
          be, which read as a different control from every other active state on
          the page. */}
      <div className="flex w-fit items-center gap-1 rounded-[10px] border border-border bg-surface1 p-1">
        {([
          { id: "insights", label: "Insights" },
          { id: "reports", label: "Reports" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`whitespace-nowrap rounded-[8px] px-[18px] py-2 text-center text-[12.5px] leading-none transition-colors ${
              tab === t.id
                ? "pa-gold-glow bg-gold font-semibold text-[hsl(var(--gold-foreground))]"
                : "font-medium text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "insights" ? <InsightsAnalyticsView /> : <ReportsTab />}
    </div>
  );
}
