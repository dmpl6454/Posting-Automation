"use client";

import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import { Share2, Plus, Power, Trash2, ExternalLink } from "lucide-react";

const platformColors: Record<string, string> = {
  TWITTER: "bg-blue-400",
  LINKEDIN: "bg-blue-700",
  FACEBOOK: "bg-blue-600",
  INSTAGRAM: "bg-gradient-to-r from-purple-500 to-pink-500",
  YOUTUBE: "bg-red-600",
  TIKTOK: "bg-black",
  REDDIT: "bg-orange-500",
  PINTEREST: "bg-red-500",
  THREADS: "bg-black",
  TELEGRAM: "bg-blue-500",
  DISCORD: "bg-indigo-500",
  SLACK: "bg-purple-600",
  MASTODON: "bg-indigo-600",
  BLUESKY: "bg-sky-500",
  MEDIUM: "bg-black",
  DEVTO: "bg-black",
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

  const handleConnect = async (platform: string) => {
    try {
      const result = await getOAuthUrl.mutateAsync({ platform });
      window.location.href = result.url;
    } catch (err) {
      toast({ title: "Failed to connect", description: "Could not get OAuth URL. Please try again.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Channels</h1>
        <p className="text-muted-foreground">Connect and manage your social media accounts</p>
      </div>

      {/* Connected Channels */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Connected</h2>
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : channels?.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-12">
              <Share2 className="h-12 w-12 text-muted-foreground/30" />
              <p className="mt-4 text-sm font-medium">No channels connected yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Connect your first social media account below
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {channels?.map((channel: any) => (
              <Card key={channel.id} className="overflow-hidden">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-lg text-xs font-bold text-white ${
                        platformColors[channel.platform] || "bg-gray-400"
                      }`}
                    >
                      {channel.platform.slice(0, 2)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{channel.name}</p>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {channel.platform}
                        </Badge>
                        {channel.username && (
                          <span className="text-xs text-muted-foreground">
                            @{channel.username}
                          </span>
                        )}
                      </div>
                    </div>
                    <Badge variant={channel.isActive ? "default" : "secondary"} className="text-[10px]">
                      {channel.isActive ? "Active" : "Paused"}
                    </Badge>
                  </div>
                  <div className="mt-3 flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => toggleActive.mutate({ channelId: channel.id })}
                      title={channel.isActive ? "Pause channel" : "Activate channel"}
                    >
                      <Power className={`h-4 w-4 ${channel.isActive ? "text-green-600" : "text-muted-foreground"}`} />
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
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Available Platforms */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Connect a Platform</h2>
          <p className="text-sm text-muted-foreground">Click to authorize and connect your account</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {platforms?.map((p) => (
            <button
              key={p.platform}
              onClick={() => handleConnect(p.platform)}
              className="group flex items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:border-primary hover:bg-primary/5"
            >
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-lg text-xs font-bold text-white ${
                  platformColors[p.platform] || "bg-gray-400"
                }`}
              >
                {p.platform.slice(0, 2)}
              </div>
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
    </div>
  );
}
