"use client";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
  AlertTriangle,
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
  // Fix #75: track a pending rollback target so we can show a banner
  const [pendingRollback, setPendingRollback] = useState<{
    version: string;
    commitHash: string;
  } | null>(null);

  const { data: current, isLoading: currentLoading } = trpc.deployment.current.useQuery();
  const { data: deployments, isLoading: listLoading, refetch } = trpc.deployment.list.useQuery({ limit: 30 });
  const rollback = trpc.deployment.rollback.useMutation({
    onSuccess: (result) => {
      // Fix #75: honest message — DB-only rollback, user must run deploy script
      setPendingRollback({
        version: result.targetVersion,
        commitHash: result.targetCommit,
      });
      toast({
        title: "Rollback requested",
        description: `Rollback to v${result.targetVersion} recorded. Run the deploy script on the server to complete.`,
      });
      refetch();
    },
    onError: (err) => {
      toast({ title: "Rollback failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  const copyHash = (hash: string, id: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Fix #73/#74: build-time env vars are now only used for the "Build" sanity badge.
  // They are NOT used as a data source for version info — the DB is the authority.
  const buildHash = process.env.NEXT_PUBLIC_COMMIT_HASH;
  const buildVersion = process.env.NEXT_PUBLIC_APP_VERSION;

  // Detect if the live container's build hash differs from the active DB record
  // (e.g. a deploy happened but the DB row hasn't been written yet).
  const hashMismatch =
    buildHash &&
    buildHash !== "unknown" &&
    current?.commitHash &&
    current.commitHash !== buildHash;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Version History</h1>
        <p className="text-muted-foreground">
          Track deployments, view changes, and rollback if needed
        </p>
      </div>

      {/* Fix #75: Pending rollback banner */}
      {pendingRollback && (
        <Alert variant="destructive" className="border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-400">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Rollback Pending</AlertTitle>
          <AlertDescription>
            Rollback to <code className="font-mono">v{pendingRollback.version}</code> (
            <code className="font-mono">{pendingRollback.commitHash}</code>) has been recorded in the
            database. The running containers still serve the old version until you SSH into the server and
            run:{" "}
            <code className="inline-block mt-1 rounded bg-orange-500/20 px-1.5 py-0.5 font-mono text-xs">
              bash scripts/deploy.sh deploy
            </code>
          </AlertDescription>
        </Alert>
      )}

      {/* Fix #73/#74: Hash mismatch warning (DB not yet updated after a recent deploy) */}
      {hashMismatch && (
        <Alert className="border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Version mismatch detected</AlertTitle>
          <AlertDescription>
            The running build hash (<code className="font-mono">{buildHash}</code>) does not match the
            active deployment in the database (<code className="font-mono">{current?.commitHash}</code>).
            The deploy script may not have registered this build yet.
          </AlertDescription>
        </Alert>
      )}

      {/* Current Version Card */}
      <Card className="border-green-500/20 bg-green-500/[0.02]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-green-600" />
              <CardTitle className="text-lg">Current Version</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {/* Fix #73/#74: small "Build" sanity badge from env vars — not the primary source */}
              {buildVersion && buildVersion !== "1.0.0-dev" && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  Build {buildVersion}
                </Badge>
              )}
              <Badge className="bg-green-500/10 text-green-600 border-green-500/20">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Live
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {currentLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Version</p>
                <p className="text-xl font-bold font-mono">v{current?.version ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Commit</p>
                <div className="flex items-center gap-1.5">
                  <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                  <code className="text-sm font-mono">{current?.commitHash ?? "unknown"}</code>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Branch</p>
                <div className="flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm">{current?.branch ?? "main"}</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Deployed</p>
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm">
                    {current?.commitDate ? timeAgo(current.commitDate) : "—"}
                  </span>
                </div>
              </div>
              {current?.commitMsg && (
                <div className="sm:col-span-2 lg:col-span-4">
                  <p className="text-xs text-muted-foreground">Last Commit</p>
                  <p className="text-sm mt-0.5 truncate">{current.commitMsg}</p>
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

                    {/* Rollback button — only on non-active, non-already-rolled-back rows */}
                    {!isActive && dep.status !== "rolled_back" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 gap-1.5"
                        onClick={() => {
                          if (
                            confirm(
                              `Request rollback to v${dep.version} (${dep.commitHash})?\n\nNote: you will need to run the deploy script on the server to complete the rollback.`
                            )
                          ) {
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
