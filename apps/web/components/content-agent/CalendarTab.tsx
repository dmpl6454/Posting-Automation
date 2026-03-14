"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
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

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  PUBLISHED: "bg-green-500/15 text-green-700 dark:text-green-400",
  PUBLISHING: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  FAILED: "bg-red-500/15 text-red-700 dark:text-red-400",
  DRAFT: "bg-gray-500/15 text-gray-700 dark:text-gray-400",
  CANCELLED: "bg-gray-500/15 text-gray-500",
};

const FILTER_OPTIONS = ["ALL", "SCHEDULED", "PUBLISHED", "FAILED", "DRAFT"] as const;

export function CalendarTab() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const { data: scheduledData, isLoading: scheduledLoading } = trpc.post.list.useQuery({
    status: statusFilter === "ALL" ? undefined : (statusFilter as any),
    limit: 200,
  });

  const posts = scheduledData?.posts ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>{format(currentDate, "MMMM yyyy")}</CardTitle>
            <div className="flex items-center gap-3">
              {/* Status filter */}
              <div className="flex items-center gap-1">
                <Filter className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
                {FILTER_OPTIONS.map((opt) => (
                  <Button
                    key={opt}
                    variant={statusFilter === opt ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setStatusFilter(opt)}
                  >
                    {opt === "ALL"
                      ? "All"
                      : opt.charAt(0) + opt.slice(1).toLowerCase()}
                  </Button>
                ))}
              </div>
              {/* Month navigation */}
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setCurrentDate(subMonths(currentDate, 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentDate(new Date())}
                >
                  Today
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setCurrentDate(addMonths(currentDate, 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {scheduledLoading ? (
            <Skeleton className="h-96 rounded-lg" />
          ) : (
            <>
              {/* Day headers */}
              <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted-foreground">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} className="py-2">
                    {d}
                  </div>
                ))}
              </div>

              {/* Calendar grid */}
              <div className="grid grid-cols-7 gap-1">
                {/* Padding for first day */}
                {Array.from({ length: monthStart.getDay() }).map((_, i) => (
                  <div key={`pad-${i}`} className="min-h-[100px] rounded-lg" />
                ))}
                {days.map((day) => {
                  const dayPosts = posts.filter((p: any) => {
                    const date = p.scheduledAt ?? p.publishedAt ?? p.createdAt;
                    return date && isSameDay(new Date(date), day);
                  });
                  const isToday = isDateToday(day);
                  return (
                    <div
                      key={day.toISOString()}
                      className={`min-h-[100px] rounded-lg border p-1.5 transition-colors ${
                        isToday
                          ? "border-primary bg-primary/5"
                          : "border-transparent hover:border-muted-foreground/20 hover:bg-muted/30"
                      }`}
                    >
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                          isToday
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {format(day, "d")}
                      </span>
                      <div className="mt-1 space-y-0.5">
                        {dayPosts.slice(0, 3).map((post: any) => (
                          <Link
                            key={post.id}
                            href={`/dashboard/posts/${post.id}`}
                            className={`block truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80 ${
                              STATUS_COLORS[post.status] ?? STATUS_COLORS.DRAFT
                            }`}
                          >
                            {post.content.slice(0, 25)}
                          </Link>
                        ))}
                        {dayPosts.length > 3 && (
                          <Badge variant="secondary" className="h-4 text-[9px]">
                            +{dayPosts.length - 3} more
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Legend */}
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3">
                <span className="text-xs text-muted-foreground">Status:</span>
                {Object.entries(STATUS_COLORS)
                  .filter(([k]) => k !== "CANCELLED")
                  .map(([status, color]) => (
                    <div key={status} className="flex items-center gap-1.5">
                      <div
                        className={`h-2.5 w-2.5 rounded-full ${color
                          .replace(/text-\S+/g, "")
                          .trim()}`}
                      />
                      <span className="text-xs text-muted-foreground">
                        {status.charAt(0) + status.slice(1).toLowerCase()}
                      </span>
                    </div>
                  ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
