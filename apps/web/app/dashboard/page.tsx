"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Skeleton } from "~/components/ui/skeleton";
import {
  PenSquare,
  Share2,
  Sparkles,
  Plus,
  CalendarDays,
  Clock,
  CheckCircle,
  XCircle,
  ExternalLink,
  Repeat2,
  // Newspaper, // NewsGrid Bot hidden from UI 2026-06-23 — re-add with the feature card below
  Zap,
  Bot,
  Layers,
  Ear,
  Target,
  Star,
  Lock,
  BarChart3,
  TrendingUp,
} from "lucide-react";
import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { useSession } from "next-auth/react";

type PlanType = "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE";
const PLAN_ORDER: PlanType[] = ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"];

/**
 * "Posting Activity" — the 14-day area chart from the Claude Design mockup
 * (`ContentStudio.dc.html`, the `isDashboardPage` branch).
 *
 * The mockup hardcodes a 14-value array; this fetches 28 real days from
 * `analytics.postsOverTime` so the chart shows the last 14 AND the trend badge
 * can compare them against the prior 14 for real.
 *
 * Geometry is the mockup's: a 700x200 viewBox with 10px vertical padding,
 * gridlines at y=50/110/170, a gold stroke at 2.5 and a 4.5r dot on the final
 * point. `preserveAspectRatio="none"` is what lets it stretch to any width.
 */
function PostingActivityChart() {
  const from = useMemo(
    () => new Date(Date.now() - 27 * 24 * 60 * 60 * 1000).toISOString(),
    []
  );
  const { data, isLoading } = trpc.analytics.postsOverTime.useQuery({ from });

  const chart = useMemo(() => {
    const series = data ?? [];
    // Guard the whole computation on a full 28-day window — a short series
    // would make the "prior 2 weeks" comparison silently wrong.
    const recent = series.slice(-14);
    const prior = series.slice(-28, -14);
    if (recent.length === 0) return null;

    const values = recent.map((d) => d.posts);
    const W = 700;
    const H = 200;
    const PAD = 10;
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => {
      const x = values.length === 1 ? W : (i / (values.length - 1)) * W;
      const y = H - PAD - (v / max) * (H - PAD * 2);
      return [x, y] as const;
    });
    const line = pts.map((p) => `${p[0]},${p[1]}`).join(" ");
    const last = pts[pts.length - 1]!;

    const sum = (rows: { posts: number }[]) => rows.reduce((n, r) => n + r.posts, 0);
    const recentTotal = sum(recent);
    const priorTotal = sum(prior);
    // Only claim a percentage when there is a real baseline to divide by.
    // prior === 0 makes the change undefined, not "+100%".
    const pct =
      prior.length === 14 && priorTotal > 0
        ? Math.round(((recentTotal - priorTotal) / priorTotal) * 100)
        : null;

    return {
      line,
      area: `${line} ${W},${H} 0,${H}`,
      peakX: last[0],
      peakY: last[1],
      pct,
      total: recentTotal,
    };
  }, [data]);

  return (
    <div className="rounded-[14px] border border-border bg-card p-6 shadow-[0_8px_18px_-12px_rgba(0,0,0,0.5)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium leading-tight">Posting Activity</h2>
          <p className="mt-[5px] text-xs leading-[1.4] text-muted-foreground">
            Posts published across all channels, last 14 days
          </p>
        </div>
        {chart?.pct !== null && chart?.pct !== undefined && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--accent-border))] bg-gold/[0.12] px-[11px] py-[5px] text-[11px] font-semibold text-gold">
            <TrendingUp className="h-3 w-3" />
            {chart.pct >= 0 ? "+" : ""}
            {chart.pct}% vs prior 2 weeks
          </span>
        )}
      </div>

      <div className="relative mt-5 h-[180px]">
        {isLoading ? (
          <Skeleton className="h-full w-full rounded-lg" />
        ) : !chart ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No published posts yet — your activity will chart here.
          </div>
        ) : (
          <svg
            viewBox="0 0 700 200"
            preserveAspectRatio="none"
            className="h-full w-full overflow-visible"
            role="img"
            aria-label={`Posts published in the last 14 days: ${chart.total} total`}
          >
            <defs>
              <linearGradient id="dashChartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--accent-gold))" stopOpacity="0.38" />
                <stop offset="100%" stopColor="hsl(var(--accent-gold))" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[50, 110, 170].map((y) => (
              <line key={y} x1="0" y1={y} x2="700" y2={y} stroke="hsl(var(--border))" strokeWidth="1" />
            ))}
            <polygon points={chart.area} fill="url(#dashChartGrad)" />
            <polyline
              points={chart.line}
              fill="none"
              stroke="hsl(var(--accent-gold))"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle
              cx={chart.peakX}
              cy={chart.peakY}
              r="4.5"
              fill="hsl(var(--accent-gold))"
              stroke="hsl(var(--card))"
              strokeWidth="2"
            />
          </svg>
        )}
      </div>

      <div className="mt-2 flex justify-between text-[10px] font-medium uppercase tracking-[0.06em] text-faint">
        <span>14 days ago</span>
        <span>7 days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

const featureCards: {
  href: string;
  icon: React.ElementType;
  title: string;
  desc: string;
  minPlan?: PlanType;
  /** App-level RBAC (User.appRole): card hidden unless ADMIN role (or super admin). */
  appAdminOnly?: boolean;
}[] = [
  {
    href: "/dashboard/super-agent",
    icon: Zap,
    title: "Super Agent",
    desc: "Chat with an AI that creates, schedules & publishes posts for you",
    minPlan: "STARTER",
  },
  {
    href: "/dashboard/content-agent",
    icon: Sparkles,
    title: "Content Studio",
    desc: "Write, generate & repurpose posts — then schedule them",
  },
  {
    href: "/dashboard/content-agent?tab=repurpose",
    icon: Repeat2,
    title: "Repurpose Content",
    desc: "Turn any article or URL into ready-to-post captions & images",
  },
  // NewsGrid Bot card hidden from UI 2026-06-23 — redundant with Repurpose (same render stack).
  // Route + newsgrid.router.ts kept intact; re-add this card object to restore.
  // {
  //   href: "/dashboard/newsgrid",
  //   icon: Newspaper,
  //   title: "NewsGrid Bot",
  //   desc: "Auto-create branded news graphics from trending headlines",
  //   minPlan: "STARTER",
  // },
  {
    href: "/dashboard/autopilot",
    icon: Zap,
    title: "Autopilot",
    desc: "Set up agents that post on a schedule, hands-free",
    minPlan: "STARTER",
    appAdminOnly: true,
  },
  {
    href: "/dashboard/listening",
    icon: Ear,
    title: "Social Listening",
    desc: "Monitor mentions of your brand & keywords across platforms",
    minPlan: "STARTER",
    appAdminOnly: true,
  },
  {
    href: "/dashboard/campaigns",
    icon: Target,
    title: "Brand Campaigns",
    desc: "Monitor brands & competitors for new content and discover influencers (not for scheduling your posts)",
    minPlan: "PROFESSIONAL",
    appAdminOnly: true,
  },
  {
    href: "/dashboard/brand-leads",
    icon: Star,
    title: "Brand Outreach",
    desc: "Auto-detect partnership leads & send AI outreach via email/X (LinkedIn & IG sent manually)",
    minPlan: "PROFESSIONAL",
    appAdminOnly: true,
  },
];

export default function DashboardPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const isSuperAdmin = (session?.user as any)?.isSuperAdmin === true;
  // App-level RBAC tier (User.appRole). Super admin implies admin.
  const appRole = (session?.user as any)?.appRole as "USER" | "ADMIN" | undefined;
  const isAppAdminUser = appRole === "ADMIN" || isSuperAdmin;
  const { data: user, isLoading: userLoading } = trpc.user.me.useQuery();
  const { data: stats, isLoading: statsLoading } = trpc.analytics.dashboardStats.useQuery();
  const { data: activity, isLoading: activityLoading } = trpc.analytics.recentActivity.useQuery({ limit: 5 });
  const { data: planData } = trpc.billing.currentPlan.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const orgPlan = (planData?.plan ?? "FREE") as PlanType;
  // Temporary: when billing is disabled, every feature is unlocked for everyone,
  // so the dashboard cards must not show lock badges or "Upgrade to X" copy.
  const billingDisabled = planData?.billingDisabled === true;

  const planAllowed = (minPlan?: PlanType) => {
    if (!minPlan) return true;
    if (billingDisabled) return true;
    if (isSuperAdmin) return true;
    return PLAN_ORDER.indexOf(orgPlan) >= PLAN_ORDER.indexOf(minPlan);
  };

  /*
   * Stat cards, per the Claude Design mockup (`ContentStudio.dc.html`,
   * `dashStats`): a 3px coloured accent bar down the left edge, a 32px icon
   * tile tinted to 12% of the same colour, a 26px/700 numeral, and a 6-bar
   * sparkline at 60% opacity.
   *
   * ⚠️ An earlier pass flattened these into one hairline-split `.pa-grid` of
   * label+numeral cells. That was a redesign, not this design — the mockup is
   * explicit about the per-card colour, icon chip and sparkline. Do not
   * re-flatten them.
   *
   * Colours are the mockup's literals: gold, then #60a5fa / #4ade80 / #a78bfa.
   * They are deliberately NOT theme tokens — the design uses them as fixed
   * per-metric identity colours in both themes.
   */
  const statItems = [
    {
      name: "Total Posts",
      value: stats?.totalPosts ?? 0,
      icon: PenSquare,
      color: "hsl(var(--accent-gold))",
      // The mockup writes the chip fill as `color + "1f"` (12% alpha). Gold is a
      // theme token rather than a hex literal, so it takes the slash form.
      iconBg: "hsl(var(--accent-gold) / 0.12)",
      trend: stats?.trends?.totalPosts,
    },
    {
      name: "Connected Channels",
      value: stats?.connectedChannels ?? 0,
      icon: Share2,
      color: "#60a5fa",
      iconBg: "#60a5fa1f",
      trend: stats?.trends?.connectedChannels,
    },
    {
      name: "Published",
      value: stats?.published ?? 0,
      icon: BarChart3,
      color: "#4ade80",
      iconBg: "#4ade801f",
      trend: stats?.trends?.published,
    },
    {
      name: "AI Generated",
      value: stats?.aiGenerated ?? 0,
      icon: Sparkles,
      color: "#a78bfa",
      iconBg: "#a78bfa1f",
      trend: stats?.trends?.aiGenerated,
    },
  ];

  /* Mon–Fri buckets for the "This week" panel, derived from the activity feed
     we already fetch. No new endpoint — purely a client-side rollup. */
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const weekCounts = WEEKDAYS.map((day, i) => {
    const n = (activity ?? []).filter((a: any) => {
      const d = new Date(a.timestamp).getDay(); // 0 = Sun
      return d === i + 1;
    }).length;
    return { day, count: n };
  });
  const weekPeak = Math.max(1, ...weekCounts.map((w) => w.count));
  const weekTotal = weekCounts.reduce((sum, w) => sum + w.count, 0);

  const heroSummary = statsLoading
    ? ""
    : `${stats?.connectedChannels ?? 0} channels live · ${stats?.totalPosts ?? 0} posts total · ${stats?.published ?? 0} published`;

  const quickActions = [
    {
      href: "/dashboard/content-agent?tab=compose",
      icon: PenSquare,
      title: "Create Post",
      desc: "Write and schedule a new post",
    },
    {
      href: "/dashboard/channels",
      icon: Share2,
      title: "Connect Channel",
      desc: "Add a social media account",
    },
    {
      href: "/dashboard/content-agent?tab=bulk",
      icon: Layers,
      title: "Bulk Create",
      desc: "Create or import many posts at once (CSV)",
    },
    {
      href: "/dashboard/autopilot/agents",
      icon: Bot,
      title: "Manage Agents",
      desc: "Configure autopilot AI agents",
    },
  ];

  const visibleFeatures = featureCards.filter(
    (card) => !card.appAdminOnly || isAppAdminUser
  );

  return (
    <div className="mx-auto flex max-w-[1150px] flex-col gap-[26px]">
      {/* ---------- Hero ---------- */}
      <div className="flex flex-col items-start gap-[18px] md:flex-row md:items-end md:justify-between md:gap-7">
        <div className="min-w-0">
          {/* Design: the eyebrow is just the page name. */}
          <div className="eyebrow mb-2.5">Dashboard</div>
          <h1 className="display text-[26px] leading-[1.1] md:text-[30px]">
            {userLoading ? (
              <Skeleton className="h-9 w-64 rounded-lg" />
            ) : (
              <>Welcome back{user?.name ? `, ${user.name}` : ""}.</>
            )}
          </h1>
          <p className="mt-2.5 text-[13px] leading-[1.6] text-muted-foreground">
            {heroSummary || <Skeleton className="h-4 w-72 rounded" />}
          </p>
        </div>
        <div className="flex flex-none gap-2.5">
          <Link
            href="/dashboard/calendar"
            className="flex h-9 items-center gap-[7px] whitespace-nowrap rounded-[9px] border border-border2 bg-card px-[14px] text-[12.5px] font-medium transition-colors hover:border-[hsl(var(--accent-border))]"
          >
            <CalendarDays className="h-3.5 w-3.5 flex-none" />
            View calendar
          </Link>
          <Link
            href="/dashboard/content-agent?tab=compose"
            className="flex h-9 items-center gap-[7px] whitespace-nowrap rounded-[9px] bg-foreground px-[14px] text-[12.5px] font-semibold text-background transition-opacity hover:opacity-[0.88]"
          >
            <Plus className="h-3.5 w-3.5 flex-none" />
            Create Post
          </Link>
        </div>
      </div>

      {/* ---------- Stats ---------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {statsLoading
          ? [0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-[14px] border border-border bg-card p-[18px]"
              >
                <Skeleton className="h-2.5 w-24 rounded" />
                <Skeleton className="mt-2.5 h-7 w-16 rounded" />
                <Skeleton className="mt-3 h-5 w-full rounded" />
              </div>
            ))
          : statItems.map((stat) => {
              const peak = Math.max(1, ...(stat.trend ?? [0]));
              return (
                <div
                  key={stat.name}
                  className="group relative overflow-hidden rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,0.5)] transition-[border-color,transform] hover:-translate-y-0.5"
                  style={{ ["--stat" as any]: stat.color }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = stat.color;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "";
                  }}
                >
                  {/* 3px accent bar down the left edge */}
                  <span
                    aria-hidden
                    className="absolute left-0 top-0 h-full w-[3px]"
                    style={{ background: stat.color }}
                  />
                  <div className="flex items-start justify-between gap-2.5">
                    <span className="text-[11.5px] leading-[1.3] text-muted-foreground">
                      {stat.name}
                    </span>
                    <div
                      className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px]"
                      style={{ background: stat.iconBg }}
                    >
                      <stat.icon
                        className="h-[15px] w-[15px] flex-none"
                        style={{ color: stat.color }}
                      />
                    </div>
                  </div>
                  <div className="mt-2.5 text-[26px] font-bold leading-none tracking-[-0.01em]">
                    {stat.value}
                  </div>
                  {/* 6-bar cumulative sparkline. Rendered only when the server
                      actually returned a series — never faked from the total. */}
                  {stat.trend && stat.trend.length > 0 ? (
                    <div className="mt-3 flex h-5 items-end gap-[2px]">
                      {stat.trend.map((v, i) => (
                        <div
                          key={i}
                          className="min-w-0 flex-1 rounded-[1px] opacity-60"
                          style={{
                            background: stat.color,
                            height: `${Math.max(6, (v / peak) * 100)}%`,
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 h-5" />
                  )}
                </div>
              );
            })}
      </div>

      {/* ---------- Posting Activity ---------- */}
      <PostingActivityChart />

      {/* ---------- Split ---------- */}
      <div className="grid items-start gap-5 lg:grid-cols-[1.62fr_1fr]">
        {/* ===== Left ===== */}
        <div className="flex min-w-0 flex-col gap-5">
          {/* AI Tools */}
          <div>
            <h2 className="pa-label pa-section-head">AI Tools</h2>
            <div className="pa-list">
              {visibleFeatures.map((card, i) => {
                const locked = !planAllowed(card.minPlan);
                const CardWrapper: any = locked ? "button" : Link;
                const wrapperProps = locked
                  ? {
                      onClick: () =>
                        router.push("/dashboard/settings/billing"),
                      type: "button" as const,
                    }
                  : { href: card.href };
                return (
                  <CardWrapper
                    key={card.href}
                    {...wrapperProps}
                    className="flex w-full items-start gap-3 px-3.5 py-3.5 text-left transition-colors hover:bg-hover md:items-center md:gap-3.5 md:px-[18px]"
                  >
                    <div className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-tile">
                      {locked ? (
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <card.icon className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1 md:contents">
                      <p className="text-[12.5px] font-semibold leading-tight md:w-[150px] md:flex-none">
                        {card.title}
                      </p>
                      <p className="text-[11.5px] leading-[1.5] text-muted-foreground md:min-w-0 md:flex-1">
                        {locked
                          ? `Upgrade to ${card.minPlan} to unlock`
                          : card.desc}
                      </p>
                    </div>
                    {i === 0 && !locked && (
                      <span className="hidden flex-none rounded border border-[hsl(var(--accent-border))] px-[7px] py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-gold md:inline">
                        Popular
                      </span>
                    )}
                  </CardWrapper>
                );
              })}
            </div>
          </div>

          {/* Quick Actions */}
          <div>
            <h2 className="pa-label pa-section-head">Quick Actions</h2>
            <div className="pa-grid grid-cols-2 md:grid-cols-4">
              {quickActions.map((action) => (
                <Link
                  key={action.href}
                  href={action.href}
                  className="p-4 transition-colors hover:bg-hover"
                >
                  <action.icon className="h-[17px] w-[17px] text-muted-foreground" />
                  <p className="mt-3 text-[12.5px] font-semibold leading-tight">
                    {action.title}
                  </p>
                  <p className="mt-[5px] text-[11px] leading-[1.45] text-muted-foreground">
                    {action.desc}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* ===== Right ===== */}
        <div className="flex min-w-0 flex-col gap-5">
          {/* Recent Activity */}
          <div>
            <div className="pa-section-head flex items-baseline justify-between gap-3">
              <h2 className="pa-label">Recent Activity</h2>
              <Link
                href="/dashboard/posts"
                className="pa-label transition-colors hover:text-foreground"
              >
                All
              </Link>
            </div>
            <div className="pa-list">
              {activityLoading ? (
                [0, 1, 2, 3].map((i) => (
                  <div key={i} className="px-4 py-3.5">
                    <Skeleton className="h-3.5 w-full rounded" />
                    <Skeleton className="mt-2 h-2.5 w-32 rounded" />
                  </div>
                ))
              ) : activity && activity.length > 0 ? (
                activity.slice(0, 4).map((item: any) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-hover"
                  >
                    {item.status === "PUBLISHED" ? (
                      <CheckCircle
                        className="mt-0.5 h-[15px] w-[15px] flex-none"
                        style={{ color: "var(--pa-success)" }}
                      />
                    ) : (
                      <XCircle
                        className="mt-0.5 h-[15px] w-[15px] flex-none"
                        style={{ color: "var(--pa-danger)" }}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium leading-[1.4]">
                        {item.postContent}
                      </p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="whitespace-nowrap text-[9.5px] font-medium uppercase leading-none tracking-[0.1em] text-muted-foreground">
                          {item.platform}
                        </span>
                        <span className="h-[3px] w-[3px] flex-none rounded-full bg-faint" />
                        <span className="whitespace-nowrap text-[10.5px] leading-none text-muted-foreground">
                          {formatDistanceToNow(new Date(item.timestamp), {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                    </div>
                    {item.publishedUrl && (
                      <a
                        href={item.publishedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 flex-none"
                      >
                        <ExternalLink className="h-3.5 w-3.5 text-faint transition-colors hover:text-foreground" />
                      </a>
                    )}
                  </div>
                ))
              ) : (
                /* First-run: no activity yet — show the setup path instead. */
                [
                  {
                    step: 1,
                    title: "Connect a channel",
                    desc: "Link your social accounts",
                    time: "2 min",
                  },
                  {
                    step: 2,
                    title: "Create your first post",
                    desc: "Draft content for publishing",
                    time: "3 min",
                  },
                  {
                    step: 3,
                    title: "Try AI generation",
                    desc: "Let AI write for you",
                    time: "1 min",
                  },
                ].map((item) => (
                  <div
                    key={item.step}
                    className="flex items-center gap-3 px-4 py-3.5"
                  >
                    <div className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-tile text-[10px] font-semibold">
                      {item.step}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium leading-tight">
                        {item.title}
                      </p>
                      <p className="mt-1 text-[10.5px] text-muted-foreground">
                        {item.desc}
                      </p>
                    </div>
                    <span className="pa-badge">
                      <Clock className="h-2.5 w-2.5" />
                      {item.time}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* This week */}
          <div>
            <div className="pa-section-head flex items-baseline justify-between gap-3">
              <h2 className="pa-label">This week</h2>
              <span className="text-[10px] font-medium text-muted-foreground">
                {weekTotal} events
              </span>
            </div>
            {/* Design: vertical bars, count above, weekday below. */}
            <div className="rounded-xl border border-border bg-card px-[18px] py-4">
              <div className="flex h-[90px] items-end gap-2.5">
                {weekCounts.map((w) => (
                  <div
                    key={w.day}
                    className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
                  >
                    <span className="text-[11px] font-semibold leading-none text-muted-foreground">
                      {w.count}
                    </span>
                    <div
                      className="w-full rounded-[5px] bg-gold"
                      style={{
                        // A zero day still needs a visible baseline, otherwise
                        // the column reads as missing rather than empty.
                        height: w.count === 0 ? 3 : `${(w.count / weekPeak) * 100}%`,
                        opacity: w.count === 0 ? 0.3 : 1,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-2.5">
                {weekCounts.map((w) => (
                  <span
                    key={w.day}
                    className="min-w-0 flex-1 text-center text-[9.5px] font-medium uppercase leading-none tracking-[0.08em] text-faint"
                  >
                    {w.day}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
