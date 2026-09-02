"use client";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import {
  GitBranch,
  GitCommit,
  Clock,
  RotateCcw,
  CheckCircle2,
  Loader2,
  Copy,
  Check,
  Package,
  AlertTriangle,
  Info,
} from "lucide-react";

/* Literal hex, NOT Tailwind scale classes: this project's Tailwind config
   flattens the green/red/orange/yellow scales onto the palette's status
   triplets, so `bg-green-500/10 text-green-600` rendered the label the same
   colour as its own background. `color: ""` means "use the muted default". */
const OK = "#5cb85c";
const BAD = "#d9695f";
const WARN = "#e0b84a";
const PENDING = "#e08a4a";

/* The design's history row carries no status icon — the coloured pill already
   says what the row's state is, so an icon column was redundant and pushed
   every other cell right. */
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: OK },
  superseded: { label: "Superseded", color: "" },
  rolled_back: { label: "Rolled Back", color: BAD },
};

const CARD_TITLE = "text-[14.5px] font-semibold leading-[1.2]";
const OUTLINE_BTN =
  "h-[30px] shrink-0 gap-1.5 rounded-[8px] border-border2 px-3 text-[11.5px] font-medium hover:bg-hover";

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
    /* Design stacks sections on 20px, not 24px. */
    <div className="w-full space-y-5">
      {/* Page header — eyebrow / display title / subtitle (design restyle) */}
      <div className="min-w-0">
        <span className="eyebrow">Versions</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Every deploy, on record.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Track deployments, view changes, and roll back if needed
        </p>
      </div>

      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.65] text-muted-foreground">
          Each deploy is recorded here with commit SHA and timestamp. Click Rollback to mark a prior
          version as active; the deploy script on the server (
          <code className="font-mono text-[11.5px]">bash scripts/deploy.sh deploy</code>) completes
          the revert.
        </p>
      </div>

      {/* Fix #75: Pending rollback banner */}
      {pendingRollback && (
        <div
          className="flex items-start gap-3 rounded-[12px] border px-4 py-3.5"
          style={{ borderColor: `${PENDING}55`, background: `${PENDING}14` }}
        >
          <AlertTriangle
            className="mt-px h-[15px] w-[15px] shrink-0"
            style={{ color: PENDING }}
          />
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold leading-none" style={{ color: PENDING }}>
              Rollback Pending
            </p>
            <p className="mt-1.5 text-[12px] leading-[1.65]" style={{ color: PENDING }}>
              Rollback to <code className="font-mono">v{pendingRollback.version}</code> (
              <code className="font-mono">{pendingRollback.commitHash}</code>) has been recorded in
              the database. The running containers still serve the old version until you SSH into
              the server and run:{" "}
              <code
                className="mt-1 inline-block rounded-[5px] px-1.5 py-0.5 font-mono text-[11.5px]"
                style={{ background: `${PENDING}2e` }}
              >
                bash scripts/deploy.sh deploy
              </code>
            </p>
          </div>
        </div>
      )}

      {/* Fix #73/#74: Hash mismatch warning (DB not yet updated after a recent deploy) */}
      {hashMismatch && (
        <div
          className="flex items-start gap-3 rounded-[12px] border px-4 py-3.5"
          style={{ borderColor: `${WARN}55`, background: `${WARN}14` }}
        >
          <AlertTriangle className="mt-px h-[15px] w-[15px] shrink-0" style={{ color: WARN }} />
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold leading-none" style={{ color: WARN }}>
              Version mismatch detected
            </p>
            <p className="mt-1.5 text-[12px] leading-[1.65]" style={{ color: WARN }}>
              The running build hash (<code className="font-mono">{buildHash}</code>) does not match
              the active deployment in the database (
              <code className="font-mono">{current?.commitHash}</code>). The deploy script may not
              have registered this build yet.
            </p>
          </div>
        </div>
      )}

      {/* Current Version Card */}
      <div
        className="rounded-[14px] border bg-card p-[22px]"
        style={{ borderColor: `${OK}40` }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Package className="h-[17px] w-[17px]" style={{ color: OK }} />
            <h2 className="text-[15px] font-semibold leading-[1.2]">Current Version</h2>
          </div>
          <div className="flex items-center gap-2">
            {/* Fix #73/#74: small "Build" sanity badge from env vars — not the primary source */}
            {buildVersion && buildVersion !== "1.0.0-dev" && (
              <span className="rounded-[5px] border border-border2 px-2 py-px text-[10px] font-medium leading-[1.6] text-muted-foreground">
                Build {buildVersion}
              </span>
            )}
            <span
              className="flex items-center gap-[5px] rounded-full border px-2.5 py-[3px] text-[11px] font-semibold leading-[1.6]"
              style={{ background: `${OK}26`, color: OK, borderColor: `${OK}4d` }}
            >
              <CheckCircle2 className="h-[11px] w-[11px]" />
              Live
            </span>
          </div>
        </div>
        {currentLoading ? (
          <Skeleton className="mt-4 h-16 w-full rounded-[10px]" />
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-[11px] leading-none text-muted-foreground">Version</p>
              <p className="mt-1 font-mono text-[16px] font-bold leading-none">
                v{current?.version ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] leading-none text-muted-foreground">Commit</p>
              <div className="mt-1 flex items-center gap-1.5">
                <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                <code className="font-mono text-[13px] font-medium leading-none">
                  {current?.commitHash ?? "unknown"}
                </code>
              </div>
            </div>
            <div>
              <p className="text-[11px] leading-none text-muted-foreground">Branch</p>
              <div className="mt-1 flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[13px] font-medium leading-none">
                  {current?.branch ?? "main"}
                </span>
              </div>
            </div>
            <div>
              <p className="text-[11px] leading-none text-muted-foreground">Deployed</p>
              <div className="mt-1 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[13px] font-medium leading-none">
                  {current?.commitDate ? timeAgo(current.commitDate) : "—"}
                </span>
              </div>
            </div>
            {current?.commitMsg && (
              <div className="min-w-0 sm:col-span-2 lg:col-span-4">
                <p className="text-[11px] leading-none text-muted-foreground">Last Commit</p>
                <p className="mt-1 truncate text-[13px] leading-[1.4]">{current.commitMsg}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Deployment History */}
      <div>
        <h2 className={CARD_TITLE}>Deployment History</h2>
        <p className="mt-[5px] text-[12px] leading-[1.5] text-muted-foreground">
          All deployments with rollback capability
        </p>
        <div className="mt-3">
          {listLoading ? (
            <div className="flex flex-col gap-2.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-[12px]" />
              ))}
            </div>
          ) : !deployments?.items.length ? (
            <div className="flex flex-col items-center rounded-[14px] border border-border bg-card py-12 text-center">
              <Package className="h-8 w-8 text-tile" />
              <h3 className="mt-3 text-[13px] font-medium">No deployments recorded yet</h3>
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Deployments will appear here after the first push to production.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {deployments.items.map((dep: any) => {
                const config = STATUS_CONFIG[dep.status] ?? STATUS_CONFIG["superseded"]!;
                const isActive = dep.status === "active";

                return (
                  /* One line, as the design has it:
                     version · status · hash · message · time · Rollback.
                     The message used to sit on a second line under the hash,
                     which doubled the row height and left the right half of
                     every row empty. */
                  <div
                    key={dep.id}
                    className="flex flex-wrap items-center gap-3.5 rounded-[12px] border bg-card px-[18px] py-3.5 transition-colors"
                    style={{
                      borderColor: isActive ? `${OK}40` : "hsl(var(--border))",
                    }}
                  >
                    <span className="shrink-0 font-mono text-[13px] font-bold leading-none">
                      v{dep.version}
                    </span>
                    <span
                      className="shrink-0 rounded-[5px] px-[9px] py-0.5 text-[10px] font-semibold leading-[1.6]"
                      style={
                        config.color
                          ? { background: `${config.color}22`, color: config.color }
                          : { background: "hsl(var(--tile))", color: "hsl(var(--muted-foreground))" }
                      }
                    >
                      {config.label}
                    </span>
                    <button
                      onClick={() => copyHash(dep.commitHash, dep.id)}
                      className="group flex shrink-0 items-center gap-1 font-mono text-[11px] leading-none text-faint hover:text-foreground"
                      title="Copy commit hash"
                    >
                      <GitCommit className="h-3 w-3" />
                      {dep.commitHash}
                      {copiedId === dep.id ? (
                        <Check className="h-3 w-3" style={{ color: OK }} />
                      ) : (
                        <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                      )}
                    </button>

                    <div className="min-w-[150px] flex-1">
                      <p className="truncate text-[12px] leading-[1.4] text-muted-foreground">
                        {dep.commitMsg}
                      </p>
                      {dep.changelog && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-faint hover:text-foreground">
                            View changelog
                          </summary>
                          <pre className="mt-1.5 whitespace-pre-wrap rounded-[8px] border border-border2 bg-surface1 p-2 font-mono text-[11.5px] text-muted-foreground">
                            {dep.changelog}
                          </pre>
                        </details>
                      )}
                    </div>

                    {/* Single relative time, as the design shows. The exact
                        date moves to the tooltip rather than a second line. */}
                    <span
                      className="shrink-0 text-[11px] leading-none text-faint"
                      title={new Date(dep.createdAt).toLocaleString()}
                    >
                      {timeAgo(dep.createdAt)}
                    </span>

                    {/* Rollback button — only on non-active, non-already-rolled-back rows */}
                    {!isActive && dep.status !== "rolled_back" && (
                      <Button
                        variant="outline"
                        className={OUTLINE_BTN}
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
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        Rollback
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
