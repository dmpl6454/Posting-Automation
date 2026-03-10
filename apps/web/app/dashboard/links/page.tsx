"use client";

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

function getOrgId(): string {
  if (typeof window !== "undefined") {
    return localStorage.getItem("currentOrgId") || "";
  }
  return "";
}

function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

export default function LinksPage() {
  const { toast } = useToast();
  const orgId = getOrgId();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [statsLinkId, setStatsLinkId] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading, refetch } = trpc.shortlink.list.useQuery(
    { organizationId: orgId },
    { enabled: !!orgId }
  );

  const createLink = trpc.shortlink.create.useMutation({
    onSuccess: () => {
      refetch();
      setDialogOpen(false);
      setOriginalUrl("");
      toast({ title: "Short link created" });
    },
    onError: (err) => {
      toast({ title: "Failed to create link", description: err.message, variant: "destructive" });
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
      organizationId: orgId,
      originalUrl,
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Short Links</h1>
          <p className="text-muted-foreground">
            Create short links and track click analytics
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
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
        <div className="space-y-3">
          {data.links.map((link: any) => (
            <Card key={link.id}>
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
                    <Link2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-medium">
                        /s/{link.code}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copyShortUrl(link.code, link.id)}
                        title="Copy short URL"
                      >
                        {copiedId === link.id ? (
                          <Check className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {link.originalUrl}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="flex items-center gap-1 text-sm font-medium">
                        <MousePointerClick className="h-3.5 w-3.5 text-muted-foreground" />
                        {link.clicks} clicks
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Created {new Date(link.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() =>
                          setStatsLinkId(statsLinkId === link.id ? null : link.id)
                        }
                        title="View Stats"
                      >
                        <BarChart3 className="h-4 w-4" />
                      </Button>
                      <a
                        href={link.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => {
                          if (confirm("Delete this short link?")) {
                            deleteLink.mutate({ id: link.id });
                          }
                        }}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                {statsLinkId === link.id && <LinkStats linkId={link.id} />}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkStats({ linkId }: { linkId: string }) {
  const { data, isLoading } = trpc.shortlink.getStats.useQuery(
    { id: linkId },
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

  return (
    <div className="mt-4 space-y-4 border-t pt-4">
      {/* Clicks Over Time */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Clicks (Last 7 Days) — {data.totalClicks} total
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
              <span className="text-[9px] text-muted-foreground">
                {new Date(day.date).toLocaleDateString(undefined, {
                  weekday: "short",
                })}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Top Referers and Countries */}
      <div className="grid gap-4 sm:grid-cols-2">
        {data.topReferers.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Top Referers</p>
            <div className="space-y-1">
              {data.topReferers.slice(0, 5).map((r) => (
                <div
                  key={r.referer}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="truncate text-muted-foreground">
                    {r.referer}
                  </span>
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    {r.count}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
        {data.topCountries.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Top Countries</p>
            <div className="space-y-1">
              {data.topCountries.slice(0, 5).map((c) => (
                <div
                  key={c.country}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="text-muted-foreground">{c.country}</span>
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    {c.count}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
