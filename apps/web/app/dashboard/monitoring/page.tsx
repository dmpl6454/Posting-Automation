"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  Monitor,
  Globe,
  Server,
  Zap,
  Send,
  XCircle,
} from "lucide-react";
import { useToast } from "~/hooks/use-toast";

const SOURCE_ICONS: Record<string, any> = {
  frontend: Globe,
  api: Server,
  worker: Zap,
  publish: Send,
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500 text-white",
  error: "bg-orange-500 text-white",
  warning: "bg-yellow-500 text-black",
};

export default function MonitoringPage() {
  const { toast } = useToast();
  const [source, setSource] = useState<string>("all");
  const [resolved, setResolved] = useState(false);
  const [copied, setCopied] = useState(false);

  const stats = trpc.monitor.stats.useQuery(undefined, { refetchInterval: 30_000 });
  const errors = trpc.monitor.list.useQuery(
    { source: source as any, resolved, limit: 50 },
    { refetchInterval: 15_000 }
  );
  const claudeReport = trpc.monitor.exportForClaude.useQuery(
    { unresolvedOnly: true, limit: 20 },
    { enabled: false }
  );

  const resolveMut = trpc.monitor.resolve.useMutation({
    onSuccess: () => {
      errors.refetch();
      stats.refetch();
      toast({ title: "Error resolved" });
    },
  });

  const bulkResolveMut = trpc.monitor.bulkResolve.useMutation({
    onSuccess: () => {
      errors.refetch();
      stats.refetch();
      toast({ title: "All resolved" });
    },
  });

  const handleCopyForClaude = async () => {
    const result = await claudeReport.refetch();
    if (result.data?.report) {
      navigator.clipboard.writeText(result.data.report);
      setCopied(true);
      toast({ title: "Copied to clipboard", description: "Paste this into Claude to get fix suggestions" });
      setTimeout(() => setCopied(false), 3000);
    }
  };

  const s = stats.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Monitor className="h-5 w-5 text-blue-500" />
            Error Monitoring
          </h1>
          <p className="text-xs text-muted-foreground">Track bugs and issues across frontend, API, and workers</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { errors.refetch(); stats.refetch(); }}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
          <Button size="sm" onClick={handleCopyForClaude} disabled={claudeReport.isFetching}>
            {claudeReport.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : copied ? (
              <Check className="h-3.5 w-3.5 mr-1.5 text-green-400" />
            ) : (
              <Copy className="h-3.5 w-3.5 mr-1.5" />
            )}
            Copy Report for Claude
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-2xl font-bold text-red-500">{s.unresolved}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Unresolved</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-2xl font-bold text-orange-500">{s.last24h}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Last 24h</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-2xl font-bold text-yellow-500">{s.lastWeek}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Last 7 days</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-2xl font-bold text-green-500">{s.total - s.unresolved}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Resolved</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Source breakdown */}
      {s && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(s.bySource).map(([src, count]) => {
            const Icon = SOURCE_ICONS[src] || Bug;
            return (
              <Badge key={src} variant="outline" className="gap-1.5 px-2.5 py-1">
                <Icon className="h-3 w-3" />
                {src}: {count as number}
              </Badge>
            );
          })}
          {Object.entries(s.bySeverity).map(([sev, count]) => (
            <Badge key={sev} className={`gap-1 px-2.5 py-1 ${SEVERITY_COLORS[sev] || ""}`}>
              {sev}: {count as number}
            </Badge>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Tabs value={source} onValueChange={setSource}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="frontend">Frontend</TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
            <TabsTrigger value="worker">Worker</TabsTrigger>
            <TabsTrigger value="publish">Publish</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant={resolved ? "default" : "outline"}
          size="sm"
          onClick={() => setResolved(!resolved)}
          className="text-xs"
        >
          {resolved ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
          {resolved ? "Showing Resolved" : "Showing Open"}
        </Button>
        {!resolved && errors.data && errors.data.errors.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => {
              const ids = errors.data!.errors.map((e) => e.id);
              bulkResolveMut.mutate({ ids });
            }}
            disabled={bulkResolveMut.isPending}
          >
            {bulkResolveMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
            Resolve All
          </Button>
        )}
      </div>

      {/* Error List */}
      <div className="space-y-3">
        {errors.isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {errors.data?.errors.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-2" />
              <p className="text-sm font-medium">No {resolved ? "resolved" : "open"} errors</p>
              <p className="text-xs text-muted-foreground mt-1">
                {resolved ? "All resolved errors will appear here" : "Everything is running smoothly"}
              </p>
            </CardContent>
          </Card>
        )}

        {errors.data?.errors.map((err) => {
          const Icon = SOURCE_ICONS[err.source] || Bug;
          const meta = (err.metadata || {}) as Record<string, any>;
          return (
            <Card key={err.id} className={`border-l-4 ${
              err.severity === "critical" ? "border-l-red-500" :
              err.severity === "error" ? "border-l-orange-500" : "border-l-yellow-500"
            }`}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <Badge className={`text-[10px] ${SEVERITY_COLORS[err.severity] || ""}`}>
                        {err.severity}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">{err.source}</Badge>
                      {err.occurrences > 1 && (
                        <Badge variant="secondary" className="text-[10px]">{err.occurrences}x</Badge>
                      )}
                      {err.endpoint && (
                        <span className="text-[10px] text-muted-foreground font-mono truncate">{err.endpoint}</span>
                      )}
                    </div>
                    <p className="text-sm font-medium leading-snug">{err.message}</p>
                    {err.stack && (
                      <pre className="mt-2 text-[10px] text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-24 leading-relaxed">
                        {err.stack.split("\n").slice(0, 4).join("\n")}
                      </pre>
                    )}
                    {Object.keys(meta).length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {meta.platform && <Badge variant="outline" className="text-[10px]">{meta.platform}</Badge>}
                        {meta.postId && <Badge variant="outline" className="text-[10px] font-mono">post: {meta.postId.slice(0, 8)}</Badge>}
                        {meta.errorType && <Badge variant="outline" className="text-[10px]">{meta.errorType}</Badge>}
                        {meta.type && <Badge variant="outline" className="text-[10px]">{meta.type}</Badge>}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                      <span>First: {new Date(err.firstSeenAt).toLocaleString()}</span>
                      <span>Last: {new Date(err.lastSeenAt).toLocaleString()}</span>
                    </div>
                  </div>
                  {!err.resolved && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-xs"
                      onClick={() => resolveMut.mutate({ id: err.id })}
                      disabled={resolveMut.isPending}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      Resolve
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
