"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Checkbox } from "~/components/ui/checkbox";
import { useToast } from "~/hooks/use-toast";
import { humanizeError } from "~/lib/errors";
import {
  Share2,
  Plus,
  Power,
  Trash2,
  ChevronDown,
  ChevronRight,
  Users,
  Pencil,
  X,
  Check,
  FolderPlus,
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { PlatformIcon } from "~/components/icons/platform-icons";
import { ChannelAvatar } from "~/components/channel-avatar";
import { windowChannels } from "~/lib/channel-list-window";

type PlatformAuthInfo = {
  platform: string;
  displayName: string;
  authType: "oauth" | "token";
  configured: boolean;
  description: string;
  helpUrl: string | null;
  helpLinkLabel?: string | null;
  steps?: string[];
  features?: { chatDetect?: boolean };
  fields: Array<{
    name: string;
    label: string;
    placeholder?: string;
    type: "text" | "password" | "url";
    required: boolean;
    helpText?: string;
    tip?: string;
  }>;
};

type DetectedChat = {
  id: string;
  title: string;
  type: string;
  username: string | null;
};

const GROUP_COLORS = [
  "#6366f1", "#ec4899", "#f59e0b", "#10b981",
  "#3b82f6", "#ef4444", "#8b5cf6", "#14b8a6",
];

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
  WORDPRESS: { name: "WordPress", description: "Blog posts and pages" },
};

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  platform_not_configured:
    "This platform is not configured by the admin. Please contact support.",
  oauth_failed: "Sign-in to the platform failed. Please try again.",
  missing_params:
    "The platform did not return required parameters. Please try again.",
  auth_session_mismatch:
    "Your session expired during sign-in. Please sign in again and retry.",
  auth_unauthenticated:
    "You were signed out during the OAuth flow. Please sign in and try again.",
  auth_org_mismatch:
    "You switched organisations during the flow. Please retry from the original workspace.",
  twitter_request_token_failed:
    "Twitter rejected the initial request. Check that your TWITTER_CLIENT_ID / TWITTER_CLIENT_SECRET are valid.",
  fb_no_pages:
    "No Facebook Page was selected. PostAutomation posts to Pages, not personal profiles. When reconnecting, click “Edit settings” (or “Edit access”) in the Facebook dialog and tick a Page you manage. If you don’t have one yet, create a Facebook Page first, then reconnect.",
  ig_no_business_account:
    "No Instagram Business account found. Convert your Instagram account to Professional/Business and link it to a Facebook Page you manage, then reconnect (click “Edit settings” in the Facebook dialog and tick the Page).",
};

/**
 * Reads OAuth-callback `?error=` / `?success=` query params and surfaces
 * them as toasts. Lives in its own component so we can wrap it in
 * <Suspense> — `useSearchParams()` would otherwise opt the entire page
 * out of static generation and break `next build`.
 */
function OAuthCallbackToaster({ onConnected }: { onConnected: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const errorCode = searchParams.get("error");
    const successCode = searchParams.get("success");
    const platform = searchParams.get("platform");
    const platformLabel = platform
      ? platform.charAt(0).toUpperCase() + platform.slice(1)
      : "Channel";

    if (errorCode) {
      const base =
        OAUTH_ERROR_MESSAGES[errorCode] ??
        "Could not connect the channel. Please try again.";
      const description =
        errorCode === "platform_not_configured" && platform
          ? `${platformLabel} is not configured by the admin. Please contact support.`
          : base;
      toast({
        title: "Could not connect",
        description,
        variant: "destructive",
      });
      router.replace("/dashboard/channels");
    } else if (successCode === "connected") {
      toast({
        title: "Channel connected",
        description: `${platformLabel} added successfully.`,
      });
      router.replace("/dashboard/channels");
      onConnected();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return null;
}

export default function ChannelsPage() {
  const { toast } = useToast();
  const { data: channels, isLoading, refetch } = trpc.channel.list.useQuery();
  const { data: platforms } = trpc.channel.supportedPlatforms.useQuery();
  const { data: channelGroups, refetch: refetchGroups } = trpc.channelGroup.list.useQuery();

  // Group management state
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupColor, setNewGroupColor] = useState(GROUP_COLORS[0]!);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  // Just-created group: transient highlight ring + one-time scroll-into-view
  // so the user immediately sees where to add channels after "Create".
  const [highlightedGroupId, setHighlightedGroupId] = useState<string | null>(null);
  const highlightScrolledRef = useRef(false);

  const { data: platformAuthInfo } = trpc.channel.platformAuthInfo.useQuery();
  const authInfoByPlatform = useMemo(() => {
    const map = new Map<string, PlatformAuthInfo>();
    (platformAuthInfo ?? []).forEach((p) => map.set(p.platform, p as PlatformAuthInfo));
    return map;
  }, [platformAuthInfo]);

  // These three are awaited via mutateAsync inside try/catch blocks that show a
  // domain-specific, more-actionable destructive toast than the generic global
  // handler (lib/trpc/react.tsx) would. A no-op hook-level onError makes the
  // global mutationCacheOnError guard skip them, so they toast exactly once.
  const noopOnError = () => {};
  const getOAuthUrl = trpc.channel.getOAuthUrl.useMutation({ onError: noopOnError });
  const connectWithToken = trpc.channel.connectWithToken.useMutation({ onError: noopOnError });
  const detectTelegramChats = trpc.channel.detectTelegramChats.useMutation({ onError: noopOnError });
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
  // Re-fetch stale platform profile pictures in the background (worker jobs).
  // Errors intentionally fall through to the global toast (no hook-level onError).
  const refreshAvatars = trpc.channel.refreshAvatars.useMutation({
    onSuccess: (result: { queued: number }) => {
      toast({
        title: `Refreshing logos for ${result.queued} channel${result.queued === 1 ? "" : "s"}`,
        description: "They update in the background over the next few minutes.",
      });
    },
  });

  // Bulk-select + delete state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Drives the in-flight state across the WHOLE chunked delete loop, not just
  // the single tRPC call currently in flight (bulkDisconnect.isPending only
  // reflects the latter — it flickers false between batches).
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const toggleSelected = (channelId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  // NOTE: bulkDisconnect caps channelIds at 100 server-side
  // (channel.router.ts: z.array(z.string()).min(1).max(100)). Callers MUST
  // chunk into <=100 batches — do NOT call .mutate with the raw selection.
  const BULK_DELETE_BATCH = 100;
  // No-op hook-level onError so the global mutationCacheOnError guard
  // (lib/trpc/react.tsx) skips this mutation — runBulkDelete's catch already
  // shows the single, more actionable toast (incl. partial-progress count).
  const bulkDisconnect = trpc.channel.bulkDisconnect.useMutation({ onError: noopOnError });

  // Delete the current selection, chunked into <=100-id batches so a large
  // selection (this account has 100+ channels) doesn't trip the server cap.
  const runBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    let deleted = 0;
    try {
      for (let i = 0; i < ids.length; i += BULK_DELETE_BATCH) {
        const batch = ids.slice(i, i + BULK_DELETE_BATCH);
        const r = await bulkDisconnect.mutateAsync({ channelIds: batch });
        deleted += r.deleted;
      }
      toast({ title: `Deleted ${deleted} channel${deleted === 1 ? "" : "(s)"}` });
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      refetch();
    } catch (e) {
      // Partial progress is possible (earlier batches committed); surface the
      // count so the user knows some were removed, and refresh the list.
      toast({
        variant: "destructive",
        title: humanizeError(e),
        description:
          deleted > 0
            ? `${deleted} channel${deleted === 1 ? "" : "(s)"} were deleted before the error.`
            : undefined,
      });
      refetch();
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const createGroup = trpc.channelGroup.create.useMutation({
    onSuccess: (group) => {
      refetchGroups();
      setNewGroupName("");
      toast({
        title: "Group created",
        description:
          "Add channels to it below, then select the whole group in Content Studio → Compose.",
      });
      if (group?.id) {
        highlightScrolledRef.current = false;
        setHighlightedGroupId(group.id);
      }
    },
  });

  // Scroll the just-created group card into view once it appears in the
  // refetched list (the card doesn't exist in the DOM until refetchGroups
  // lands). Scrolls at most once per created group.
  useEffect(() => {
    if (!highlightedGroupId || highlightScrolledRef.current) return;
    if (!(channelGroups ?? []).some((g: any) => g.id === highlightedGroupId)) return;
    highlightScrolledRef.current = true;
    document
      .getElementById(`channel-group-${highlightedGroupId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedGroupId, channelGroups]);

  // Clear the transient highlight ring ~2.5s AFTER the card actually renders.
  // Gating on the group's presence in the refetched list (not merely on
  // highlightedGroupId) means the countdown starts when the ring becomes
  // visible — so a slow refetchGroups (>2.5s) can't consume the highlight
  // window before the card ever mounts.
  useEffect(() => {
    if (!highlightedGroupId) return;
    if (!(channelGroups ?? []).some((g: any) => g.id === highlightedGroupId)) return;
    const t = setTimeout(() => setHighlightedGroupId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightedGroupId, channelGroups]);
  const updateGroup = trpc.channelGroup.update.useMutation({
    onSuccess: () => {
      refetchGroups();
      setEditingGroupId(null);
      toast({ title: "Group updated" });
    },
  });
  const deleteGroup = trpc.channelGroup.delete.useMutation({
    onSuccess: () => { refetchGroups(); toast({ title: "Group deleted" }); },
  });
  const addToGroup = trpc.channelGroup.addChannel.useMutation({
    onSuccess: (group) => {
      refetchGroups();
      toast({ title: `Added to ${group?.name ?? "group"}` });
    },
  });
  const removeFromGroup = trpc.channelGroup.removeChannel.useMutation({
    onSuccess: (group) => {
      refetchGroups();
      toast({ title: `Removed from ${group?.name ?? "group"}` });
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
  // Auto-expand first platform once, in an effect (NOT during render — setting
  // state in the render body forces an extra render pass, which compounded the
  // large-list paint cost).
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!initialized && connectedPlatforms.length > 0) {
      setExpandedPlatforms(new Set([connectedPlatforms[0]!]));
      setInitialized(true);
    }
  }, [initialized, connectedPlatforms]);

  // Per-platform "show all channels" opt-in — a platform with hundreds of
  // channels (Meta orgs have 300+ Pages) renders only the first window on
  // expand so the page paints instantly; the user reveals the rest on demand.
  const [showAllPlatforms, setShowAllPlatforms] = useState<Set<string>>(new Set());
  const toggleShowAll = (platform: string) => {
    setShowAllPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  };

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

  // Dialog state — exactly one of these holds a platform at a time.
  const [tokenDialogPlatform, setTokenDialogPlatform] =
    useState<PlatformAuthInfo | null>(null);
  const [setupDialogPlatform, setSetupDialogPlatform] =
    useState<PlatformAuthInfo | null>(null);
  const [tokenFormValues, setTokenFormValues] = useState<Record<string, string>>({});

  // Telegram-only: detected chat list + which one is selected.
  const [detectedChats, setDetectedChats] = useState<DetectedChat[] | null>(null);

  const resetTokenDialog = () => {
    setTokenDialogPlatform(null);
    setTokenFormValues({});
    setDetectedChats(null);
  };

  const runTelegramDetect = async () => {
    const botToken = tokenFormValues.botToken?.trim();
    if (!botToken) {
      toast({
        title: "Enter the bot token first",
        description: "Paste the bot token from @BotFather, then click Detect chats.",
        variant: "destructive",
      });
      return;
    }
    try {
      const result = await detectTelegramChats.mutateAsync({ botToken });
      setDetectedChats(result.chats);
      if (result.chats.length === 0) {
        toast({
          title: `Bot ${result.botUsername} is connected — but no chats yet`,
          description:
            "Add @" +
            result.botUsername +
            " to a channel/group as administrator, post any message, then click Detect chats again.",
        });
      } else {
        toast({
          title: `Found ${result.chats.length} chat${result.chats.length === 1 ? "" : "s"}`,
          description: "Pick one below — the chat ID will fill in automatically.",
        });
      }
    } catch (err) {
      toast({
        title: "Couldn't detect chats",
        description: humanizeError(err, "Check the bot token and try again."),
        variant: "destructive",
      });
    }
  };

  const handleConnect = async (platform: string) => {
    const info = authInfoByPlatform.get(platform);
    if (!info) {
      // platformAuthInfo hasn't loaded yet — fall back to the OAuth flow
      try {
        const result = await getOAuthUrl.mutateAsync({ platform });
        window.location.href = result.url;
      } catch (err) {
        toast({
          title: "Failed to connect",
          description: humanizeError(err, "Could not start the connect flow. Please try again."),
          variant: "destructive",
        });
      }
      return;
    }

    if (info.authType === "token") {
      setTokenFormValues({});
      setDetectedChats(null);
      setTokenDialogPlatform(info);
      return;
    }

    if (!info.configured) {
      // OAuth platform without env vars set — show setup-required dialog instead of failing silently.
      setSetupDialogPlatform(info);
      return;
    }

    try {
      const result = await getOAuthUrl.mutateAsync({ platform });
      window.location.href = result.url;
    } catch (err) {
      toast({
        title: "Failed to connect",
        description: humanizeError(err, "Could not start the OAuth flow. Please try again."),
        variant: "destructive",
      });
    }
  };

  const handleTokenSubmit = async () => {
    if (!tokenDialogPlatform) return;
    // Front-end required-field check (back-end re-validates).
    const missing = tokenDialogPlatform.fields
      .filter((f) => f.required && !tokenFormValues[f.name]?.trim())
      .map((f) => f.label);
    if (missing.length) {
      toast({
        title: "Missing required fields",
        description: `Please fill in: ${missing.join(", ")}.`,
        variant: "destructive",
      });
      return;
    }
    try {
      await connectWithToken.mutateAsync({
        platform: tokenDialogPlatform.platform,
        credentials: tokenFormValues,
      });
      toast({
        title: "Channel connected",
        description: `${tokenDialogPlatform.displayName} added successfully.`,
      });
      resetTokenDialog();
      void refetch();
    } catch (err) {
      toast({
        title: "Could not connect",
        description: humanizeError(
          err,
          "Could not verify those credentials. Double-check and try again."
        ),
        variant: "destructive",
      });
    }
  };

  const totalChannels = channels?.length ?? 0;
  const activeChannels = channels?.filter((c: any) => c.isActive).length ?? 0;

  return (
    <div className="space-y-8">
      {/* OAuth callback ?error / ?success — own Suspense boundary so the
          page doesn't bail out of static export. */}
      <Suspense fallback={null}>
        <OAuthCallbackToaster onConnected={() => void refetch()} />
      </Suspense>

      {/* Floating bulk-action bar — only when something is selected */}
      {selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-full border bg-background/95 px-4 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <span className="text-sm font-medium">
              {selectedIds.size} selected
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              disabled={isBulkDeleting}
            >
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={isBulkDeleting}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete Selected
            </Button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Channels</h1>
          <p className="text-muted-foreground">
            Connect and manage the social media accounts in this workspace
          </p>
        </div>
        {totalChannels > 0 && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshAvatars.mutate()}
              disabled={refreshAvatars.isPending}
              title="Re-fetch profile pictures from each platform"
            >
              {refreshAvatars.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh logos
            </Button>
            <div
              className="text-right"
              title="Counts reflect only the active workspace"
            >
              <p className="text-2xl font-bold">{totalChannels}</p>
              <p className="text-xs text-muted-foreground">
                {activeChannels} active in this workspace
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

            // Per-platform selection state for the select-all checkbox
            const selectedInPlatform = platformChannels.filter((c: any) =>
              selectedIds.has(c.id)
            ).length;
            const allSelected =
              platformChannels.length > 0 &&
              selectedInPlatform === platformChannels.length;
            const someSelected =
              selectedInPlatform > 0 && !allSelected;

            const toggleSelectAllInPlatform = () => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (allSelected) {
                  // Deselect all in this platform
                  for (const c of platformChannels) next.delete((c as any).id);
                } else {
                  // Select all in this platform
                  for (const c of platformChannels) next.add((c as any).id);
                }
                return next;
              });
            };

            return (
              <Card key={platform} className="overflow-hidden">
                {/* Accordion Header — a div (not a button) so the select-all
                    Checkbox and the Add button can nest without invalid
                    button-in-button HTML. The icon/title region carries the
                    expand/collapse click + keyboard handlers. */}
                <div
                  className="flex w-full items-center gap-2.5 p-3 text-left transition-colors hover:bg-muted/50 sm:gap-4 sm:p-4"
                >
                  {/* Select-all-in-platform checkbox — sibling of the toggle
                      region, never a descendant of a button */}
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleSelectAllInPlatform}
                    className={`h-4 w-4 shrink-0 self-center rounded-full ${
                      someSelected
                        ? "border-primary bg-primary/40 text-primary-foreground"
                        : ""
                    }`}
                    aria-label={`Select all ${info?.name ?? platform} channels`}
                    title={
                      allSelected
                        ? "Deselect all"
                        : someSelected
                        ? "Select all (some selected)"
                        : "Select all"
                    }
                  />

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpanded(platform)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleExpanded(platform);
                      }
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-4"
                  >
                  <PlatformIcon platform={platform} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="text-base font-semibold">
                        {info?.name ?? platform}
                      </h3>
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        <Users className="mr-1 h-3 w-3" />
                        {platformChannels.length}{" "}
                        {platformChannels.length === 1
                          ? "account"
                          : "accounts"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px] text-green-600"
                      >
                        {activeCount} active
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {info?.description ?? "Social media platform"}
                    </p>
                  </div>

                  {/* Expand/Collapse Icon (inside the clickable toggle region) */}
                  {isExpanded ? (
                    <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                  )}
                  </div>

                  {/* Add More Button — sibling of the toggle region */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mr-2 shrink-0"
                    onClick={() => handleConnect(platform)}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>

                {/* Accordion Content — Channel List.
                    Only the first window renders on expand; a platform can hold
                    hundreds of channels (Meta orgs have 300+ Pages) and painting
                    them all at once blocked Safari's main thread for minutes
                    (the "blank screen after reconnect" bug). */}
                {isExpanded && (() => {
                  const { visible: visibleChannels, hiddenCount } = windowChannels(
                    platformChannels,
                    showAllPlatforms.has(platform),
                    selectedIds
                  );
                  return (
                  <div className="border-t">
                    {visibleChannels.map((channel: any, idx: number) => (
                      <div
                        key={channel.id}
                        className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30 ${
                          idx < visibleChannels.length - 1 ? "border-b" : ""
                        }`}
                      >
                        {/* Select checkbox */}
                        <Checkbox
                          checked={selectedIds.has(channel.id)}
                          onCheckedChange={() => toggleSelected(channel.id)}
                          className="h-4 w-4 shrink-0 self-center rounded-full"
                          aria-label={`Select ${channel.name}`}
                        />

                        {/* Avatar */}
                        <ChannelAvatar
                          avatar={channel.avatar}
                          name={channel.name}
                          className="h-9 w-9 shrink-0"
                        />

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
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleShowAll(platform)}
                        className="w-full border-t px-4 py-3 text-sm font-medium text-primary hover:bg-muted/30"
                      >
                        Show all {platformChannels.length} channels ({hiddenCount} more)
                      </button>
                    )}
                    {showAllPlatforms.has(platform) && platformChannels.length > 30 && (
                      <button
                        type="button"
                        onClick={() => toggleShowAll(platform)}
                        className="w-full border-t px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-muted/30"
                      >
                        Show fewer
                      </button>
                    )}
                  </div>
                  );
                })()}
              </Card>
            );
          })}
        </div>
      )}

      {/* Channel Groups */}
      {channels && channels.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Channel Groups</h2>
              <p className="text-sm text-muted-foreground">
                Organize channels into groups for quick selection when posting
              </p>
            </div>
          </div>

          {/* Create group */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FolderPlus className="h-4 w-4" />
                New Group
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="Group name (e.g. News, Marketing)"
                  className="flex-1"
                  onKeyDown={(e) => {
                    // isPending guard mirrors the Create button's disabled state —
                    // without it, holding/re-pressing Enter double-creates the group.
                    if (e.key === "Enter" && newGroupName.trim() && !createGroup.isPending) {
                      createGroup.mutate({ name: newGroupName.trim(), color: newGroupColor });
                    }
                  }}
                />
                <Button
                  size="sm"
                  className="h-9 shrink-0"
                  disabled={!newGroupName.trim() || createGroup.isPending}
                  onClick={() => createGroup.mutate({ name: newGroupName.trim(), color: newGroupColor })}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Create
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    data-compact
                    onClick={() => setNewGroupColor(color)}
                    className={`h-5 w-5 shrink-0 rounded-full transition-transform ${
                      newGroupColor === color ? "scale-125 ring-2 ring-offset-1 ring-offset-background" : ""
                    }`}
                    style={{ background: color }}
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Existing groups */}
          {channelGroups && channelGroups.length > 0 && (
            <div className="space-y-3">
              {channelGroups.map((group: any) => (
                <Card
                  key={group.id}
                  id={`channel-group-${group.id}`}
                  className={`transition-shadow ${
                    highlightedGroupId === group.id
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                      : ""
                  }`}
                >
                  <CardContent className="pt-4">
                    {/* Group header */}
                    <div className="mb-3 flex items-center gap-2">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: group.color }} />
                      {editingGroupId === group.id ? (
                        <div className="flex flex-1 items-center gap-2">
                          <Input
                            value={editingGroupName}
                            onChange={(e) => setEditingGroupName(e.target.value)}
                            className="h-7 min-w-0 flex-1 text-sm"
                            autoFocus
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => updateGroup.mutate({ id: group.id, name: editingGroupName })}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => setEditingGroupId(null)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <span className="flex-1 text-sm font-medium">{group.name}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {(group.channels ?? []).length} channels
                          </Badge>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => { setEditingGroupId(group.id); setEditingGroupName(group.name); }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => { if (confirm("Delete this group?")) deleteGroup.mutate({ id: group.id }); }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>

                    {/* Channel checkboxes */}
                    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {channels.map((channel: any) => {
                        const inGroup = (group.channels ?? []).some((c: any) => c.id === channel.id);
                        return (
                          <label
                            key={channel.id}
                            className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-all ${
                              inGroup ? "border-primary/50 bg-primary/5" : "hover:bg-muted/50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={inGroup}
                              onChange={() => {
                                if (inGroup) {
                                  removeFromGroup.mutate({ groupId: group.id, channelId: channel.id });
                                } else {
                                  addToGroup.mutate({ groupId: group.id, channelId: channel.id });
                                }
                              }}
                              className="h-3.5 w-3.5 rounded"
                            />
                            <ChannelAvatar
                              avatar={channel.avatar}
                              name={channel.name}
                              className="h-5 w-5 shrink-0"
                              fallbackClassName="text-[9px]"
                            />
                            <span className="min-w-0 flex-1 truncate font-medium">{channel.name}</span>
                            <span className="shrink-0 text-muted-foreground">{channel.platform.slice(0, 2)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Connect a Platform — only show platforms not yet connected */}
      {unconnectedPlatforms && unconnectedPlatforms.length > 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Connect a Platform</h2>
            <p className="text-sm text-muted-foreground">
              Token-based platforms connect with a paste-in dialog. OAuth platforms redirect you
              to the official sign-in flow when their credentials are configured.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {unconnectedPlatforms.map((p) => {
              const info = authInfoByPlatform.get(p.platform);
              const isToken = info?.authType === "token";
              const needsSetup = info?.authType === "oauth" && info.configured === false;
              return (
                <button
                  key={p.platform}
                  onClick={() => handleConnect(p.platform)}
                  className="group flex items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:border-primary hover:bg-primary/5"
                >
                  <PlatformIcon platform={p.platform} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate font-medium">{p.displayName}</p>
                      {isToken && (
                        <Badge variant="secondary" className="shrink-0 text-[9px]">
                          Token
                        </Badge>
                      )}
                      {needsSetup && (
                        <Badge
                          variant="outline"
                          className="shrink-0 text-[9px] border-amber-500/40 text-amber-600 dark:text-amber-400"
                        >
                          Setup
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {isToken
                        ? "No developer app needed"
                        : needsSetup
                        ? "OAuth credentials missing"
                        : "Click to connect"}
                    </p>
                  </div>
                  {needsSetup ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : isToken ? (
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground opacity-70 group-hover:opacity-100" />
                  ) : (
                    <Plus className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Token-based connect dialog ─────────────────────────────────── */}
      <Dialog
        open={tokenDialogPlatform !== null}
        onOpenChange={(open) => {
          if (!open) resetTokenDialog();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          {tokenDialogPlatform && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <PlatformIcon platform={tokenDialogPlatform.platform} size="sm" />
                  Connect {tokenDialogPlatform.displayName}
                </DialogTitle>
                <DialogDescription>
                  {tokenDialogPlatform.description}
                </DialogDescription>
              </DialogHeader>

              {/* Step-by-step setup instructions */}
              {tokenDialogPlatform.steps && tokenDialogPlatform.steps.length > 0 && (
                <div className="rounded-md border bg-muted/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    How to get your credentials
                  </p>
                  <ol className="space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
                    {tokenDialogPlatform.steps.map((step, idx) => (
                      <li key={idx} className="list-decimal">
                        {step}
                      </li>
                    ))}
                  </ol>
                  {tokenDialogPlatform.helpUrl && (
                    <a
                      href={tokenDialogPlatform.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      {tokenDialogPlatform.helpLinkLabel ??
                        `Open ${tokenDialogPlatform.displayName} docs`}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}

              {/* Per-field inputs */}
              <div className="space-y-3">
                {tokenDialogPlatform.fields.map((field) => (
                  <div key={field.name} className="space-y-1.5">
                    <Label htmlFor={`tok-${field.name}`}>
                      {field.label}
                      {field.required && (
                        <span className="ml-0.5 text-destructive">*</span>
                      )}
                    </Label>
                    <Input
                      id={`tok-${field.name}`}
                      type={field.type === "password" ? "password" : "text"}
                      placeholder={field.placeholder}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={tokenFormValues[field.name] ?? ""}
                      onChange={(e) =>
                        setTokenFormValues((prev) => ({
                          ...prev,
                          [field.name]: e.target.value,
                        }))
                      }
                    />
                    {field.tip && (
                      <p className="text-xs italic text-muted-foreground/80">{field.tip}</p>
                    )}
                    {field.helpText && (
                      <p className="text-xs text-muted-foreground">{field.helpText}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Telegram-specific: Detect chats button + picker */}
              {tokenDialogPlatform.features?.chatDetect && (
                <div className="space-y-2 rounded-md border bg-sky-500/5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">Detect chats your bot is in</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={runTelegramDetect}
                      disabled={detectTelegramChats.isPending}
                    >
                      {detectTelegramChats.isPending ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Detect chats
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Add your bot to a Telegram channel/group as <strong>admin</strong>, post any
                    message there, then click Detect chats to auto-fill the chat ID below.
                  </p>

                  {detectedChats !== null && (
                    <div className="space-y-1.5 rounded-md border bg-background p-2">
                      {detectedChats.length === 0 ? (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                          No chats found yet. Add the bot to a chat as admin, post a message,
                          and click Detect again.
                        </p>
                      ) : (
                        detectedChats.map((c) => {
                          const checked = tokenFormValues.chatId === c.id;
                          return (
                            <label
                              key={c.id}
                              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted ${
                                checked ? "bg-primary/10" : ""
                              }`}
                            >
                              <input
                                type="radio"
                                name="telegramChat"
                                checked={checked}
                                onChange={() =>
                                  setTokenFormValues((prev) => ({
                                    ...prev,
                                    chatId: c.id,
                                  }))
                                }
                                className="shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium">{c.title}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {c.type}
                                  {c.username ? ` · @${c.username}` : ""} · {c.id}
                                </p>
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              )}

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={resetTokenDialog}
                  disabled={connectWithToken.isPending}
                >
                  Cancel
                </Button>
                <Button onClick={handleTokenSubmit} disabled={connectWithToken.isPending}>
                  {connectWithToken.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Connect
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── OAuth "Setup required" dialog ──────────────────────────────── */}
      <Dialog
        open={setupDialogPlatform !== null}
        onOpenChange={(open) => {
          if (!open) setSetupDialogPlatform(null);
        }}
      >
        <DialogContent className="max-w-lg">
          {setupDialogPlatform && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  {setupDialogPlatform.displayName} not yet configured
                </DialogTitle>
                <DialogDescription>
                  This platform uses OAuth. The administrator needs to register an OAuth app
                  on the provider's developer portal once, then put the credentials in the
                  server's environment.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p>
                  Once the administrator adds{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {setupDialogPlatform.platform}_CLIENT_ID
                  </code>{" "}
                  and{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {setupDialogPlatform.platform}_CLIENT_SECRET
                  </code>{" "}
                  to <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">.env</code>{" "}
                  and redeploys, this Connect button will start the standard OAuth flow.
                </p>
                <p className="text-muted-foreground">
                  Step-by-step setup instructions for every OAuth platform are in
                  <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">docs/OAUTH_SETUP.md</code>
                  in the repo.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setSetupDialogPlatform(null)}>OK</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Bulk-delete confirm dialog ─────────────────────────────────── */}
      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => {
          if (!isBulkDeleting) setBulkDeleteOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete {selectedIds.size} channel
              {selectedIds.size === 1 ? "" : "(s)"}?
            </DialogTitle>
            <DialogDescription>
              This cannot be undone. The selected channels will be disconnected
              and removed from this workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={isBulkDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runBulkDelete()}
              disabled={isBulkDeleting}
            >
              {isBulkDeleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
