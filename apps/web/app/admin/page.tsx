"use client";

import {
  Users,
  Building2,
  FileText,
  Radio,
  Bot,
} from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { StatCard } from "~/components/admin/StatCard";
import { QueueHealthCard } from "~/components/admin/QueueHealthCard";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";

/** Compact relative age for the activity feed ("2h ago"). */
function timeAgo(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

export default function AdminOverviewPage() {
  const { data: stats, isLoading } = trpc.admin.overview.stats.useQuery();

  if (isLoading || !stats) {
    return (
      <div className="w-full space-y-5">
        {/* Admin-console page header: plain bold title + sub. Titled "Overview"
          to match the sidebar entry and the top bar — it read "Dashboard"
          here, which is also the name of the user-facing app. */}
      <div className="min-w-0">
        <h1 className="text-[29px] font-bold leading-[1.1] tracking-[-0.01em]">Overview</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Platform-wide totals across every workspace.
        </p>
      </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] w-full rounded-[12px]" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-[12px]" />
          <Skeleton className="h-64 w-full rounded-[12px]" />
        </div>
      </div>
    );
  }

  const postsData = stats.posts as Record<string, number>;
  const totalPosts = Object.values(postsData).reduce((a, b) => a + b, 0);
  const publishedCount = postsData["PUBLISHED"] ?? 0;
  const failedCount = postsData["FAILED"] ?? 0;

  const queueHealthData = Object.entries(stats.queueHealth).map(
    ([name, counts]: [string, any]) => ({
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    })
  );

  return (
    <div className="w-full space-y-5">
      {/* Admin-console page header: plain bold title + sub. Titled "Overview"
          to match the sidebar entry and the top bar — it read "Dashboard"
          here, which is also the name of the user-facing app. */}
      <div className="min-w-0">
        <h1 className="text-[29px] font-bold leading-[1.1] tracking-[-0.01em]">Overview</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Platform-wide totals across every workspace.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard title="Users" value={stats.users} icon={Users} />
        <StatCard
          title="Organizations"
          value={stats.organizations}
          icon={Building2}
        />
        <StatCard
          title="Posts"
          value={totalPosts}
          icon={FileText}
          description={`${publishedCount} published / ${failedCount} failed`}
        />
        <StatCard title="Channels" value={stats.channels} icon={Radio} />
        <StatCard title="Agents" value={stats.agents} icon={Bot} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <QueueHealthCard queues={queueHealthData} />

        <Card className="rounded-[12px]">
          <CardHeader className="p-4 pb-0">
            <CardTitle className="text-[13px] font-semibold">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <div className="space-y-2">
              {stats.recentAuditLogs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No recent activity
                </p>
              )}
              {stats.recentAuditLogs.map((log: any) => (
                <div
                  key={log.id}
                  className="flex items-start justify-between gap-2 rounded-[10px] border border-border px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold leading-[1.3]">
                      {log.user?.name ?? log.user?.email ?? "System"}
                    </p>
                    <p className="mt-0.5 truncate text-[11.5px] leading-[1.3] text-muted-foreground">
                      {log.action}
                      {log.organization ? ` in ${log.organization.name}` : ""}
                    </p>
                  </div>
                  {/* Design: relative age, not an absolute date — "2h ago" reads
                      as recency at a glance on an activity feed. */}
                  <span
                    className="shrink-0 text-[11px] leading-none text-faint"
                    title={new Date(log.createdAt).toLocaleString()}
                  >
                    {timeAgo(new Date(log.createdAt))}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
