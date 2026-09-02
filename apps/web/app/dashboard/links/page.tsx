"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { useToast } from "~/hooks/use-toast";
import {
  Link2,
  Plus,
  Copy,
  Check,
  Trash2,
  ExternalLink,
  Loader2,
  BarChart3,
  MousePointerClick,
} from "lucide-react";

// Fix #46: removed localStorage getOrgId() — backend scopes by session

/**
 * Design: each card's glyph tile takes the next colour from the shared accent
 * palette, so a list of links is scannable by colour instead of a column of
 * identical blue squares. Same palette the RSS feed cards use.
 */
const LINK_ACCENTS = [
  "#C9A356", "#8a9a7e", "#a17a5c", "#6b7d9e",
  "#b85c5c", "#7e8a9a", "#9a8a5c", "#5c8a7e",
] as const;

function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

function isHttpUrl(u: string) {
  try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; }
}

function LinksPageInner() {
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [statsLinkId, setStatsLinkId] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string>("");

  // Fix #46: removed localStorage orgId gate — backend scopes by session
  const { data, isLoading, refetch } = trpc.shortlink.list.useQuery({});

  const createLink = trpc.shortlink.create.useMutation({
    onSuccess: () => {
      refetch();
      setDialogOpen(false);
      setOriginalUrl("");
      setExpiresAt("");
      toast({ title: "Short link created" });
    },
    onError: (err) => {
      toast({ title: "Failed to create link", description: humanizeError(err), variant: "destructive" });
    },
  });

  const deleteLink = trpc.shortlink.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Link deleted" });
    },
  });

  const handleCreate = () => {
    if (!originalUrl) return;
    createLink.mutate({
      originalUrl,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    });
  };

  const copyShortUrl = (code: string, linkId: string) => {
    const shortUrl = `${getBaseUrl()}/s/${code}`;
    navigator.clipboard.writeText(shortUrl);
    setCopiedId(linkId);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="space-y-8">
      {/* Page header — design pattern (see the RSS page for the same shape). */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <span className="eyebrow">Short Links</span>
          <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
            Shrink, share, track.
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Create short links and track click analytics
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <div className="flex h-9 items-center gap-3.5 rounded-[9px] border border-border bg-card px-4">
            <div>
              <div className="text-[17px] font-semibold leading-none">{data?.links?.length ?? 0}</div>
              <div className="mt-0.5 whitespace-nowrap text-[9px] leading-none text-faint">links</div>
            </div>
            <span className="h-5 w-px bg-border2" />
            <div>
              <div className="text-[17px] font-semibold leading-none text-gold">
                {data?.links?.reduce((n, l) => n + (l.clicks ?? 0), 0) ?? 0}
              </div>
              <div className="mt-0.5 whitespace-nowrap text-[9px] leading-none text-faint">clicks</div>
            </div>
          </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="pa-cta-gold h-9 shrink-0 gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold">
              <Plus className="h-3.5 w-3.5" />
              Create Link
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[450px]">
            <DialogHeader>
              <DialogTitle>Create Short Link</DialogTitle>
              <DialogDescription>
                Enter a URL to generate a trackable short link.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="original-url">Original URL</Label>
                <Input
                  id="original-url"
                  value={originalUrl}
                  onChange={(e) => setOriginalUrl(e.target.value)}
                  placeholder="https://example.com/long-url-here"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Expires at (optional)</label>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="w-full rounded border px-2 py-1 text-sm"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!originalUrl || createLink.isPending}
              >
                {createLink.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Link
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Links List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : !data?.links || data.links.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <Link2 className="h-12 w-12 text-muted-foreground/30" />
            <p className="mt-4 text-sm font-medium">No short links yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create your first short link to start tracking clicks
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {data.links.map((link: any, i: number) => {
            const accent = LINK_ACCENTS[i % LINK_ACCENTS.length]!;
            /* Design: the three actions form ONE bordered surface-1 pill of 26px
               buttons, not three loose ghost buttons. */
            const actionBtn =
              "flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground";
            return (
              <Card
                key={link.id}
                className="px-4 py-3.5 shadow-[0_6px_14px_-10px_rgba(0,0,0,.5)] transition-colors hover:border-[hsl(var(--accent-border))]"
              >
                <div className="flex flex-wrap items-center gap-[14px]">
                  {/* 34px tile tinted with this link's accent, like the RSS cards. */}
                  <div
                    className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border"
                    style={{ backgroundColor: `${accent}22`, borderColor: `${accent}55` }}
                  >
                    <Link2 className="h-[15px] w-[15px]" style={{ color: accent }} />
                  </div>
                  <div className="min-w-[220px] flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-[5px] bg-tile px-2 py-0.5 font-mono text-[12px] font-semibold leading-[1.6]">
                        /s/{link.code}
                      </span>
                      <button
                        type="button"
                        className="flex h-[23px] w-[23px] items-center justify-center rounded-[6px] transition-colors hover:bg-hover"
                        onClick={() => copyShortUrl(link.code, link.id)}
                        title="Copy short URL"
                      >
                        {copiedId === link.id ? (
                          <Check className="h-3 w-3 text-gold" />
                        ) : (
                          <Copy className="h-3 w-3 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                    <p className="mt-[5px] max-w-[420px] truncate text-[11.5px] leading-[1.4] text-muted-foreground">
                      {link.originalUrl}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <div className="text-right">
                      <div className="flex items-center justify-end gap-[5px] whitespace-nowrap text-[12.5px] font-semibold leading-none">
                        <MousePointerClick className="h-[11px] w-[11px] text-muted-foreground" />
                        {link.clicks} clicks
                      </div>
                      <p className="mt-1 whitespace-nowrap text-[10px] leading-none text-faint">
                        Created {new Date(link.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-px rounded-[8px] border border-border bg-surface1 p-0.5">
                      <button
                        type="button"
                        className={`${actionBtn} ${statsLinkId === link.id ? "text-gold" : ""}`}
                        onClick={() =>
                          setStatsLinkId(statsLinkId === link.id ? null : link.id)
                        }
                        title="View Stats"
                      >
                        <BarChart3 className="h-[13px] w-[13px]" />
                      </button>
                      {isHttpUrl(link.originalUrl) ? (
                        <a
                          href={link.originalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={actionBtn}
                          title="Open"
                        >
                          <ExternalLink className="h-[13px] w-[13px]" />
                        </a>
                      ) : (
                        <span
                          className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-[#c96b56]"
                          title="Unsafe URL scheme"
                        >
                          <ExternalLink className="h-[13px] w-[13px]" />
                        </span>
                      )}
                      <button
                        type="button"
                        className={`${actionBtn} hover:text-[#c96b56]`}
                        onClick={() => {
                          if (confirm("Delete this short link?")) {
                            deleteLink.mutate({ id: link.id });
                          }
                        }}
                        title="Delete"
                      >
                        <Trash2 className="h-[13px] w-[13px]" />
                      </button>
                    </div>
                  </div>
                </div>

                {statsLinkId === link.id && <LinkStats linkId={link.id} />}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LinkStats({ linkId }: { linkId: string }) {
  const [days, setDays] = useState<7 | 30>(7);
  const { data, isLoading } = trpc.shortlink.getStats.useQuery(
    { id: linkId, days },
    { enabled: !!linkId }
  );

  if (isLoading) {
    return (
      <div className="mt-4 border-t pt-4">
        <Skeleton className="h-32 rounded-lg" />
      </div>
    );
  }

  if (!data) return null;

  const maxClicks = Math.max(...data.clicksByDay.map((d) => d.count), 1);
  const maxHour = Math.max(...data.clicksByHour.map((h) => h.count), 1);
  const ctr =
    data.totalClicks > 0 && data.windowClicks >= 0
      ? `${data.windowClicks} in the last ${data.days} days`
      : "no recent activity";

  return (
    <div className="mt-4 space-y-4 border-t pt-4">
      {/* Header row with totals + range toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {data.totalClicks} total clicks — {ctr}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {([7, 30] as const).map((n) => (
            <Button
              key={n}
              variant={days === n ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setDays(n)}
            >
              Last {n}d
            </Button>
          ))}
        </div>
      </div>

      {/* Clicks Over Time */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Clicks by day
        </p>
        <div className="flex items-end gap-1" style={{ height: 80 }}>
          {data.clicksByDay.map((day) => (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-blue-500"
                style={{
                  height: `${Math.max((day.count / maxClicks) * 60, 2)}px`,
                }}
                title={`${day.date}: ${day.count} clicks`}
              />
              {days <= 7 ? (
                <span className="text-[9px] text-muted-foreground">
                  {new Date(day.date).toLocaleDateString(undefined, {
                    weekday: "short",
                  })}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* Hour-of-day */}
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          Clicks by hour of day (UTC)
        </p>
        <div className="flex items-end gap-[2px]" style={{ height: 50 }}>
          {data.clicksByHour.map((h) => (
            <div
              key={h.hour}
              className="flex-1 rounded-t bg-tile"
              style={{ height: `${Math.max((h.count / maxHour) * 40, 2)}px` }}
              title={`${h.hour}:00 — ${h.count} clicks`}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
          <span>0h</span>
          <span>6h</span>
          <span>12h</span>
          <span>18h</span>
          <span>23h</span>
        </div>
      </div>

      {/* 3-up breakdown */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {([
          { title: "Devices", rows: data.devices },
          { title: "Browsers", rows: data.browsers },
          { title: "Operating Systems", rows: data.os },
        ] as const).map((col) =>
          col.rows.length > 0 ? (
            <div key={col.title}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{col.title}</p>
              <div className="space-y-1">
                {col.rows.slice(0, 5).map((r) => (
                  <div key={r.name} className="flex items-center justify-between text-xs">
                    <span className="truncate text-muted-foreground">{r.name}</span>
                    <Badge variant="secondary" className="ml-2 text-[10px]">
                      {r.count}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          ) : null
        )}
      </div>

      {/* Top Referers */}
      {data.topReferers.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Top Referers</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {data.topReferers.slice(0, 6).map((r) => (
              <div
                key={r.referer}
                className="flex items-center justify-between text-xs"
              >
                <span className="truncate text-muted-foreground">{r.referer}</span>
                <Badge variant="secondary" className="ml-2 text-[10px]">
                  {r.count}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function LinksPage() {
  return (
    <RequireAppAdmin>
      <LinksPageInner />
    </RequireAppAdmin>
  );
}
