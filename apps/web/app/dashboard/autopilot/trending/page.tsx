"use client";

import { trpc } from "~/lib/trpc/client";
import { Badge } from "~/components/ui/badge";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { TrendingUp, ExternalLink } from "lucide-react";

function sourceTypeBadge(type: string) {
  const colors: Record<string, string> = {
    RSS: "bg-orange-100 text-orange-700 border-orange-200",
    TWITTER: "bg-blue-100 text-blue-700 border-blue-200",
    REDDIT: "bg-red-100 text-red-700 border-red-200",
    NEWS: "bg-emerald-100 text-emerald-700 border-emerald-200",
    HACKERNEWS: "bg-amber-100 text-amber-700 border-amber-200",
  };
  return (
    <Badge
      variant="outline"
      className={colors[type] ?? ""}
    >
      {type}
    </Badge>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "NEW":
      return <Badge variant="default">New</Badge>;
    case "SCORED":
      return <Badge variant="secondary">Scored</Badge>;
    case "ASSIGNED":
      return (
        <Badge variant="outline" className="border-blue-200 text-blue-700">
          Assigned
        </Badge>
      );
    case "GENERATED":
      return (
        <Badge variant="outline" className="border-green-200 text-green-700">
          Generated
        </Badge>
      );
    case "DISMISSED":
      return (
        <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground">
          Dismissed
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function TrendingPage() {
  const { data, isLoading } = trpc.autopilot.trendingItems.useQuery({});

  const items = (data as any)?.items ?? [];

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="p-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <TrendingUp className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No trending items yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Run the pipeline to discover trending topics from your configured
            sources.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item: any) => (
            <Card key={item.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-2">
                  {/* Title + external link */}
                  <div className="flex items-start gap-2">
                    {item.sourceUrl ? (
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium hover:underline"
                      >
                        {item.title}
                        <ExternalLink className="ml-1 inline h-3 w-3 text-muted-foreground" />
                      </a>
                    ) : (
                      <p className="text-sm font-medium">{item.title}</p>
                    )}
                  </div>

                  {/* Meta row */}
                  <div className="flex flex-wrap items-center gap-2">
                    {sourceTypeBadge(item.sourceType)}
                    {item.sourceName && (
                      <span className="text-xs text-muted-foreground">
                        {item.sourceName}
                      </span>
                    )}
                    {statusBadge(item.status)}
                    {item.score != null && (
                      <span className="text-xs font-medium text-muted-foreground">
                        Score: {item.score}
                      </span>
                    )}
                    {item.publishedAt && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(item.publishedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  {/* Topics */}
                  {item.topics?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {item.topics.map((topic: string, idx: number) => (
                        <Badge
                          key={idx}
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0"
                        >
                          {topic}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
