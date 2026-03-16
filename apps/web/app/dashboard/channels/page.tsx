"use client";

import { useState, useMemo } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import {
  Share2,
  Plus,
  Power,
  Trash2,
  ChevronDown,
  ChevronRight,
  Users,
} from "lucide-react";
import { PlatformIcon } from "~/components/icons/platform-icons";

const PLATFORM_DISPLAY: Record<string, { name: string; description: string }> = {
  TWITTER: { name: "X (Twitter)", description: "Post tweets and threads" },
  FACEBOOK: { name: "Facebook", description: "Pages and profiles" },
  INSTAGRAM: { name: "Instagram", description: "Business and creator accounts" },
  LINKEDIN: { name: "LinkedIn", description: "Company pages and profiles" },
  YOUTUBE: { name: "YouTube", description: "Channels and videos" },
  TIKTOK: { name: "TikTok", description: "Short-form video content" },
  REDDIT: { name: "Reddit", description: "Communities and posts" },
  PINTEREST: { name: "Pinterest", description: "Pins and boards" },
  THREADS: { name: "Threads", description: "Text-based conversations" },
  TELEGRAM: { name: "Telegram", description: "Channels and groups" },
  DISCORD: { name: "Discord", description: "Server channels" },
  BLUESKY: { name: "Bluesky", description: "Decentralized social" },
};

export default function ChannelsPage() {
  const { toast } = useToast();
  const { data: channels, isLoading, refetch } = trpc.channel.list.useQuery();
  const { data: platforms } = trpc.channel.supportedPlatforms.useQuery();
  const getOAuthUrl = trpc.channel.getOAuthUrl.useMutation();
  const disconnect = trpc.channel.disconnect.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Channel disconnected" });
    },
  });
  const toggleActive = trpc.channel.toggleActive.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Channel updated" });
    },
  });

  // Group channels by platform
  const groupedChannels = useMemo(() => {
    if (!channels) return {};
    const groups: Record<string, typeof channels> = {};
    for (const channel of channels) {
      const platform = channel.platform;
      if (!groups[platform]) groups[platform] = [];
      groups[platform]!.push(channel);
    }
    return groups;
  }, [channels]);

  const connectedPlatforms = Object.keys(groupedChannels);

  // Track which platform accordions are expanded — first one starts expanded
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(
    new Set()
  );
  // Auto-expand first platform on initial load
  const [initialized, setInitialized] = useState(false);
  if (!initialized && connectedPlatforms.length > 0) {
    setExpandedPlatforms(new Set([connectedPlatforms[0]!]));
    setInitialized(true);
  }

  const toggleExpanded = (platform: string) => {
    setExpandedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  };

  // Platforms that don't have any connected channels yet
  const unconnectedPlatforms = useMemo(() => {
    if (!platforms) return [];
    return platforms.filter((p) => !connectedPlatforms.includes(p.platform));
  }, [platforms, connectedPlatforms]);

  // Platforms that already have channels (for the "+" add more button)
  const connectedPlatformsList = useMemo(() => {
    if (!platforms) return [];
    return platforms.filter((p) => connectedPlatforms.includes(p.platform));
  }, [platforms, connectedPlatforms]);

  const handleConnect = async (platform: string) => {
    try {
      const result = await getOAuthUrl.mutateAsync({ platform });
      window.location.href = result.url;
    } catch (err) {
      toast({
        title: "Failed to connect",
        description: "Could not get OAuth URL. Please try again.",
        variant: "destructive",
      });
    }
  };

  const totalChannels = channels?.length ?? 0;
  const activeChannels = channels?.filter((c: any) => c.isActive).length ?? 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Channels</h1>
          <p className="text-muted-foreground">
            Connect and manage your social media accounts
          </p>
        </div>
        {totalChannels > 0 && (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-2xl font-bold">{totalChannels}</p>
              <p className="text-xs text-muted-foreground">
                {activeChannels} active
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Connected Platforms — Accordion Cards */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : connectedPlatforms.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <div className="rounded-full bg-muted p-4">
              <Share2 className="h-10 w-10 text-muted-foreground/40" />
            </div>
            <p className="mt-5 text-base font-medium">
              No channels connected yet
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Connect your first social media account below to get started
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Connected Platforms</h2>
          {connectedPlatforms.map((platform) => {
            const platformChannels = groupedChannels[platform] ?? [];
            const isExpanded = expandedPlatforms.has(platform);
            const activeCount = platformChannels.filter(
              (c: any) => c.isActive
            ).length;
            const info = PLATFORM_DISPLAY[platform];

            return (
              <Card key={platform} className="overflow-hidden">
                {/* Accordion Header */}
                <button
                  onClick={() => toggleExpanded(platform)}
                  className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-muted/50"
                >
                  <PlatformIcon platform={platform} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold">
                        {info?.name ?? platform}
                      </h3>
                      <Badge variant="secondary" className="text-xs">
                        <Users className="mr-1 h-3 w-3" />
                        {platformChannels.length}{" "}
                        {platformChannels.length === 1
                          ? "account"
                          : "accounts"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-green-600"
                      >
                        {activeCount} active
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {info?.description ?? "Social media platform"}
                    </p>
                  </div>

                  {/* Add More Button */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mr-2 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnect(platform);
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add
                  </Button>

                  {/* Expand/Collapse Icon */}
                  {isExpanded ? (
                    <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                  )}
                </button>

                {/* Accordion Content — Channel List */}
                {isExpanded && (
                  <div className="border-t">
                    {platformChannels.map((channel: any, idx: number) => (
                      <div
                        key={channel.id}
                        className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30 ${
                          idx < platformChannels.length - 1 ? "border-b" : ""
                        }`}
                      >
                        {/* Avatar */}
                        {channel.avatar ? (
                          <img
                            src={channel.avatar}
                            alt={channel.name}
                            className="h-9 w-9 rounded-full object-cover"
                          />
                        ) : (
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
                            {(channel.name || "?").charAt(0).toUpperCase()}
                          </div>
                        )}

                        {/* Name & Username */}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {channel.name}
                          </p>
                          {channel.username && (
                            <p className="truncate text-xs text-muted-foreground">
                              @{channel.username}
                            </p>
                          )}
                        </div>

                        {/* Status Badge */}
                        <Badge
                          variant={channel.isActive ? "default" : "secondary"}
                          className="shrink-0 text-[10px]"
                        >
                          {channel.isActive ? "Active" : "Paused"}
                        </Badge>

                        {/* Actions */}
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() =>
                              toggleActive.mutate({ channelId: channel.id })
                            }
                            title={
                              channel.isActive
                                ? "Pause channel"
                                : "Activate channel"
                            }
                          >
                            <Power
                              className={`h-4 w-4 ${
                                channel.isActive
                                  ? "text-green-600"
                                  : "text-muted-foreground"
                              }`}
                            />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm("Disconnect this channel?"))
                                disconnect.mutate({ channelId: channel.id });
                            }}
                            title="Disconnect"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Connect a Platform — only show platforms not yet connected */}
      {unconnectedPlatforms && unconnectedPlatforms.length > 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Connect a Platform</h2>
            <p className="text-sm text-muted-foreground">
              Click to authorize and connect your account
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {unconnectedPlatforms.map((p) => (
              <button
                key={p.platform}
                onClick={() => handleConnect(p.platform)}
                className="group flex items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:border-primary hover:bg-primary/5"
              >
                <PlatformIcon platform={p.platform} size="md" />
                <div className="flex-1">
                  <p className="font-medium">{p.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    Max {p.constraints.maxContentLength} chars
                  </p>
                </div>
                <Plus className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
