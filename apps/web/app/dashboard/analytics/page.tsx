"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ReportsTab } from "~/components/analytics/ReportsTab";
import { ChannelAvatar } from "~/components/channel-avatar";
import { trpc } from "~/lib/trpc/client";
import { useToast } from "~/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import {
  BarChart3, TrendingUp, CheckCircle, XCircle, Eye, Heart, MessageCircle,
  Share, MousePointerClick, Users, Percent, Calendar, RefreshCw, AlertTriangle, PlayCircle,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";
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

function getPlatformColor(platform: string) {
  return PLATFORM_COLORS[platform] ?? PLATFORM_COLORS.DEFAULT;
}

// Recharts tooltips default to WHITE bg + series-colored text — unreadable in
// dark mode and against the dataviz rule that text wears text tokens. These
// styles pin tooltip chrome + text to theme tokens (identity comes from the
// swatch recharts already renders beside each item).
const TOOLTIP_CONTENT_STYLE = {
  fontSize: 12,
  borderRadius: 8,
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--card-foreground))",
} as const;
const TOOLTIP_ITEM_STYLE = { color: "hsl(var(--card-foreground))" } as const;
const TOOLTIP_LABEL_STYLE = { color: "hsl(var(--muted-foreground))" } as const;

function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const presets = [
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
  ];

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {presets.map((p) => {
        const pFrom = subDays(new Date(), p.days).toISOString();
        const pTo = new Date().toISOString();
        const active = from.startsWith(pFrom.slice(0, 10));
        return (
          <button
            key={p.label}
            onClick={() => onChange(pFrom, pTo)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium border transition-colors ${
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary/50"
            }`}
          >
            {p.label}
          </button>
        );
      })}
      <div className="flex items-center gap-1.5 ml-1">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="date"
          value={from.slice(0, 10)}
          // Parse the date input as UTC midnight, not local — otherwise a UTC+5:30
          // user's "today" shifts a day and posts drop out (audit fix 2026-06-06).
          onChange={(e) => onChange(e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : from, to)}
          className="text-xs border rounded-md px-2 py-1 bg-background"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <input
          type="date"
          value={to.slice(0, 10)}
          onChange={(e) => onChange(from, e.target.value ? new Date(`${e.target.value}T23:59:59.999Z`).toISOString() : to)}
          className="text-xs border rounded-md px-2 py-1 bg-background"
        />
      </div>
    </div>
  );
}

function InsightsAnalyticsView() {
  const [from, setFrom] = useState(() => subDays(new Date(), 30).toISOString());
  const [to, setTo] = useState(() => new Date().toISOString());
  const [syncing, setSyncing] = useState(false);
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
  const stats: Array<{ name: string; value: number; icon: any; color: string; format?: boolean; sub?: string }> = [
    { name: "Total Posts", value: overview?.totalPosts ?? 0, icon: BarChart3, color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-950" },
    {
      name: "Published Targets",
      value: overview?.published ?? 0,
      icon: CheckCircle,
      color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-950",
      sub: overview ? `across ${overview.totalTargets} target${overview.totalTargets === 1 ? "" : "s"}` : undefined,
    },
    { name: "Failed", value: overview?.failed ?? 0, icon: XCircle, color: "text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-950" },
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
      ? [{ name: "Reach (summed)", value: engagement?.reach ?? 0, icon: TrendingUp, color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-950", format: true }]
      : statReportable("views")
        ? [{ name: "Total Views", value: engagement?.views ?? 0, icon: TrendingUp, color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-950", format: true }]
        : statReportable("impressions")
          ? [{ name: "Total Impressions", value: engagement?.impressions ?? 0, icon: TrendingUp, color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-950", format: true }]
          : [{ name: "Total Engagement", value: (engagement?.likes ?? 0) + (engagement?.comments ?? 0) + (engagement?.shares ?? 0), icon: TrendingUp, color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-950", format: true }]),
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
  const engagementMetrics = [
    { key: "impressions", label: "Impressions", value: engagement?.impressions ?? 0, icon: Eye, color: "text-blue-500" },
    // Distinct from Impressions — see the CHANNEL_METRIC_COLUMNS note. For the
    // five platforms with no impressions metric this tile REPLACES that one.
    { key: "views", label: "Views", value: engagement?.views ?? 0, icon: PlayCircle, color: "text-sky-500" },
    { key: "likes", label: "Likes", value: engagement?.likes ?? 0, icon: Heart, color: "text-red-500" },
    { key: "comments", label: "Comments", value: engagement?.comments ?? 0, icon: MessageCircle, color: "text-green-500" },
    { key: "shares", label: "Shares", value: engagement?.shares ?? 0, icon: Share, color: "text-purple-500" },
    { key: "clicks", label: "Clicks", value: engagement?.clicks ?? 0, icon: MousePointerClick, color: "text-orange-500" },
    // ⚠️ "summed" is load-bearing, not decoration. Reach is distinct PEOPLE per
    // POST, so adding it across posts counts the same person once per post they
    // saw. Calling this bare "Reach" would state an audience size we do not have
    // (a deduplicated figure needs the page-level edge, which has no code path).
    { key: "reach", label: "Reach (summed per post)", value: engagement?.reach ?? 0, icon: Users, color: "text-cyan-500" },
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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Insights</h1>
          <p className="text-muted-foreground">See how your posts perform — reach, likes, comments &amp; shares across your channels</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <DateRangePicker
            from={from}
            to={to}
            onChange={(f, t) => { setFrom(f); setTo(t); }}
          />
          <button
            onClick={() => { setSyncing(true); triggerSync.mutate(); }}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync Now"}
          </button>
        </div>
      </div>

      {/* Reconnect banner. A Meta App Review approval does NOT add scopes to
          tokens that were already issued — scopes are granted only at consent
          time — so channels connected before approval keep reporting nothing
          until their owner reconnects once. Without this, a dead/under-scoped
          token is indistinguishable from genuinely zero engagement. */}
      {health && (health.needsReconnectCount > 0 || health.expiringSoonCount > 0) && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                {health.needsReconnectCount > 0 ? (
                  <>
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {health.needsReconnectCount} channel{health.needsReconnectCount === 1 ? "" : "s"} need
                      {health.needsReconnectCount === 1 ? "s" : ""} reconnecting to report Insights
                    </p>
                    <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-300/90">
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
                      <p className="mt-1.5 text-xs font-medium text-amber-900 dark:text-amber-200">
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
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {health.expiringSoonCount} channel{health.expiringSoonCount === 1 ? "" : "s"} will stop
                      reporting Insights soon
                    </p>
                    <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-300/90">
                      Meta closes a 90-day data-access window per connection. Reconnect before it
                      lapses to keep metrics flowing — a background refresh cannot extend it. Posting
                      is unaffected either way.
                    </p>
                  </>
                )}
                {health.channels.length > 0 && (
                  <p className="mt-1.5 truncate text-xs text-amber-800/70 dark:text-amber-300/70">
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
              className="shrink-0 self-start rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700"
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
              <Card key={stat.name}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className={`rounded-lg p-2.5 ${stat.color}`}>
                      <stat.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">{stat.name}</p>
                      <p className="text-2xl font-bold">
                        {stat.format ? formatNumber(stat.value) : stat.value}
                      </p>
                      {stat.sub && (
                        <p className="text-xs text-muted-foreground">{stat.sub}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      {/* Posts Over Time Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Posts Over Time</CardTitle>
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
            <ResponsiveContainer width="100%" height={220}>
              {/* Fix #36: changed left margin from -20 to 8 to prevent tooltip clipping */}
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                  minTickGap={24}
                  tickMargin={8}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} className="text-muted-foreground" />
                {/* Fix #36: allowEscapeViewBox + wrapperStyle prevent clipping at narrow widths */}
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  itemStyle={TOOLTIP_ITEM_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  wrapperStyle={{ zIndex: 50 }}
                  allowEscapeViewBox={{ x: true, y: true }}
                  formatter={(v: number) => [v, "Posts"]}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Bar dataKey="posts" fill="#6366F1" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
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
            <CardTitle className="text-base">Engagement Breakdown</CardTitle>
            <CardDescription>Interactions across published content</CardDescription>
          </CardHeader>
          <CardContent>
            {engagementLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {engagementMetrics.map((metric) => (
                    <div key={metric.label} className="flex items-center gap-3 rounded-lg border p-3">
                      <metric.icon className={`h-5 w-5 shrink-0 ${metric.color}`} />
                      <div>
                        <p className="text-xs text-muted-foreground">{metric.label}</p>
                        <p className="text-lg font-semibold">{formatNumber(metric.value)}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {engagementAllZero && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    No engagement synced for this window yet — Twitter needs a paid API tier;
                    Instagram/Facebook sync at publish + checkpoints.
                  </p>
                )}
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <Percent className="h-5 w-5 text-primary" />
                  <div>
                    <p className="text-xs text-muted-foreground">Engagement Rate</p>
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
                          className={`text-lg font-semibold ${
                            cell.text === null ? "text-muted-foreground" : "text-primary"
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
            <CardTitle className="text-base">Platform Breakdown</CardTitle>
            {/* Same narrower population as Posts Over Time — app-published only.
                "targets" was already an app-published-only concept (a PostTarget
                row), but the label never said so. */}
            <CardDescription>Posts you published through PostAutomation, per platform</CardDescription>
          </CardHeader>
          <CardContent>
            {breakdownLoading ? (
              <Skeleton className="h-56 w-full rounded-lg" />
            ) : platformBreakdown && platformBreakdown.length > 0 ? (
              <div>
                {/* Plot area is legend-free (the legend lives below as HTML), so
                    the 220px container is all donut — nothing overlaps or clips. */}
                <div className="relative">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={platformBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={3}
                        dataKey="count"
                        nameKey="platform"
                      >
                        {platformBreakdown.map((entry) => (
                          <Cell
                            key={entry.platform}
                            fill={getPlatformColor(entry.platform)}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v: number, name) => [
                          // "targets" is internal jargon AND ambiguous against the
                          // table's wider "Posts" count — name the population.
                          `${v} sent by you`,
                          name,
                        ]}
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        itemStyle={TOOLTIP_ITEM_STYLE}
                        labelStyle={TOOLTIP_LABEL_STYLE}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Total published targets centered in the donut hole.
                      "Published" alone invited the reader to compare this with the
                      channel's real post count in the table below, which counts a
                      wider population. "Sent by you" names the narrower one. */}
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <p className="text-2xl font-bold leading-none">{formatNumber(platformTotal)}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Sent by you
                    </p>
                  </div>
                </div>
                {/* Contained legend: identity dot carries the platform color;
                    the text itself wears foreground/muted tokens (readable in
                    both themes), never the series color. */}
                <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
                  {platformBreakdown.map((entry) => (
                    <li key={entry.platform} className="flex items-center gap-1.5 text-xs">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: getPlatformColor(entry.platform) }}
                      />
                      <span className="font-medium text-foreground">{entry.platform}</span>
                      <span className="text-muted-foreground">
                        {platformTotal > 0 ? `${Math.round((entry.count / platformTotal) * 100)}%` : "0%"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
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

      {/* Per-Channel Stats Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Channel Performance</CardTitle>
          <CardDescription>Metrics per connected channel</CardDescription>
          {/* Per-platform view. The container is ALWAYS mounted (min-h) so the
              table never shifts down once the platform list resolves. */}
          <div className="mt-2 flex min-h-[28px] flex-wrap items-center gap-1.5">
            {(orgPlatforms?.length ?? 0) > 1 && (
              <>
                <button
                  type="button"
                  aria-pressed={platformFilter === undefined}
                  onClick={() => setPlatformView(null)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    platformFilter === undefined
                      ? "border-primary bg-primary/10"
                      : "hover:bg-muted/50"
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
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize transition-colors ${
                        active ? "border-primary bg-primary/10" : "hover:bg-muted/50"
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
            <div className="m-4 mb-0 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-400">
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
            <div className="m-4 mb-0 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-400">
              No posts were published through PostAutomation in this date range, but this
              workspace has <strong>{overview?.publishedAllTime}</strong> in total — try{" "}
              <strong>90 days</strong> or a wider custom range to see them. Posts you made
              directly on the platform aren&rsquo;t counted here.
            </div>
          )}
          {/* Captured, and genuinely zero. Suggesting a refresh here would blame a
              pending sync for a settled fact — the exact falsehood this replaced. */}
          {emptyState === "zero_engagement" && (
            <div className="m-4 mb-0 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-400">
              Metrics have been collected for these posts and the platforms are reporting no
              engagement yet — this isn&rsquo;t a sync delay, so there&rsquo;s nothing to
              refresh. New posts usually take a few hours to accumulate views.
            </div>
          )}
          {emptyState === "no_metrics_yet" && (
            <div className="m-4 mb-0 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-400">
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
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Channel</th>
                    {/* The header follows the POPULATION, in both directions.
                        "Posts" (bare) was correct only while direct posts were ingested;
                        with Insights covering app-published posts it would over-claim —
                        the platform's own count is legitimately higher (measured on prod:
                        Facebook reported 13 where we published 10), and a bare "Posts"
                        invites exactly the "your numbers are wrong" report that the
                        earlier rename was meant to settle. */}
                    <th
                      className="px-4 py-3 text-right font-medium text-muted-foreground"
                      title={
                        includesDirectPosts
                          ? `Posts on this channel within the selected date range — those sent through PostAutomation plus those posted directly on the platform (Facebook/Instagram, from ${directFloorLabel ?? "the coverage start date"}).`
                          : "Posts sent to this channel through PostAutomation within the selected date range. Posts you made directly on the platform aren't counted, so the platform's own total may be higher."
                      }
                    >
                      {includesDirectPosts ? "Posts" : "Posts sent"}
                    </th>
                    {channelColumns.map((c) => (
                      <th
                        key={c.key}
                        className="px-4 py-3 text-right font-medium text-muted-foreground"
                        title={c.key === "likes" ? likeHeader.tooltip : undefined}
                      >
                        {c.key === "likes" ? likeHeader.label : c.label}
                      </th>
                    ))}
                    {channelColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Eng. Rate</th>
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
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <ChannelAvatar avatar={ch.avatar} name={ch.name} className="h-7 w-7 shrink-0" />
                          <div>
                            <p className="font-medium leading-none">{ch.name}</p>
                            {ch.username && (
                              <p className="text-xs text-muted-foreground mt-0.5">@{ch.username}</p>
                            )}
                          </div>
                          <Badge
                            variant="outline"
                            className="ml-1 text-[10px] px-1.5 py-0"
                            style={{ borderColor: getPlatformColor(ch.platform), color: getPlatformColor(ch.platform) }}
                          >
                            {ch.platform}
                          </Badge>
                          {/* Lifecycle badge. History from paused/disconnected
                              channels now counts toward totals (a post that was
                              published and earned engagement is a historical
                              fact), so the row must say why it's still here. */}
                          {ch.channelStatus === "disconnected" && (
                            <Badge
                              variant="outline"
                              className="ml-1 px-1.5 py-0 text-[10px] text-muted-foreground"
                              title="This channel was disconnected. Its past posts still count here; reconnect it to resume collecting new metrics."
                            >
                              Disconnected
                            </Badge>
                          )}
                          {ch.channelStatus === "paused" && (
                            <Badge
                              variant="outline"
                              className="ml-1 px-1.5 py-0 text-[10px] text-muted-foreground"
                              title="This channel is paused. Its past posts still count here."
                            >
                              Paused
                            </Badge>
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
                              className="ml-1 inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
                            >
                              <AlertTriangle className="h-2.5 w-2.5" />
                              Reconnect
                            </Link>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{ch.postCount}</td>
                      {channelColumns.map((c) => (
                        <td key={c.key} className="px-4 py-3 text-right">
                          {metricCell(c.key, (ch as any)[c.valueKey] as number, ch)}
                        </td>
                      ))}
                      {channelColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                        <td className="px-4 py-3 text-right">
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
                                <span
                                  className={`font-medium ${
                                    ch.engagementRate! > 3
                                      ? "text-green-600 dark:text-green-400"
                                      : ch.engagementRate! > 1
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
            <CardTitle className="text-base">Group Performance</CardTitle>
            <CardDescription>Metrics summed per channel group</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {groupLoading ? (
              <div className="space-y-2 p-6">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Group</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Channels</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Publishes</th>
                      {groupColumns.map((c) => (
                        <th key={c.key} className="px-4 py-3 text-right font-medium text-muted-foreground">
                          {c.label}
                        </th>
                      ))}
                      {groupColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                        <th className="px-4 py-3 text-right font-medium text-muted-foreground">Eng. %</th>
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
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: g.color }}
                            />
                            <span className="font-medium">{g.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">{g.channelCount}</td>
                        <td className="px-4 py-3 text-right font-medium">{g.posts}</td>
                        {/* Same honesty gate as Channel Performance: a metric no
                            member channel can report renders "—", never a fake 0. */}
                        {groupColumns.map((c) => (
                          <td key={c.key} className="px-4 py-3 text-right">
                            {metricCell(c.key, (g as any)[c.valueKey] as number, g as MetricRowMeta)}
                          </td>
                        ))}
                        {groupColumns.some((c) => c.key === "impressions" || c.key === "views") && (
                          <td className="px-4 py-3 text-right">
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

      <div className="flex w-fit rounded-lg border p-0.5">
        <button
          onClick={() => setTab("insights")}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === "insights" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Insights
        </button>
        <button
          onClick={() => setTab("reports")}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === "reports" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Reports
        </button>
      </div>

      {tab === "insights" ? <InsightsAnalyticsView /> : <ReportsTab />}
    </div>
  );
}
