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

/**
 * Fixed leading columns. The METRIC columns that follow are assembled at export
 * time from what is actually reportable, so a metric no platform in the export
 * can populate doesn't ship as an all-empty CSV column (and header/row indexes
 * stay aligned).
 */
const CSV_HEADER_FIXED = [
  "Post",
  "Channel",
  "Handle",
  "Platform",
  "Published At (UTC)",
  "Post URL",
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
  // Per-platform view. `null` = All.
  const [platformView, setPlatformView] = useState<string | null>(null);

  const { toast } = useToast();
  const utils = trpc.useUtils();

  const { data: orgPlatforms } = trpc.analytics.platformsInWindow.useQuery();
  // Fall back to All for a platform this org doesn't have, rather than rendering
  // an unexplained empty table.
  const platformFilter =
    platformView && (orgPlatforms ?? []).includes(platformView) ? platformView : undefined;

  const { data, isLoading } = trpc.analytics.postReports.useQuery(
    { window: win, mode, platform: platformFilter },
    // A new `platform` in the key is a NEW query — without placeholderData the
    // table collapses to skeletons on every pill click.
    { staleTime: 60 * 1000, placeholderData: (prev) => prev }
  );

  const rows = data?.rows ?? [];

  // Capability-driven columns: a metric that NO platform in these rows can ever
  // report is dropped entirely rather than rendering a column full of "—".
  // Derived server-side from platform capability (plus per-capture overrides) —
  // deliberately NOT from "are all values null?", since that also means "not
  // synced yet" and would hide a column that is about to fill in.
  const reportable = new Set<string>(data?.reportableMetrics ?? []);
  // While loading (or on a legacy payload) show everything, so the header doesn't
  // reflow once data lands.
  const show = (key: string) => reportable.size === 0 || reportable.has(key);
  // Saves ride in capture metadata rather than the metric map; show the column
  // only when some row actually carries one.
  const anySaves = rows.some((r) => r.saved != null);

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
    emailReport.mutate({ to, window: win, mode, platform: platformFilter });
  };

  const onExport = async () => {
    if (!rows.length || exporting) return;
    setExporting(true);
    try {
      // Refetch at the full export cap — the on-screen query is capped at 500.
      // Fetch ONE extra row so we can distinguish "exactly EXPORT_LIMIT rows
      // (complete)" from "more than EXPORT_LIMIT (truncated)" — the old
      // `=== EXPORT_LIMIT` check falsely labeled a complete 1000-row dataset
      // as truncated.
      const full = await utils.analytics.postReports.fetch({
        // Export the SAME rows the table shows — a CSV that silently widens
        // past the on-screen filter is a different report than the one asked for.
        platform: platformFilter,
        window: win,
        mode,
        limit: EXPORT_LIMIT + 1,
      });
      // Export mirrors what the table shows: a column dropped for being
      // structurally unreportable must not reappear as an all-empty CSV column.
      const exportReportable = new Set<string>(full?.reportableMetrics ?? data?.reportableMetrics ?? []);
      const inCsv = (key: string) => exportReportable.size === 0 || exportReportable.has(key);
      const fetched = full?.rows ?? rows;
      const truncated = fetched.length > EXPORT_LIMIT ? "-truncated" : "";
      const exportRows = fetched.slice(0, EXPORT_LIMIT);
      // Metric columns, filtered to what is actually reportable, so the header
      // and every row stay index-aligned.
      type ExportRow = (typeof exportRows)[number];
      const allMetricCols: Array<{ key: string; header: string; get: (r: ExportRow) => any }> = [
        // Header is plain "Impressions" now: Views has its own column, so the
        // old "Views/Impressions" conflation is no longer needed (and was the
        // symptom of five platforms storing views in the impressions slot).
        { key: "impressions", header: "Impressions", get: (r: ExportRow) => r.impressions },
        { key: "views", header: "Views", get: (r: ExportRow) => (r as any).views },
        { key: "clicks", header: "Clicks", get: (r: ExportRow) => r.clicks },
        { key: "likes", header: "Likes", get: (r: ExportRow) => r.likes },
        { key: "comments", header: "Comments", get: (r: ExportRow) => r.comments },
        { key: "shares", header: "Shares", get: (r: ExportRow) => r.shares },
        { key: "reach", header: "Reach", get: (r: ExportRow) => r.reach },
      ];
      const metricCols = allMetricCols.filter((c) => inCsv(c.key));
      const includeSaves = exportRows.some((r) => r.saved != null);
      // The rate's denominator is impressions OR views (five platforms have no
      // impressions metric at all), so gate the column on either being reportable.
      const includeEng = inCsv("impressions") || inCsv("views");

      downloadCsv(
        `postautomation-report-${win}-${mode}-${new Date().toISOString().slice(0, 10)}${truncated}.csv`,
        toCsv(
          [
            ...CSV_HEADER_FIXED,
            ...metricCols.map((c) => c.header),
            ...(includeSaves ? ["Saves"] : []),
            ...(includeEng ? ["Engagement %"] : []),
            "Metric captured at (UTC)",
          ],
          exportRows.map((r) => [
            r.contentPreview,
            r.channelName,
            r.channelUsername ?? "",
            r.platform,
            r.publishedAt ? new Date(r.publishedAt).toISOString() : "",
            r.publishedUrl ?? "",
            ...metricCols.map((c) => c.get(r)),
            ...(includeSaves ? [r.saved] : []),
            ...(includeEng ? [r.engagementRate] : []),
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
                className={`rounded-md px-3 py-2 [@media(hover:hover)]:py-1 text-xs font-medium transition-colors ${
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
              className={`rounded-md px-3 py-2 [@media(hover:hover)]:py-1 text-xs font-medium transition-colors ${
                mode === "current" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Current metrics
            </button>
            <button
              onClick={() => setMode("at_age")}
              title="Shows posts old enough to have reached this age (published at least one window ago), with metrics as they stood exactly 24h/7d/15d/30d after publish. At-age data accrues for posts published after 2026-07-17 — older posts show —."
              className={`rounded-md px-3 py-2 [@media(hover:hover)]:py-1 text-xs font-medium transition-colors ${
                mode === "at_age" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              At publish-age
            </button>
          </div>

          {/* Per-platform view. Always mounted (min-h) so the table never shifts
              once the platform list resolves. */}
          <div className="flex min-h-[28px] flex-wrap items-center gap-1.5">
            {(orgPlatforms?.length ?? 0) > 1 && (
              <>
                <button
                  type="button"
                  aria-pressed={platformFilter === undefined}
                  onClick={() => setPlatformView(null)}
                  className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    platformFilter === undefined
                      ? "border-primary bg-primary/10"
                      : "hover:bg-muted/50"
                  }`}
                >
                  All
                </button>
                {orgPlatforms!.map((p) => {
                  const active = platformFilter === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={active}
                      aria-label={`Show only ${p} posts`}
                      onClick={() => setPlatformView(active ? null : p)}
                      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize transition-colors ${
                        active ? "border-primary bg-primary/10" : "hover:bg-muted/50"
                      }`}
                    >
                      {p.toLowerCase()}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {mode === "current" ? (
            <span>
              Covers <strong>all posts on your connected Facebook Pages and Instagram accounts
              from 1 Aug 2026 onward</strong>, including ones posted directly on the platform
              (marked <em>Direct</em>) — not just posts sent through PostAutomation. Views ride on
              Impressions (YouTube/Threads report views there; IG Reels and FB videos report
              plays/views there). Twitter metrics need a paid API tier; Instagram doesn&apos;t expose
              clicks (shares only on Reels). All times UTC.
            </span>
          ) : (
            <span>
              At-publish-age metrics are captured by checkpoints scheduled when{" "}
              <strong>we</strong> publish a post, so this mode covers posts sent through
              PostAutomation only — posts made directly on the platform have no checkpoint to
              report. Switch to <strong>Current metrics</strong> to see every post on the page.
              All times UTC.
            </span>
          )}
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
            {/* Name the active filter — "no posts in this window" would be false
                when the org posted plenty on a platform that is filtered out. */}
            {platformFilter ? (
              <>
                No {platformFilter.toLowerCase()} posts in this window.{" "}
                <button
                  type="button"
                  onClick={() => setPlatformView(null)}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Show all platforms
                </button>
              </>
            ) : mode === "at_age" ? (
              "No posts are old enough to have reached this age yet — at-age data accrues for posts published after 2026-07-17."
            ) : (
              "No posts were published in this window."
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1160px] text-sm">
              <thead>
                {/* whitespace-nowrap inherits to every th, so no header ever
                    truncates ("ENG…"); the wider min-w gives the last columns
                    real room inside the existing overflow-x-auto scroller. */}
                <tr className="whitespace-nowrap border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2.5 pr-3 font-medium">Post</th>
                  <th className="py-2.5 pr-3 font-medium">Channel</th>
                  <th className="py-2.5 pr-3 font-medium">Published (UTC)</th>
                  {/* Columns are capability-driven: a metric that NO platform in
                      these rows can ever report is dropped rather than rendering a
                      full column of "—". Server-computed from the platforms
                      present plus any per-capture override. */}
                  {show("impressions") && (
                    <th className="py-2.5 pr-3 text-right font-medium">Impressions</th>
                  )}
                  {show("views") && <th className="py-2.5 pr-3 text-right font-medium">Views</th>}
                  {show("clicks") && <th className="py-2.5 pr-3 text-right font-medium">Clicks</th>}
                  {show("likes") && <th className="py-2.5 pr-3 text-right font-medium">Likes</th>}
                  {show("comments") && (
                    <th className="py-2.5 pr-3 text-right font-medium">Comments</th>
                  )}
                  {show("shares") && <th className="py-2.5 pr-3 text-right font-medium">Shares</th>}
                  {show("reach") && <th className="py-2.5 pr-3 text-right font-medium">Reach</th>}
                  {anySaves && (
                    <th
                      className="py-2.5 pr-3 text-right font-medium"
                      title="Saves / bookmarks — a distinct action from a like. Reported by Instagram (and Pinterest saves)."
                    >
                      Saves
                    </th>
                  )}
                  {show("impressions") && (
                    <th className="py-2.5 pr-3 text-right font-medium" title="Engagement rate">
                      Eng %
                    </th>
                  )}
                  <th className="py-2.5 pr-3 font-medium">Captured (UTC)</th>
                  <th className="py-2.5 font-medium">Link</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr
                    key={r.targetId}
                    className={`border-b last:border-0 hover:bg-muted/40 transition-colors ${
                      idx % 2 === 0 ? "" : "bg-muted/10"
                    }`}
                  >
                    <td className="max-w-[280px] py-2.5 pr-3">
                      <Link
                        href={`/dashboard/posts/${r.postId}`}
                        className="line-clamp-2 hover:underline"
                        title={r.contentPreview}
                      >
                        {r.contentPreview || "(no text)"}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {r.platform}
                        </Badge>
                        <span className="max-w-[140px] truncate">{r.channelName}</span>
                        {/* Honest provenance. Insights now covers the whole page, so a row
                            the user never sent must not silently read as one they did. */}
                        {r.isExternal && (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px] text-muted-foreground"
                            title="Posted directly on the platform, not through PostAutomation. Its metrics are read with the same permissions."
                          >
                            Direct
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      {fmtUtc(r.publishedAt)}
                    </td>
                    {show("impressions") && (
                      <td className="py-2.5 pr-3 text-right tabular-nums">{num(r.impressions)}</td>
                    )}
                    {show("views") && (
                      <td className="py-2.5 pr-3 text-right tabular-nums">{num((r as any).views)}</td>
                    )}
                    {show("clicks") && (
                      <td className="py-2.5 pr-3 text-right tabular-nums">{num(r.clicks)}</td>
                    )}
                    {show("likes") && (
                      <td className="py-2.5 pr-3 text-right tabular-nums">{num(r.likes)}</td>
                    )}
                    {show("comments") && (
                      <td className="py-2.5 pr-3 text-right tabular-nums">{num(r.comments)}</td>
                    )}
                    {show("shares") && (
                      <td className="py-2.5 pr-3 text-right tabular-nums">{num(r.shares)}</td>
                    )}
                    {show("reach") && (
                      <td className="py-2.5 pr-3 text-right tabular-nums">{num(r.reach)}</td>
                    )}
                    {anySaves && (
                      <td
                        className="py-2.5 pr-3 text-right tabular-nums"
                        // Reels also report watch time; surface it as a hint rather
                        // than another column so the table stays readable.
                        title={
                          r.avgWatchTimeMs
                            ? `Avg watch time: ${(r.avgWatchTimeMs / 1000).toFixed(1)}s`
                            : undefined
                        }
                      >
                        {num(r.saved)}
                      </td>
                    )}
                    {show("impressions") && (
                      <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums">
                        {r.engagementRate === null ? "—" : `${r.engagementRate.toFixed(1)}%`}
                      </td>
                    )}
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
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
                    <td className="py-2.5">
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
