"use client";

import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  BarChart3,
  PenSquare,
  Share2,
  Sparkles,
  Plus,
  ArrowRight,
  Clock,
  CheckCircle,
  XCircle,
  ExternalLink,
  TrendingUp,
  Repeat2,
  Newspaper,
  Zap,
  Bot,
  Layers,
  Ear,
  Target,
  Star,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const featureCards = [
  {
    href: "/dashboard/super-agent",
    icon: Zap,
    title: "Super Agent",
    desc: "AI agent that can execute any task on your platform",
    accentFrom: "from-violet-500",
    accentTo: "to-purple-500",
    glowColor: "violet",
  },
  {
    href: "/dashboard/content-agent",
    icon: Sparkles,
    title: "Content Studio",
    desc: "Create, schedule, and manage social media content",
    accentFrom: "from-pink-500",
    accentTo: "to-rose-500",
    glowColor: "pink",
  },
  {
    href: "/dashboard/content-agent?expanded=repurpose",
    icon: Repeat2,
    title: "Repurpose Content",
    desc: "Transform content across platforms instantly",
    accentFrom: "from-blue-500",
    accentTo: "to-cyan-400",
    glowColor: "blue",
  },
  {
    href: "/dashboard/newsgrid",
    icon: Newspaper,
    title: "NewsGrid Bot",
    desc: "Auto-generate news creatives from trending topics",
    accentFrom: "from-rose-500",
    accentTo: "to-orange-400",
    glowColor: "rose",
  },
  {
    href: "/dashboard/autopilot",
    icon: Zap,
    title: "Autopilot",
    desc: "Fully automated posting from trending news",
    accentFrom: "from-amber-500",
    accentTo: "to-yellow-400",
    glowColor: "amber",
  },
  {
    href: "/dashboard/listening",
    icon: Ear,
    title: "Social Listening",
    desc: "Monitor mentions, sentiment & competitor activity",
    accentFrom: "from-teal-500",
    accentTo: "to-emerald-400",
    glowColor: "teal",
  },
  {
    href: "/dashboard/campaigns",
    icon: Target,
    title: "Campaign Tracking",
    desc: "Monitor brand content releases & discover influencers",
    accentFrom: "from-indigo-500",
    accentTo: "to-sky-400",
    glowColor: "indigo",
  },
  {
    href: "/dashboard/brand-leads",
    icon: Star,
    title: "Brand Leads",
    desc: "Celebrity-brand signals & outreach leads",
    accentFrom: "from-yellow-500",
    accentTo: "to-orange-400",
    glowColor: "yellow",
  },
];

export default function DashboardPage() {
  const { data: user, isLoading: userLoading } = trpc.user.me.useQuery();
  const { data: stats, isLoading: statsLoading } = trpc.analytics.dashboardStats.useQuery();
  const { data: activity, isLoading: activityLoading } = trpc.analytics.recentActivity.useQuery({ limit: 5 });

  const statItems = [
    {
      name: "Total Posts",
      value: stats?.totalPosts ?? 0,
      icon: PenSquare,
      gradient: "from-blue-500/10 to-indigo-500/10",
      iconColor: "text-blue-600 dark:text-blue-400",
    },
    {
      name: "Connected Channels",
      value: stats?.connectedChannels ?? 0,
      icon: Share2,
      gradient: "from-emerald-500/10 to-teal-500/10",
      iconColor: "text-emerald-600 dark:text-emerald-400",
    },
    {
      name: "Published",
      value: stats?.published ?? 0,
      icon: BarChart3,
      gradient: "from-violet-500/10 to-purple-500/10",
      iconColor: "text-violet-600 dark:text-violet-400",
    },
    {
      name: "AI Generated",
      value: stats?.aiGenerated ?? 0,
      icon: Sparkles,
      gradient: "from-amber-500/10 to-orange-500/10",
      iconColor: "text-amber-600 dark:text-amber-400",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* Greeting */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {userLoading ? (
              <Skeleton className="h-8 w-48 rounded-lg" />
            ) : (
              <>Welcome back{user?.name ? `, ${user.name}` : ""}</>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Here&apos;s an overview of your social media activity.
          </p>
        </div>
        <Link
          href="/dashboard/content-agent?tab=compose"
          className="flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-all hover:bg-foreground/90 active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Create Post</span>
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statsLoading
          ? [1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-[88px] rounded-2xl" />
            ))
          : statItems.map((stat) => (
              <div
                key={stat.name}
                className="group relative overflow-hidden rounded-2xl border border-black/[0.06] bg-white/60 p-5 shadow-sm transition-all hover:shadow-lg dark:border-white/[0.08] dark:bg-white/[0.04]"
                style={{
                  backdropFilter: "blur(16px) saturate(180%)",
                  WebkitBackdropFilter: "blur(16px) saturate(180%)",
                }}
              >
                <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${stat.gradient} opacity-50`} />
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-black/[0.04] to-transparent dark:via-white/15" />
                <div className="relative flex items-center gap-4">
                  <div className={`rounded-xl bg-background/80 p-2.5 shadow-sm ${stat.iconColor} dark:bg-white/[0.06]`}>
                    <stat.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">
                      {stat.name}
                    </p>
                    <p className="text-2xl font-semibold tracking-tight">
                      {stat.value}
                    </p>
                  </div>
                </div>
              </div>
            ))}
      </div>

      {/* Feature Cards — Content Studio, Repurpose, NewsGrid, Autopilot */}
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
          AI Tools
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {featureCards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group relative flex items-center gap-4 overflow-hidden rounded-2xl border border-black/[0.06] bg-white/60 p-5 shadow-sm transition-all hover:shadow-xl hover:shadow-black/[0.08] active:scale-[0.98] dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:shadow-black/20"
              style={{
                backdropFilter: "blur(20px) saturate(180%)",
                WebkitBackdropFilter: "blur(20px) saturate(180%)",
              }}
            >
              {/* Liquid glass gradient overlay */}
              <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${card.accentFrom}/[0.08] ${card.accentTo}/[0.04] opacity-60 transition-opacity group-hover:opacity-100 dark:${card.accentFrom}/[0.06] dark:${card.accentTo}/[0.03]`} />
              {/* Top highlight for glass effect */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent dark:via-white/20" />
              {/* Animated glow on hover */}
              <div className={`pointer-events-none absolute -inset-1 bg-gradient-to-br ${card.accentFrom}/20 ${card.accentTo}/10 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-60`} />

              <div
                className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${card.accentFrom} ${card.accentTo} shadow-lg`}
              >
                <card.icon className="h-6 w-6 text-white" />
              </div>
              <div className="relative flex-1 min-w-0">
                <p className="text-sm font-semibold">{card.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.desc}</p>
              </div>
              <ArrowRight className="relative h-4 w-4 text-muted-foreground/30 transition-all group-hover:translate-x-1 group-hover:text-muted-foreground" />
            </Link>
          ))}
        </div>
      </div>

      {/* Quick Actions + Recent Activity */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Quick Actions */}
        <div className="lg:col-span-3">
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
            Quick Actions
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                href: "/dashboard/content-agent?tab=compose",
                icon: PenSquare,
                title: "Create Post",
                desc: "Write and schedule a new post",
                gradient: "from-blue-500/8 to-indigo-500/8",
                iconColor: "text-blue-600 dark:text-blue-400",
              },
              {
                href: "/dashboard/channels",
                icon: Share2,
                title: "Connect Channel",
                desc: "Add a social media account",
                gradient: "from-emerald-500/8 to-teal-500/8",
                iconColor: "text-emerald-600 dark:text-emerald-400",
              },
              {
                href: "/dashboard/content-agent?expanded=bulk",
                icon: Layers,
                title: "Bulk Create",
                desc: "Create multiple posts at once",
                gradient: "from-orange-500/8 to-red-500/8",
                iconColor: "text-orange-600 dark:text-orange-400",
              },
              {
                href: "/dashboard/autopilot/agents",
                icon: Bot,
                title: "Manage Agents",
                desc: "Configure autopilot AI agents",
                gradient: "from-cyan-500/8 to-blue-500/8",
                iconColor: "text-cyan-600 dark:text-cyan-400",
              },
            ].map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className="group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border border-border/40 bg-card/50 p-4 transition-all hover:border-border/60 hover:shadow-md active:scale-[0.99]"
              >
                <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${action.gradient} opacity-0 transition-opacity group-hover:opacity-100`} />
                <div className={`relative rounded-xl bg-background/60 p-2.5 ${action.iconColor}`}>
                  <action.icon className="h-5 w-5" />
                </div>
                <div className="relative flex-1">
                  <p className="text-sm font-medium">{action.title}</p>
                  <p className="text-xs text-muted-foreground">{action.desc}</p>
                </div>
                <ArrowRight className="relative h-4 w-4 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
              </Link>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="lg:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" />
            Recent Activity
          </h2>
          <div className="glass rounded-2xl p-4">
            <div className="space-y-2.5">
              {activityLoading ? (
                [1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 rounded-xl" />
                ))
              ) : activity && activity.length > 0 ? (
                activity.map((item: any) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 rounded-xl border border-border/30 bg-background/40 p-3 transition-colors hover:bg-background/60"
                  >
                    {item.status === "PUBLISHED" ? (
                      <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.postContent}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="rounded-md border-border/40 px-1.5 py-0 text-[10px]"
                        >
                          {item.platform}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
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
                        className="mt-0.5"
                      >
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-foreground" />
                      </a>
                    )}
                  </div>
                ))
              ) : (
                <div className="space-y-2.5">
                  {[
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
                      className="flex items-center gap-3 rounded-xl border border-border/30 bg-background/40 p-3"
                    >
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] font-semibold">
                        {item.step}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{item.title}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {item.desc}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="rounded-md border-border/40 px-1.5 py-0 text-[10px]"
                      >
                        <Clock className="mr-1 h-2.5 w-2.5" />
                        {item.time}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
