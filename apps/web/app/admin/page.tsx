"use client";

import {
  Users,
  Building2,
  FileText,
  Radio,
  Bot,
  Clock,
} from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { StatCard } from "~/components/admin/StatCard";
import { QueueHealthCard } from "~/components/admin/QueueHealthCard";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";

export default function AdminOverviewPage() {
  const { data: stats, isLoading } = trpc.admin.overview.stats.useQuery();

  if (isLoading || !stats) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
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
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <QueueHealthCard queues={queueHealthData} />

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats.recentAuditLogs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No recent activity
                </p>
              )}
              {stats.recentAuditLogs.map((log: any) => (
                <div
                  key={log.id}
                  className="flex items-start justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {log.user?.name ?? log.user?.email ?? "System"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {log.action}
                      {log.organization ? ` in ${log.organization.name}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(log.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
