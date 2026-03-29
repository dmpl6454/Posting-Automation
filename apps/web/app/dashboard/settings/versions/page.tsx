"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import {
  GitBranch,
  GitCommit,
  Clock,
  RotateCcw,
  CheckCircle2,
  XCircle,
  ArrowDownCircle,
  Loader2,
  Copy,
  Check,
  Package,
} from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  active: { label: "Active", color: "bg-green-500/10 text-green-600 border-green-500/20", icon: CheckCircle2 },
  superseded: { label: "Superseded", color: "bg-muted text-muted-foreground border-border", icon: ArrowDownCircle },
  rolled_back: { label: "Rolled Back", color: "bg-red-500/10 text-red-600 border-red-500/20", icon: XCircle },
};

function timeAgo(date: string | Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function VersionsPage() {
  const { toast } = useToast();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: current, isLoading: currentLoading } = trpc.deployment.current.useQuery();
  const { data: deployments, isLoading: listLoading, refetch } = trpc.deployment.list.useQuery({ limit: 30 });
  const rollback = trpc.deployment.rollback.useMutation({
    onSuccess: (result) => {
      toast({
        title: "Rollback initiated",
        description: result.message,
      });
      refetch();
    },
    onError: (err) => {
      toast({ title: "Rollback failed", description: err.message, variant: "destructive" });
    },
  });

  const copyHash = (hash: string, id: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Current version from build-time env vars (always available, even without DB)
  const buildVersion = process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0-dev";
  const buildHash = process.env.NEXT_PUBLIC_COMMIT_HASH || "unknown";
  const buildDate = process.env.NEXT_PUBLIC_COMMIT_DATE || "";
  const buildBranch = process.env.NEXT_PUBLIC_BRANCH || "main";
  const buildMsg = process.env.NEXT_PUBLIC_COMMIT_MSG || "";
  const buildTime = process.env.NEXT_PUBLIC_BUILD_TIME || "";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Version History</h1>
        <p className="text-muted-foreground">
          Track deployments, view changes, and rollback if needed
        </p>
      </div>

      {/* Current Version Card */}
      <Card className="border-green-500/20 bg-green-500/[0.02]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-green-600" />
              <CardTitle className="text-lg">Current Version</CardTitle>
            </div>
            <Badge className="bg-green-500/10 text-green-600 border-green-500/20">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Live
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {currentLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Version</p>
                <p className="text-xl font-bold font-mono">v{current?.version || buildVersion}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Commit</p>
                <div className="flex items-center gap-1.5">
                  <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                  <code className="text-sm font-mono">{current?.commitHash || buildHash}</code>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Branch</p>
                <div className="flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm">{current?.branch || buildBranch}</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Deployed</p>
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm">
                    {buildTime ? timeAgo(buildTime) : current?.commitDate ? timeAgo(current.commitDate) : "—"}
                  </span>
                </div>
              </div>
              {(current?.commitMsg || buildMsg) && (
                <div className="sm:col-span-2 lg:col-span-4">
                  <p className="text-xs text-muted-foreground">Last Commit</p>
                  <p className="text-sm mt-0.5 truncate">{current?.commitMsg || buildMsg}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deployment History */}
      <Card>
        <CardHeader>
          <CardTitle>Deployment History</CardTitle>
          <CardDescription>
            All deployments with rollback capability
          </CardDescription>
        </CardHeader>
        <CardContent>
          {listLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : !deployments?.items.length ? (
            <div className="flex flex-col items-center py-12 text-center">
              <Package className="h-10 w-10 text-muted-foreground/30" />
              <h3 className="mt-4 text-sm font-medium">No deployments recorded yet</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Deployments will appear here after the first push to production.
                <br />
                The current build version is <code className="font-mono">v{buildVersion}</code> ({buildHash}).
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {deployments.items.map((dep: any) => {
                const config = STATUS_CONFIG[dep.status] ?? STATUS_CONFIG["superseded"]!;
                const StatusIcon = config.icon;
                const isActive = dep.status === "active";

                return (
                  <div
                    key={dep.id}
                    className={`flex items-center gap-4 rounded-lg border p-3 transition-colors ${
                      isActive ? "border-green-500/20 bg-green-500/[0.02]" : "hover:bg-muted/50"
                    }`}
                  >
                    {/* Status icon */}
                    <div className="shrink-0">
                      <StatusIcon className={`h-5 w-5 ${
                        isActive ? "text-green-600" : dep.status === "rolled_back" ? "text-red-500" : "text-muted-foreground"
                      }`} />
                    </div>

                    {/* Version info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-sm">v{dep.version}</span>
                        <Badge variant="outline" className={`text-[10px] ${config.color}`}>
                          {config.label}
                        </Badge>
                        <button
                          onClick={() => copyHash(dep.commitHash, dep.id)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-mono"
                          title="Copy commit hash"
                        >
                          <GitCommit className="h-3 w-3" />
                          {dep.commitHash}
                          {copiedId === dep.id ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                          )}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-lg">
                        {dep.commitMsg}
                      </p>
                      {dep.changelog && (
                        <details className="mt-1">
                          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                            View changelog
                          </summary>
                          <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded p-2">
                            {dep.changelog}
                          </pre>
                        </details>
                      )}
                    </div>

                    {/* Timestamp */}
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-muted-foreground">{timeAgo(dep.createdAt)}</p>
                      <p className="text-[10px] text-muted-foreground/60">
                        {new Date(dep.createdAt).toLocaleDateString()}
                      </p>
                    </div>

                    {/* Rollback button */}
                    {!isActive && dep.status !== "rolled_back" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 gap-1.5"
                        onClick={() => {
                          if (confirm(`Rollback to v${dep.version} (${dep.commitHash})?`)) {
                            rollback.mutate({ deploymentId: dep.id });
                          }
                        }}
                        disabled={rollback.isPending}
                      >
                        {rollback.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Rollback
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
