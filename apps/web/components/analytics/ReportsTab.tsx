"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import { Download, ExternalLink, Info } from "lucide-react";
import { toCsv, downloadCsv } from "~/lib/csv";

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

/**
 * Insights → Reports (2026-07-17): structured, extractable per-post table.
 * Every post × channel published within the selected window with its metrics —
 * "Current" = latest synced metrics; "At publish-age" = metrics as they stood
 * exactly 24h/7d/15d/30d after publish (checkpoints accrue for posts published
 * after this feature shipped).
 */
export function ReportsTab() {
  const [win, setWin] = useState<ReportWindow>("7d");
  const [mode, setMode] = useState<ReportMode>("current");

  const { data, isLoading } = trpc.analytics.postReports.useQuery(
    { window: win, mode },
    { staleTime: 60 * 1000 }
  );

  const rows = data?.rows ?? [];

  const onExport = () => {
    if (!rows.length) return;
    downloadCsv(
      `postautomation-report-${win}-${mode}-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        [
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
        ],
        rows.map((r) => [
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
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Post Reports</CardTitle>
            <CardDescription>
              Every post published in the selected window, per channel — extractable end to end.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onExport} disabled={!rows.length}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
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
              title="Metrics as they stood exactly 24h/7d/15d/30d after each post was published. Checkpoints accrue for posts published after this feature shipped — older posts show —."
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
          API tier; Instagram doesn&apos;t expose clicks/shares. All times UTC.
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
              ? "No at-age checkpoints in this window yet — they accrue for posts published after this feature shipped."
              : "No posts were published in this window."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Post</th>
                  <th className="py-2 pr-3 font-medium">Channel</th>
                  <th className="py-2 pr-3 font-medium">Published (UTC)</th>
                  <th className="py-2 pr-3 text-right font-medium">Views/Impr.</th>
                  <th className="py-2 pr-3 text-right font-medium">Likes</th>
                  <th className="py-2 pr-3 text-right font-medium">Comments</th>
                  <th className="py-2 pr-3 text-right font-medium">Shares</th>
                  <th className="py-2 pr-3 text-right font-medium">Reach</th>
                  <th className="py-2 pr-3 text-right font-medium">Eng. %</th>
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
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.likes)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.comments)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.shares)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(r.reach)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.engagementRate === null ? "—" : `${r.engagementRate.toFixed(1)}%`}
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
  );
}
