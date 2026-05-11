"use client";

import { useState, useEffect } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Send,
  Zap,
  Image,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  AlertTriangle,
  Globe,
  Newspaper,
} from "lucide-react";
import { cn } from "~/lib/utils";

interface ActivityItem {
  id: string;
  type: string;
  title: string;
  body: string;
  status: "success" | "error" | "pending" | "info";
  timestamp: Date;
  link?: string | null;
  metadata?: Record<string, any>;
}

const STATUS_CONFIG = {
  success: { icon: CheckCircle2, color: "text-green-500", bg: "bg-green-500/10", dot: "bg-green-500" },
  error: { icon: XCircle, color: "text-red-500", bg: "bg-red-500/10", dot: "bg-red-500" },
  pending: { icon: Loader2, color: "text-yellow-500", bg: "bg-yellow-500/10", dot: "bg-yellow-500" },
  info: { icon: Activity, color: "text-blue-500", bg: "bg-blue-500/10", dot: "bg-blue-500" },
};

const TYPE_ICONS: Record<string, any> = {
  "post.published": Send,
  "post.failed": XCircle,
  "post.scheduled": Clock,
  "post.created": Sparkles,
  "agent.completed": Zap,
  "agent.started": Zap,
  "image.generated": Image,
  "channel.connected": Globe,
  "channel.disconnected": AlertTriangle,
  "newsgrid.published": Newspaper,
  "repurpose.completed": RefreshCw,
};

function getStatus(type: string): ActivityItem["status"] {
  if (type.includes("failed") || type.includes("error") || type.includes("disconnected")) return "error";
  if (type.includes("published") || type.includes("completed") || type.includes("connected")) return "success";
  if (type.includes("started") || type.includes("scheduled") || type.includes("pending")) return "pending";
  return "info";
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ActivityPanel() {
  const [expanded, setExpanded] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Fetch notifications as activity items
  const { data, isLoading, refetch } = trpc.notification.list.useQuery(
    { limit: 30 },
    { refetchInterval: 10_000 }
  );

  // Also fetch recent post targets for publish status
  const postActivity = trpc.post.recentActivity.useQuery(
    { limit: 20 },
    { refetchInterval: 15_000 }
  );

  // Listen for SSE events to trigger refetch
  useEffect(() => {
    const es = new EventSource("/api/notifications/sse");
    es.onmessage = () => {
      refetch();
      postActivity.refetch();
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [refetch, postActivity]);

  // Merge notifications + post activity into unified feed
  const activities: ActivityItem[] = [];

  if (data?.notifications) {
    for (const n of data.notifications) {
      activities.push({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        status: getStatus(n.type),
        timestamp: new Date(n.createdAt),
        link: n.link,
        metadata: (n.metadata as Record<string, any>) || undefined,
      });
    }
  }

  if (postActivity.data) {
    for (const pt of postActivity.data) {
      const existing = activities.find((a) => a.metadata?.postTargetId === pt.id);
      if (existing) continue;
      activities.push({
        id: `pt-${pt.id}`,
        type: pt.status === "PUBLISHED" ? "post.published" : pt.status === "FAILED" ? "post.failed" : "post.scheduled",
        title: pt.status === "PUBLISHED" ? `Published to ${pt.platform}` : pt.status === "FAILED" ? `Failed on ${pt.platform}` : `Scheduled for ${pt.platform}`,
        body: pt.content ? (pt.content.length >= 100 ? pt.content.slice(0, 80) + "…" : pt.content) : "",
        status: pt.status === "PUBLISHED" ? "success" : pt.status === "FAILED" ? "error" : "pending",
        timestamp: new Date(
          pt.status === "PUBLISHED" ? (pt.publishedAt ?? pt.updatedAt) :
          pt.status === "SCHEDULED" ? (pt.scheduledAt ?? pt.updatedAt) :
          pt.updatedAt
        ),
        link: pt.postId ? `/dashboard/posts/${pt.postId}` : undefined,
        metadata: { postTargetId: pt.id, platform: pt.platform, channelName: pt.channelName },
      });
    }
  }

  // Sort by timestamp desc
  activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const feed = activities.slice(0, 40);

  // Count active items
  const pendingCount = feed.filter((a) => a.status === "pending").length;
  const errorCount = feed.filter((a) => a.status === "error").length;

  return (
    <div
      className={cn(
        "flex flex-col border-l border-border/40 bg-card/30 backdrop-blur-sm transition-all duration-300 ease-in-out",
        expanded ? "w-[300px]" : "w-10"
      )}
    >
      {/* Toggle button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex h-14 items-center justify-center border-b border-border/40 hover:bg-muted/50 transition-colors relative"
        title="Activity Feed"
      >
        <Activity className="h-4 w-4" />
        {!expanded && (pendingCount > 0 || errorCount > 0) && (
          <span className={cn(
            "absolute top-2.5 right-1.5 h-2 w-2 rounded-full animate-pulse",
            errorCount > 0 ? "bg-red-500" : "bg-yellow-500"
          )} />
        )}
      </button>

      {expanded && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
            <div className="flex items-center gap-1.5">
              <h3 className="text-xs font-semibold">Activity</h3>
              {pendingCount > 0 && (
                <Badge variant="secondary" className="h-4 px-1 text-[9px]">{pendingCount} active</Badge>
              )}
              {errorCount > 0 && (
                <Badge variant="destructive" className="h-4 px-1 text-[9px]">{errorCount} errors</Badge>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => { refetch(); postActivity.refetch(); }}>
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>

          {/* Activity Feed */}
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {isLoading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}

              {!isLoading && feed.length === 0 && (
                <div className="py-8 text-center">
                  <Activity className="h-6 w-6 text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-[10px] text-muted-foreground">No recent activity</p>
                </div>
              )}

              {feed.map((item) => {
                const config = STATUS_CONFIG[item.status];
                const TypeIcon = TYPE_ICONS[item.type] || config.icon;

                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (item.link) window.location.href = item.link;
                    }}
                    className={cn(
                      "w-full text-left rounded-lg p-2 transition-colors hover:bg-muted/50 group",
                      item.link && "cursor-pointer"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {/* Status indicator */}
                      <div className={cn("mt-0.5 rounded-md p-1", config.bg)}>
                        <TypeIcon className={cn("h-3 w-3", config.color, item.status === "pending" && "animate-spin")} />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <p className="text-[11px] font-medium leading-tight truncate">
                            {item.title}
                          </p>
                          <span className="text-[9px] text-muted-foreground shrink-0">
                            {timeAgo(item.timestamp)}
                          </span>
                        </div>
                        {item.body && (
                          <p className="text-[10px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                            {item.body}
                          </p>
                        )}
                        {item.metadata?.platform && (
                          <Badge variant="outline" className="mt-1 h-3.5 px-1 text-[8px]">
                            {item.metadata.channelName || item.metadata.platform}
                          </Badge>
                        )}
                      </div>

                      {item.link && (
                        <ChevronRight className="h-3 w-3 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors mt-1 shrink-0" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>

          {/* Footer stats */}
          <div className="border-t border-border/40 px-3 py-1.5 flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground">
              {feed.length} recent events
            </span>
            <div className="flex items-center gap-1.5">
              {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
                const count = feed.filter((a) => a.status === key).length;
                if (count === 0) return null;
                return (
                  <div key={key} className="flex items-center gap-0.5">
                    <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
                    <span className="text-[9px] text-muted-foreground">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
