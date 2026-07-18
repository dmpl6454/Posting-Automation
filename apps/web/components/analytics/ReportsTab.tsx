"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Download, ExternalLink, Info, Loader2, Mail } from "lucide-react";
import { toCsv, downloadCsv } from "~/lib/csv";
import { useToast } from "~/hooks/use-toast";
import { humanizeError } from "~/lib/errors";

type ReportWindow = "24h" | "7d" | "15d" | "30d";
type ReportMode = "current" | "at_age";

const WINDOWS: { value: ReportWindow; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "15d", label: "15 days" },
  { value: "30d", label: "30 days" },
];

/** UTC "YYYY-MM-DD HH:mm" — analytics invariant: all report dates are UTC. */
function fmtUtc(d: Date | string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : String(v);
}

/** "current"-mode freshness hint: a latest snapshot older than 24h is stale. */
function isStaleSnapshot(snapshotAt: Date | string | null): boolean {
  if (!snapshotAt) return false;
  return Date.now() - new Date(snapshotAt).getTime() > 24 * 60 * 60 * 1000;
}

const EXPORT_LIMIT = 1000;

const CSV_HEADER = [
  "Post",
  "Channel",
  "Handle",
  "Platform",
  "Published At (UTC)",
  "Post URL",
  "Views/Impressions",
  "Clicks",
  "Likes",
  "Comments",
  "Shares",
  "Reach",
  "Engagement %",
  "Metric captured at (UTC)",
];

/**
 * Insights → Reports (2026-07-17): structured, extractable per-post table.
 * "Current" = every post × channel published WITHIN the selected window, with
 * its latest synced metrics. "At publish-age" = posts OLD ENOUGH to have
 * reached that age (published at least one window ago), with metrics as they
 * stood exactly 24h/7d/15d/30d after publish — at-age checkpoints accrue for
 * posts published after 2026-07-17, so older posts show "—".
 */
export function ReportsTab() {
  const [win, setWin] = useState<ReportWindow>("7d");
  const [mode, setMode] = useState<ReportMode>("current");
  const [exporting, setExporting] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [recipient, setRecipient] = useState("");

  const { toast } = useToast();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.analytics.postReports.useQuery(
    { window: win, mode },
    { staleTime: 60 * 1000 }
  );

  const rows = data?.rows ?? [];

  const emailReport = trpc.analytics.emailReport.useMutation({
    onSuccess: (res) => {
      toast({
        title: "Report emailed",
        description: `${res.rows} row${res.rows === 1 ? "" : "s"} sent as a CSV attachment.`,
      });
      setEmailOpen(false);
      setRecipient("");
    },
    onError: (err) => {
      toast({
        title: "Could not email report",
        description: humanizeError(err),
        variant: "destructive",
      });
    },
  });

  const onSendEmail = () => {
    const to = recipient.trim();
    if (!to || emailReport.isPending) return;
    emailReport.mutate({ to, window: win, mode });
  };

  const onExport = async () => {
    if (!rows.length || exporting) return;
    setExporting(true);
    try {
      // Refetch at the full export cap — the on-screen query is capped at 500.
      const full = await utils.analytics.postReports.fetch({
        window: win,
        mode,
        limit: EXPORT_LIMIT,
      });
      const exportRows = full?.rows ?? rows;
      const truncated = exportRows.length === EXPORT_LIMIT ? "-truncated" : "";
      downloadCsv(
        `postautomation-report-${win}-${mode}-${new Date().toISOString().slice(0, 10)}${truncated}.csv`,
        toCsv(
          CSV_HEADER,
          exportRows.map((r) => [
            r.contentPreview,
            r.channelName,
            r.channelUsername ?? "",
            r.platform,
            r.publishedAt ? new Date(r.publishedAt).toISOString() : "",
            r.publishedUrl ?? "",
            r.impressions,
            r.clicks,
            r.likes,
            r.comments,
            r.shares,
            r.reach,
            r.engagementRate,
            r.snapshotAt ? new Date(r.snapshotAt).toISOString() : "",
          ])
        )
      );
    } catch (err) {
      toast({
        title: "Export failed",
        description: humanizeError(err),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
    <Dialog open={emailOpen} onOpenChange={(open) => { if (!emailReport.isPending) setEmailOpen(open); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Email this report</DialogTitle>
          <DialogDescription>
            Sends the current view ({WINDOWS.find((w) => w.value === win)?.label},{" "}
            {mode === "at_age" ? "at publish-age" : "current metrics"}) as a CSV attachment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="report-recipient">Recipient email</Label>
          <Input
            id="report-recipient"
            type="email"
            placeholder="name@example.com"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSendEmail();
            }}
            disabled={emailReport.isPending}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setEmailOpen(false)}
            disabled={emailReport.isPending}
          >
            Cancel
          </Button>
          <Button onClick={onSendEmail} disabled={!recipient.trim() || emailReport.isPending}>
            {emailReport.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Mail className="mr-1.5 h-3.5 w-3.5" />
                Send report
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Post Reports</CardTitle>
            <CardDescription>
              {mode === "at_age"
                ? "Every post old enough to have reached this age, per channel — metrics captured at that age."
                : "Every post published in the selected window, per channel — extractable end to end."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEmailOpen(true)}
              disabled={!rows.length}
            >
              <Mail className="mr-1.5 h-3.5 w-3.5" />
              Email report
            </Button>
            <Button size="sm" variant="outline" onClick={onExport} disabled={!rows.length || exporting}>
              {exporting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" />
              )}
              Export CSV
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                onClick={() => setWin(w.value)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  win === w.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border p-0.5">
            <button
              onClick={() => setMode("current")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                mode === "current" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Current metrics
            </button>
            <button
              onClick={() => setMode("at_age")}
              title="Shows posts old enough to have reached this age (published at least one window ago), with metrics as they stood exactly 24h/7d/15d/30d after publish. At-age data accrues for posts published after 2026-07-17 — older posts show —."
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                mode === "at_age" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              At publish-age
            </button>
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Views ride on Impressions (YouTube/Threads report views there). Twitter metrics need a paid
          API tier; Instagram doesn&apos;t expose clicks/shares. Facebook refreshes at publish, at-age
          checkpoints, and Sync Now only. All times UTC.
        </p>
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {mode === "at_age"
              ? "No posts are old enough to have reached this age yet — at-age data accrues for posts published after 2026-07-17."
              : "No posts were published in this window."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Post</th>
                  <th className="py-2 pr-3 font-medium">Channel</th>
                  <th className="py-2 pr-3 font-medium">Published (UTC)</th>
                  <th className="py-2 pr-3 text-right font-medium">Views/Impr.</th>
                  <th className="py-2 pr-3 text-right font-medium">Clicks</th>
                  <th className="py-2 pr-3 text-right font-medium">Likes</th>
                  <th className="py-2 pr-3 text-right font-medium">Comments</th>
                  <th className="py-2 pr-3 text-right font-medium">Shares</th>
                  <th className="py-2 pr-3 text-right font-medium">Reach</th>
                  <th className="py-2 pr-3 text-right font-medium">Eng. %</th>
                  <th className="py-2 pr-3 font-medium">Captured (UTC)</th>
                  <th className="py-2 font-medium">Link</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.targetId} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="max-w-[280px] py-2 pr-3">
                      <Link
                        href={`/dashboard/posts/${r.postId}`}
                        className="line-clamp-2 hover:underline"
                        title={r.contentPreview}
                      >
                        {r.contentPreview || "(no text)"}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {r.platform}
                        </Badge>
                        <span className="max-w-[140px] truncate">{r.channelName}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">
                      {fmtUtc(r.publishedAt)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.impressions)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.clicks)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.likes)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.comments)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.shares)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.reach)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.engagementRate === null ? "—" : `${r.engagementRate.toFixed(1)}%`}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">
                      {fmtUtc(r.snapshotAt)}
                      {mode === "current" && isStaleSnapshot(r.snapshotAt) && (
                        <span
                          className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70"
                          title="Latest metric capture is more than 24 hours old — use Sync Now to refresh."
                        >
                          stale
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      {r.publishedUrl ? (
                        <a
                          href={r.publishedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center text-muted-foreground hover:text-foreground"
                          title="Open on platform"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">
              {rows.length} row{rows.length === 1 ? "" : "s"}
              {rows.length >= 500 ? " (capped at 500 — narrow the window for full coverage)" : ""} ·
              generated {data ? fmtUtc(data.generatedAt) : ""}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
    </>
  );
}
