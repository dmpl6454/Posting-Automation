"use client";

import { humanizeError } from "~/lib/errors";
import { buildCreatePostQuery } from "~/lib/repurpose-create-post-params";
import { parseVideoReadyEvent, isVideoErrorEvent, finalizeRunningSteps } from "~/lib/parse-video-event";
import { stripBareUrls } from "~/lib/strip-bare-urls";

import { useState, useEffect, useRef, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { useActiveTask } from "~/lib/active-task";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useToast } from "~/hooks/use-toast";
import {
  Sparkles,
  Copy,
  Check,
  Loader2,
  RefreshCw,
  FileText,
  ArrowRight,
  Link2,
  Image,
  Layers,
  Film,
  Globe,
  ExternalLink,
  Mic,
  Music,
  Video,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Download,
} from "lucide-react";

const ALL_PLATFORMS = [
  "TWITTER", "LINKEDIN", "INSTAGRAM", "FACEBOOK", "REDDIT", "YOUTUBE",
  "TIKTOK", "PINTEREST", "THREADS", "MASTODON", "BLUESKY", "MEDIUM", "DEVTO",
] as const;

const providers = ["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"] as const;

const FORMAT_OPTIONS = [
  { id: "static" as const, label: "Static Post", icon: Image, desc: "Single branded image + caption" },
  { id: "carousel" as const, label: "Carousel", icon: Layers, desc: "Multi-slide carousel post" },
  { id: "reel" as const, label: "Slideshow Reel", icon: Film, desc: "Your key points become video slides with optional voiceover + music" },
  { id: "seedance_video" as const, label: "AI Video", icon: Video, desc: "Real AI-generated cinematic footage with native audio", badge: "NEW" },
  { id: "ai_video" as const, label: "AI Video (Veo3)", icon: Video, desc: "Temporarily unavailable", disabled: true, badge: "SOON" },
];

const THEMES = [
  { id: "dark" as const, label: "Dark", color: "bg-zinc-900" },
  { id: "light" as const, label: "Light", color: "bg-zinc-100" },
  { id: "gradient" as const, label: "Gradient", color: "bg-gradient-to-r from-indigo-900 to-purple-900" },
];

// T7: a pasted aesthetic-ref URL looks like a social/post PAGE (not a direct
// image) when the host is a known social network OR the URL lacks a common image
// extension. In that case the backend extracts the og:image, so we hint the user.
function looksLikePostUrl(value: string): boolean {
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  let host = "";
  let pathname = "";
  try {
    const u = new URL(v);
    host = u.hostname.toLowerCase();
    pathname = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/(^|\.)(instagram|facebook|twitter|x)\.com$/.test(host)) return true;
  return !/\.(jpe?g|png|webp|gif)$/.test(pathname);
}

export function RepurposeTab() {
  const { toast } = useToast();

  // Source mode
  const [sourceMode, setSourceMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [originalContent, setOriginalContent] = useState("");

  // Options
  const [format, setFormat] = useState<"static" | "carousel" | "reel" | "ai_video" | "seedance_video">("static");
  // No platforms pre-selected — the user explicitly picks targets (the
  // Generate button stays disabled until at least one is chosen).
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  // Default to OpenAI for text generation — the Google-family providers
  // (gemini/gemma4) currently share a billing-held project (403). The backend
  // also falls back to OpenAI automatically if a chosen provider fails.
  const [provider, setProvider] = useState<typeof providers[number]>("openai");
  const [theme, setTheme] = useState<"dark" | "light" | "gradient">("light");
  // Brand accent color — sourced from the picker below and from a saved
  // template's brandColor. Sent to the router as accentColor when non-empty.
  const [accentColor, setAccentColor] = useState<string>("");
  const [voiceOver, setVoiceOver] = useState(true);
  const [voiceType, setVoiceType] = useState<string>("nova");
  const [bgMusic, setBgMusic] = useState(true);
  const [creativeStyle, setCreativeStyle] = useState<"premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic">("premium_editorial");
  const [logoPosition, setLogoPosition] = useState<"top-left" | "top-right">("top-right");
  // E2: number of CONTENT slides in a carousel (cover + cta added around these).
  // Default 5 preserves prior behaviour. Only shown when format === "carousel".
  const [slideCount, setSlideCount] = useState<number>(5);
  // D7a: Seedance AI-video clip length (seconds, provider range 2–12). Default
  // 8 preserves prior behaviour. Only shown/sent when format === "seedance_video".
  const [videoDuration, setVideoDuration] = useState<number>(8);
  const [logoUrl, setLogoUrl] = useState<string>("");
  const [logoMediaId, setLogoMediaId] = useState<string>("");
  // E1: aesthetic/style reference image the AI mimics (Gemini-only on backend).
  const [aestheticRefUrl, setAestheticRefUrl] = useState<string>("");
  // E3a: free-text aesthetic/style notes appended to the AI background prompt.
  const [imageContext, setImageContext] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  // E4: user-attached image(s) for a STATIC repurpose. When set, these BECOME
  // the post media and the AI image generation is skipped (captions still
  // generate). Each entry carries the Media id + url (for preview).
  const [userMedia, setUserMedia] = useState<{ id: string; url: string }[]>([]);
  // Whether the user's own image replaces the AI image (static format only).
  const useOwnImage = format === "static" && userMedia.length > 0;

  // Results
  const [results, setResults] = useState<{
    extracted?: { title: string; description: string; siteName: string; type: string; url: string; images?: string[] };
    platformContent: Record<string, string>;
    mediaUrls: string[];
    mediaMap?: Record<string, { url: string; mediaId: string }>;
    carouselMediaIds?: string[];
    mediaType: string;
    format: string;
    mediaFailed?: boolean;
    // PART A/D: the exact headline + hook line the server rendered the creative
    // with — so Regenerate re-renders with the SAME inputs (capped headline +
    // hook) instead of the raw extracted page title.
    renderedHeadline?: string | null;
    hookLine?: string | null;
  } | null>(null);
  const [copiedPlatform, setCopiedPlatform] = useState<string | null>(null);

  // Progress / activity log
  interface ProgressStep { step: string; status: "running" | "done" | "error" | "skipped"; detail?: string; ts: number }
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [progressId, setProgressId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Async video (reel / seedance): the mutation returns { videoPending } and the
  // worker pushes a terminal `video_ready`/`video_error` over the SAME SSE the
  // activity log already listens to. While the worker generates, keep the spinner
  // up via this flag (the mutation has long since resolved, so isLoading is false).
  const [videoGenerating, setVideoGenerating] = useState(false);
  const videoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stop the SSE + clear the safety timeout in one place.
  const closeVideoStream = useCallback(() => {
    if (videoTimeoutRef.current) {
      clearTimeout(videoTimeoutRef.current);
      videoTimeoutRef.current = null;
    }
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const startProgress = useCallback(() => {
    const id = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setProgressId(id);
    setProgressSteps([]);

    // Connect SSE
    const es = new EventSource(`/api/progress?id=${id}`);
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const step: ProgressStep = JSON.parse(ev.data);
        if (step.step === "__finished__") {
          // Self-heal the synchronous path: flip any lingering running step to
          // the finishing status. (The async-video path closes the SSE on
          // video_ready before __finished__ arrives, so this is belt-and-braces
          // — finalizeRunningSteps also runs in the video_ready/error branches.)
          setProgressSteps((prev) =>
            finalizeRunningSteps(prev, step.status === "error" ? "error" : "done"),
          );
          es.close();
          eventSourceRef.current = null;
          return;
        }

        // Terminal async-video events from the repurpose-video worker. These
        // arrive on the SAME stream as the activity log; render the finished
        // video (or surface the error) and stop the spinner.
        const ready = parseVideoReadyEvent(step);
        if (ready) {
          // MERGE the video onto the existing result so the captions stored by
          // onSuccess (videoPending branch) survive — replacing with {} here was
          // the caption-loss regression. `prev ?? {}` guards the edge case where
          // step 1 didn't run, but it now always sets `results` first.
          setResults((prev) => ({
            ...(prev ?? {}),
            // Keep platformContent (captions) from the videoPending result.
            platformContent: prev?.platformContent ?? {},
            // The video card branches on mediaType === "video/mp4" (reel) or
            // format ai_video/seedance_video — set both so every format renders.
            mediaUrls: [ready.url],
            mediaType: "video/mp4",
            format: ready.format || prev?.format || "",
            // Publish path attaches the VIDEO (not slide images) via carouselMediaIds.
            carouselMediaIds: [ready.mediaId],
          }));
          setVideoGenerating(false);
          // The worker re-publishes "done" for each step, but the client closes
          // the SSE on video_ready (below) — so any step still showing "running"
          // (race: the worker's done re-publish hadn't arrived yet) would spin
          // forever. Flip every outstanding running step → done before closing.
          setProgressSteps((prev) => finalizeRunningSteps(prev, "done"));
          toast({ title: "Video ready!", description: "Your video has been generated." });
          closeVideoStream();
          return;
        }
        if (isVideoErrorEvent(step)) {
          setVideoGenerating(false);
          // Flip outstanding running steps → error so none spin forever after
          // the stream closes (the worker only published them as "running").
          setProgressSteps((prev) => finalizeRunningSteps(prev, "error"));
          toast({
            title: "Video generation failed",
            description: step.detail || "The video could not be produced. See the activity log.",
            variant: "destructive",
          });
          closeVideoStream();
          // fall through so the error step still appears in the activity log
        }

        setProgressSteps((prev) => {
          // Update existing step or add new one
          const idx = prev.findIndex((s) => s.step === step.step);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = step;
            return updated;
          }
          return [...prev, step];
        });
      } catch {}
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
    };

    return id;
  }, []);

  // Cleanup SSE + safety timeout on unmount
  useEffect(() => {
    return () => {
      if (videoTimeoutRef.current) clearTimeout(videoTimeoutRef.current);
      eventSourceRef.current?.close();
    };
  }, []);

  // Channel info (for branding + publishing)
  const { data: channels } = trpc.channel.list.useQuery();
  const { data: creativeTemplates } = trpc.creativeTemplate.list.useQuery();
  const createTemplate = trpc.creativeTemplate.create.useMutation();
  const utils = trpc.useUtils();
  const activeChannels = (channels as any[])?.filter((c: any) => c.isActive) || [];
  const primaryChannel = activeChannels[0];
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [channelSearch, setChannelSearch] = useState("");
  const [publishingState, setPublishingState] = useState<"idle" | "publishing" | "done">("idle");
  const filteredChannels = activeChannels.filter((c: any) =>
    !channelSearch || c.name?.toLowerCase().includes(channelSearch.toLowerCase()) || c.username?.toLowerCase().includes(channelSearch.toLowerCase()) || c.platform?.toLowerCase().includes(channelSearch.toLowerCase())
  );

  // No channel pre-selected — the user explicitly chooses which channel(s) to
  // publish to (previously the first channel was auto-selected).

  // Create post mutation
  const createPost = trpc.post.create.useMutation({
    onSuccess: () => {},
    onError: (err) => {
      toast({ title: "Failed to create post", description: humanizeError(err), variant: "destructive" });
    },
  });

  // URL extract (preview)
  const [extractedPreview, setExtractedPreview] = useState<{
    title: string; description: string; siteName: string; type: string; images: string[];
  } | null>(null);

  const extractMutation = trpc.repurpose.extractUrl.useMutation({
    onSuccess: (data) => {
      setExtractedPreview(data);
      toast({ title: "Content extracted", description: `"${data.title}"` });
    },
    onError: (err) => {
      toast({ title: "Extraction failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  // Text-based repurpose (existing)
  const repurpose = trpc.repurpose.repurpose.useMutation({
    onSuccess: (data) => {
      setResults({ platformContent: data.platformContent, mediaUrls: [], mediaType: "", format: "text" });
      toast({ title: "Content repurposed!" });
    },
    onError: (err) => {
      toast({ title: "Repurpose failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  // URL-based repurpose
  const repurposeFromUrl = trpc.repurpose.repurposeFromUrl.useMutation({
    onSuccess: (data) => {
      // Async video path (reel / seedance): the mutation returns immediately with
      // `videoPending` while the worker generates. Render the captions NOW (they're
      // already in `data.platformContent`; `data.mediaUrls` is [] so the video card
      // stays hidden until the worker's terminal `video_ready` grafts the video on).
      // Keep the spinner up and the SSE open; do NOT show a "repurposed!" success.
      if ((data as { videoPending?: boolean }).videoPending) {
        // Store the result so the per-platform caption cards render immediately —
        // the video_ready handler later MERGES the video onto this same state,
        // preserving these captions (regression fix).
        setResults(data);
        setVideoGenerating(true);
        toast({
          title: "Generating your video…",
          description: "This can take a minute. It'll appear here as soon as it's ready.",
        });
        // Safety timeout: if no terminal event arrives, stop the spinner and the
        // SSE rather than spinning forever.
        if (videoTimeoutRef.current) clearTimeout(videoTimeoutRef.current);
        videoTimeoutRef.current = setTimeout(() => {
          videoTimeoutRef.current = null;
          setVideoGenerating(false);
          toast({
            title: "Still processing",
            description: "Your video is taking longer than expected — it'll appear in the post shortly. Check back soon.",
          });
          eventSourceRef.current?.close();
          eventSourceRef.current = null;
        }, 10 * 60 * 1000);
        return;
      }
      setResults(data);
      const mediaCount = data.mediaUrls.length;
      // Be honest: if captions generated but media failed, this is NOT a clean
      // success — show a warning toast that points at the activity log, not a
      // misleading "Content repurposed!" (Fix 4).
      if (data.mediaFailed) {
        toast({
          title: "Captions ready — image/video failed",
          description: `${Object.keys(data.platformContent).length} captions generated, but the ${data.format === "reel" || data.format === "ai_video" ? "video" : "image"} could not be produced. See the activity log for the provider error.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Content repurposed!",
          description: `${Object.keys(data.platformContent).length} captions + ${mediaCount} ${data.format === "reel" ? "video" : mediaCount === 1 ? "image" : "slides"} generated.`,
        });
      }
    },
    onError: (err) => {
      toast({ title: "Repurpose failed", description: humanizeError(err), variant: "destructive" });
      setProgressSteps((prev) => [...prev, { step: "Request failed", status: "error" as const, detail: err.message, ts: Date.now() }]);
      eventSourceRef.current?.close();
    },
  });

  // E3b — per-image "Regenerate": re-roll JUST the static image / a carousel
  // slide's image without re-running the whole repurpose flow. `regenTarget`
  // tracks which card is loading: "static" for the single image, or the slide
  // index for a carousel slide (so each button shows its own spinner).
  const [regenTarget, setRegenTarget] = useState<"static" | number | null>(null);
  const regenerateImage = trpc.repurpose.regenerateImage.useMutation();

  // Resolve the channel name/handle/avatar the same way handleGenerate does, so
  // the regenerated creative keeps the same branding as the original.
  const resolveBranding = () => {
    const ch = selectedChannelIds.length > 0
      ? activeChannels.find((c: any) => c.id === selectedChannelIds[0])
      : primaryChannel;
    return {
      channelName: ch?.name || "Channel",
      channelHandle: ch?.username || "",
      logoUrl: logoUrl || ch?.avatar || undefined,
    };
  };

  const handleRegenerate = async (target: "static" | number) => {
    if (!results) return;
    // Headline: prefer the EXACT headline the server rendered the original with
    // (capped + synthesized), falling back to the raw extracted title. This makes
    // the regenerated image match the original instead of diverging (R3).
    const headline = (results.renderedHeadline ?? results.extracted?.title ?? "").trim();
    if (!headline) {
      toast({ title: "Can't regenerate", description: "No headline found for this image.", variant: "destructive" });
      return;
    }
    const { channelName, channelHandle, logoUrl: brandLogo } = resolveBranding();
    // Reuse the SAME background photo (first https article image) the original
    // creative sat on — the server re-validates it with isPublicImageUrl — plus
    // the article-context blurb so the AI background reflects the article.
    const bgImageUrl = results.extracted?.images?.find((u) => u.startsWith("https://"));
    const bgContext = results.extracted?.description?.slice(0, 600);
    setRegenTarget(target);
    try {
      const res = await regenerateImage.mutateAsync({
        headline,
        creativeStyle,
        theme,
        logoUrl: brandLogo,
        logoPosition,
        accentColor: accentColor || undefined,
        imageContext: stripBareUrls(imageContext) || undefined,
        aestheticRefUrl: aestheticRefUrl || undefined,
        channelName,
        channelHandle,
        // R3 parity: carry the rendered hook line, the article background photo,
        // and the article-context blurb so the regenerated image matches.
        hookLine: results.hookLine ?? undefined,
        bgImageUrl: bgImageUrl || undefined,
        bgContext: bgContext || undefined,
      });
      // Swap the displayed image (and its Media id for publish) in `results`.
      setResults((prev) => {
        if (!prev) return prev;
        const nextUrls = [...prev.mediaUrls];
        const idx = target === "static" ? 0 : target;
        nextUrls[idx] = res.url;
        const nextCarouselIds = prev.carouselMediaIds ? [...prev.carouselMediaIds] : undefined;
        if (nextCarouselIds && idx < nextCarouselIds.length) nextCarouselIds[idx] = res.mediaId;
        // For a single static image also refresh the per-platform mediaMap so the
        // "Create Draft" path attaches the NEW image.
        let nextMap = prev.mediaMap;
        if (target === "static" && nextMap) {
          nextMap = { ...nextMap };
          for (const k of Object.keys(nextMap)) nextMap[k] = { url: res.url, mediaId: res.mediaId };
        }
        return { ...prev, mediaUrls: nextUrls, carouselMediaIds: nextCarouselIds, mediaMap: nextMap };
      });
      toast({ title: "Image regenerated" });
    } catch (err: any) {
      toast({ title: "Regenerate failed", description: humanizeError(err), variant: "destructive" });
    } finally {
      setRegenTarget(null);
    }
  };

  const handleExtractPreview = () => {
    if (!url) return;
    extractMutation.mutate({ url });
  };

  const handleGenerate = () => {
    if (sourceMode === "url") {
      if (!url || selectedPlatforms.length === 0) return;
      const pid = startProgress();
      repurposeFromUrl.mutate({
        url,
        progressId: pid,
        format,
        targetPlatforms: selectedPlatforms,
        provider,
        channelName: selectedChannelIds.length > 0
          ? activeChannels.find((c: any) => c.id === selectedChannelIds[0])?.name || "Channel"
          : primaryChannel?.name || "Channel",
        channelHandle: selectedChannelIds.length > 0
          ? activeChannels.find((c: any) => c.id === selectedChannelIds[0])?.username || ""
          : primaryChannel?.username || "",
        logoUrl: logoUrl || (() => {
          const ch = selectedChannelIds.length > 0
            ? activeChannels.find((c: any) => c.id === selectedChannelIds[0])
            : primaryChannel;
          return ch?.avatar || "";
        })(),
        creativeStyle,
        logoPosition,
        theme,
        accentColor: accentColor || undefined,
        aestheticRefUrl: aestheticRefUrl || undefined,
        // Strip bare URLs out of the free-text notes at send time so a URL pasted
        // into the NOTES box doesn't leak into the AI prompt as literal text.
        imageContext: stripBareUrls(imageContext) || undefined,
        // E4: when the user attached their own image (static only), send the
        // media ids so the router uses them and skips AI image generation.
        userMediaIds: useOwnImage ? userMedia.map((m) => m.id) : undefined,
        slideCount,
        videoDuration,
        // Seedance generates its own native audio, so the voiceOver/bgMusic
        // toggles are hidden for seedance_video — only reel & ai_video use them.
        voiceOver: (format === "reel" || format === "ai_video") ? voiceOver : false,
        voiceType: voiceType as any,
        bgMusic: (format === "reel" || format === "ai_video") ? bgMusic : false,
      });
    } else {
      if (!originalContent || selectedPlatforms.length === 0) return;
      repurpose.mutate({
        originalContent,
        targetPlatforms: selectedPlatforms,
        provider,
      });
    }
  };

  const isLoading = repurpose.isPending || repurposeFromUrl.isPending || videoGenerating;
  const { addTask, removeTask } = useActiveTask();

  // Track repurpose as active task while generating
  useEffect(() => {
    if (isLoading) {
      addTask({
        id: "repurpose-task",
        type: "repurpose",
        label: "Repurposing content",
        description: url ? url.slice(0, 50) : originalContent.slice(0, 50),
        href: "/dashboard/content-agent",
        createdAt: Date.now(),
      });
    } else {
      removeTask("repurpose-task");
    }
  }, [isLoading]);

  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platform) ? prev.filter((p) => p !== platform) : [...prev, platform]
    );
  };

  const copyContent = (platform: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedPlatform(platform);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopiedPlatform(null), 2000);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-purple-500" />
            Repurpose Content
          </CardTitle>
          <CardDescription>
            {sourceMode === "text"
              ? "Paste text to generate platform-optimised captions"
              : "Paste a URL to create social media posts, carousels, or reels"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Source Mode Tabs */}
          <Tabs value={sourceMode} onValueChange={(v) => setSourceMode(v as "url" | "text")}>
            <TabsList className="w-full">
              <TabsTrigger value="url" className="flex-1 gap-2">
                <Link2 className="h-4 w-4" />
                From URL
              </TabsTrigger>
              <TabsTrigger value="text" className="flex-1 gap-2">
                <FileText className="h-4 w-4" />
                From Text
              </TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="space-y-4 mt-4">
              <div className="space-y-1.5">
                <Label>URL</Label>
                <div className="flex gap-2">
                  <Input
                    type="url"
                    value={url}
                    onChange={(e) => { setUrl(e.target.value); setExtractedPreview(null); }}
                    placeholder="https://example.com/article, youtube.com/watch?v=..., x.com/post/..."
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    onClick={handleExtractPreview}
                    disabled={!url || extractMutation.isPending}
                  >
                    {extractMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
                    <span className="ml-1.5 hidden sm:inline">Preview</span>
                  </Button>
                </div>
              </div>

              {/* URL Preview */}
              {extractedPreview && (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                  <div className="flex items-start gap-3">
                    {extractedPreview.images?.[0] && (
                      <img src={extractedPreview.images[0]} alt="" className="h-16 w-16 rounded-md object-cover shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{extractedPreview.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{extractedPreview.description}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-[10px]">{extractedPreview.siteName}</Badge>
                        <Badge variant="secondary" className="text-[10px]">{extractedPreview.type}</Badge>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Output Format */}
              <div className="space-y-2">
                <Label>Output Format</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {FORMAT_OPTIONS.map(({ id, label, icon: Icon, desc, ...rest }) => (
                    <button
                      key={id}
                      disabled={(rest as any).disabled}
                      title={(rest as any).disabled ? "Temporarily unavailable (billing)" : undefined}
                      onClick={() => { if (!(rest as any).disabled) setFormat(id); }}
                      className={`relative flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all ${
                        format === id
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/50"
                      } ${(rest as any).disabled ? "opacity-40 cursor-not-allowed" : ""}`}
                    >
                      {"badge" in rest && (rest as any).badge && (
                        <span className="absolute -top-1.5 -right-1.5 rounded-full bg-gradient-to-r from-purple-600 to-pink-500 px-1.5 py-0.5 text-[9px] font-bold text-white shadow-sm">
                          {(rest as any).badge}
                        </span>
                      )}
                      <Icon className={`h-5 w-5 ${format === id ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="text-xs font-medium">{label}</span>
                      <span className="text-[10px] text-muted-foreground">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* E4: Attach your own image (STATIC only). When set, it becomes the
                  post media and the AI image generation is skipped — captions are
                  still generated. */}
              {format === "static" && (
                <div className="space-y-2">
                  <Label>Attach your own image (optional)</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      id="user-media-upload"
                      className="hidden"
                      onChange={async (e) => {
                        const files = Array.from(e.target.files ?? []);
                        e.target.value = "";
                        for (const file of files) {
                          if (userMedia.length >= 10) break;
                          const fd = new FormData();
                          fd.append("file", file);
                          const res = await fetch("/api/upload", { method: "POST", body: fd });
                          if (res.ok) {
                            const { id, url } = await res.json();
                            setUserMedia((prev) => (prev.length >= 10 ? prev : [...prev, { id, url }]));
                          } else {
                            toast({ title: "Image upload failed", variant: "destructive" });
                          }
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => document.getElementById("user-media-upload")?.click()}
                    >
                      {userMedia.length > 0 ? "Add another image" : "Upload your own image"}
                    </Button>
                    {userMedia.map((m, i) => (
                      <div key={m.id} className="relative">
                        <img src={m.url} alt="attached" className="h-12 w-12 rounded object-cover border" />
                        <button
                          type="button"
                          aria-label="Remove image"
                          onClick={() => setUserMedia((prev) => prev.filter((_, idx) => idx !== i))}
                          className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] text-white"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  {useOwnImage && (
                    <p className="text-[10px] text-muted-foreground">
                      Using your uploaded image — captions will still be generated. AI styling is skipped.
                    </p>
                  )}
                </div>
              )}

              {/* Creative style + brand reference (static + carousel cover).
                  Hidden when the user attached their own static image (no AI
                  image is generated, so the styling controls are irrelevant). */}
              {((format === "static" && !useOwnImage) || format === "carousel") && (
                <div className="space-y-2">
                  <Label>Creative Style</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: "premium_editorial", label: "Premium Editorial" },
                      { id: "hook_bars", label: "Hook + Headline" },
                      { id: "tweet_card", label: "Tweet / Post Card" },
                      { id: "bold_typographic", label: "Bold Typographic" },
                    ].map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setCreativeStyle(s.id as typeof creativeStyle)}
                        className={`rounded-lg border px-3 py-2 text-xs font-medium ${creativeStyle === s.id ? "border-primary bg-primary/10" : "border-border"}`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <Label className="pt-2 block">Brand Reference (optional)</Label>
                  {creativeTemplates && creativeTemplates.length > 0 && (
                    <Select
                      value={selectedTemplateId}
                      onValueChange={(id) => {
                        setSelectedTemplateId(id);
                        const t = creativeTemplates.find((x) => x.id === id);
                        if (t) {
                          setCreativeStyle(t.style as typeof creativeStyle);
                          setLogoPosition((t.logoPosition as "top-left" | "top-right") ?? "top-right");
                          setLogoUrl(t.logoMedia?.url ?? "");
                          setLogoMediaId(t.logoMediaId ?? "");
                          if (t.brandColor) setAccentColor(t.brandColor);
                        }
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Use a saved brand template…" /></SelectTrigger>
                      <SelectContent>
                        {creativeTemplates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      accept="image/*"
                      id="logo-upload"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        const fd = new FormData();
                        fd.append("file", file);
                        fd.append("category", "logo");
                        const res = await fetch("/api/upload", { method: "POST", body: fd });
                        if (res.ok) {
                          const { id, url } = await res.json();
                          setLogoUrl(url); setLogoMediaId(id);
                        } else {
                          toast({ title: "Logo upload failed", variant: "destructive" });
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById("logo-upload")?.click()}>
                      {logoUrl ? "Change logo" : "Upload logo"}
                    </Button>
                    {logoUrl && <img src={logoUrl} alt="logo" className="h-8 w-8 rounded object-contain border" />}
                    <Select value={logoPosition} onValueChange={(v) => setLogoPosition(v as "top-left" | "top-right")}>
                      <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="top-right">Logo top-right</SelectItem>
                        <SelectItem value="top-left">Logo top-left</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Brand accent color (optional) */}
                  <div className="flex items-center gap-2 pt-1">
                    <Label className="text-xs" htmlFor="accent-color">Brand color (optional)</Label>
                    <input
                      id="accent-color"
                      type="color"
                      value={accentColor || "#0052cc"}
                      onChange={(e) => setAccentColor(e.target.value)}
                      className="h-8 w-10 cursor-pointer rounded border border-border bg-background p-0.5"
                    />
                    <Input
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      placeholder="#0052cc"
                      className="h-8 w-28 text-xs"
                    />
                    {accentColor && (
                      <button
                        type="button"
                        onClick={() => setAccentColor("")}
                        className="text-[10px] text-muted-foreground hover:underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {/* E1: aesthetic/style reference image (optional) — the AI mimics its look (Gemini-only) */}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="file"
                      accept="image/*"
                      id="aesthetic-ref-upload"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        const fd = new FormData();
                        fd.append("file", file);
                        fd.append("category", "aesthetic-ref");
                        const res = await fetch("/api/upload", { method: "POST", body: fd });
                        if (res.ok) {
                          const { url } = await res.json();
                          setAestheticRefUrl(url);
                        } else {
                          toast({ title: "Style reference upload failed", variant: "destructive" });
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById("aesthetic-ref-upload")?.click()}>
                      {aestheticRefUrl ? "Change style reference" : "Style reference (optional)"}
                    </Button>
                    {aestheticRefUrl && (
                      <>
                        <img src={aestheticRefUrl} alt="style reference" className="h-8 w-8 rounded object-cover border" />
                        <button
                          type="button"
                          onClick={() => setAestheticRefUrl("")}
                          className="text-[10px] text-muted-foreground hover:underline"
                        >
                          Clear
                        </button>
                      </>
                    )}
                  </div>

                  {/* T7: paste an image OR a post/page URL — the backend extracts
                      the og:image for page links. Last-write-wins with the file
                      uploader above (both populate aestheticRefUrl). */}
                  <div className="space-y-1">
                    <Input
                      type="url"
                      value={aestheticRefUrl}
                      onChange={(e) => setAestheticRefUrl(e.target.value)}
                      placeholder="or paste an image / post URL"
                      className="h-8 text-xs"
                    />
                    {looksLikePostUrl(aestheticRefUrl) && (
                      <p className="text-[10px] text-muted-foreground">We&apos;ll grab the post&apos;s main image automatically. It guides the background&apos;s look &amp; mood (not the layout or text) — the activity log shows whether it was applied.</p>
                    )}
                  </div>

                  {/* E3a: free-text aesthetic / style notes (optional, max 300 chars) */}
                  <div className="space-y-1 pt-1">
                    <Label className="text-xs" htmlFor="image-context">Aesthetic / style notes (optional)</Label>
                    <Textarea
                      id="image-context"
                      value={imageContext}
                      maxLength={300}
                      onChange={(e) => setImageContext(e.target.value.slice(0, 300))}
                      placeholder="e.g. neon and moody, 35mm film grain, warm tones — or wording, e.g. 'mention Doordarshan in the hook'"
                      className="min-h-[60px] text-xs"
                    />
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[10px] text-muted-foreground">
                        Guides the background image AND the hook/headline wording. Highlighted words always use your brand color above.
                      </p>
                      <p className="text-[10px] text-muted-foreground shrink-0">{imageContext.length}/300</p>
                    </div>
                  </div>

                  {logoUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const name = window.prompt("Name this brand template:");
                        if (!name) return;
                        await createTemplate.mutateAsync({
                          name,
                          style: creativeStyle,
                          logoMediaId: logoMediaId || undefined,
                          logoPosition,
                        });
                        utils.creativeTemplate.list.invalidate();
                        toast({ title: "Brand template saved" });
                      }}
                    >
                      Save as template
                    </Button>
                  )}
                </div>
              )}

              {/* Total slides count (carousel only) — E2/T6: this number now means
                  TOTAL slides (cover + content + follow-for-more), not just content. */}
              {format === "carousel" && (
                <div className="space-y-2">
                  <Label>Total slides</Label>
                  <div className="flex gap-2">
                    {[3, 5, 7, 10].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setSlideCount(n)}
                        className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                          slideCount === n ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">Includes a cover slide and a follow-for-more slide.</p>
                </div>
              )}

              {/* Theme (static + carousel + slide-based video formats). Hidden
                  for an own-image static post — theme only styles the AI image. */}
              {((format === "static" && !useOwnImage) || format === "carousel" || format === "reel" || format === "ai_video") && (
                <div className="space-y-2">
                  <Label>{format === "static" ? "Background Theme" : "Slide Theme"}</Label>
                  <div className="flex gap-2">
                    {THEMES.map(({ id, label, color }) => (
                      <button
                        key={id}
                        onClick={() => setTheme(id)}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                          theme === id ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50"
                        }`}
                      >
                        <div className={`h-4 w-4 rounded-full ${color}`} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Veo3 AI Video info */}
              {format === "ai_video" && (
                <div className="rounded-lg border border-purple-300 bg-purple-50/50 p-3 dark:border-purple-800 dark:bg-purple-950/30">
                  <p className="text-xs font-semibold text-purple-700 dark:text-purple-300">🎬 Veo3 Ultra — AI-Generated Cinematic Video</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Generates a real AI video with text slides, relevant background visuals, smooth transitions, and background music.
                    Each key point becomes a scene with cinematic B-roll footage. Takes 1-3 minutes to generate.
                  </p>
                </div>
              )}

              {/* D7a: Seedance AI-video duration selector (seconds, 2–12) */}
              {format === "seedance_video" && (
                <div className="space-y-2">
                  <Label>Video length</Label>
                  <div className="flex gap-2">
                    {[4, 6, 8, 10, 12].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setVideoDuration(n)}
                        className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                          videoDuration === n ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50"
                        }`}
                      >
                        {n}s
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">Longer videos take longer and cost more.</p>
                </div>
              )}

              {/* D-ADD4: Seedance generates its own native audio — the voiceOver/
                  bgMusic toggles are hidden for it; show a one-line note instead. */}
              {format === "seedance_video" && (
                <p className="text-[11px] text-muted-foreground">Seedance generates its own audio.</p>
              )}

              {/* Voice-over & Music (Reel & AI Video only — not Seedance) */}
              {(format === "reel" || format === "ai_video") && (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Reel Audio</p>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Mic className="h-4 w-4 text-purple-500" />
                      <div>
                        <p className="text-sm font-medium">Voice-Over</p>
                        <p className="text-[10px] text-muted-foreground">AI narration of the article</p>
                      </div>
                    </div>
                    <Switch checked={voiceOver} onCheckedChange={setVoiceOver} />
                  </div>

                  {voiceOver && (
                    <div className="ml-6 space-y-1.5">
                      <Label className="text-xs">Voice</Label>
                      <Select value={voiceType} onValueChange={setVoiceType}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="nova">Nova (Female, warm)</SelectItem>
                          <SelectItem value="shimmer">Shimmer (Female, expressive)</SelectItem>
                          <SelectItem value="alloy">Alloy (Neutral)</SelectItem>
                          <SelectItem value="echo">Echo (Male, deep)</SelectItem>
                          <SelectItem value="fable">Fable (Male, British)</SelectItem>
                          <SelectItem value="onyx">Onyx (Male, authoritative)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Music className="h-4 w-4 text-blue-500" />
                      <div>
                        <p className="text-sm font-medium">Background Music</p>
                        <p className="text-[10px] text-muted-foreground">Subtle news-style ambient tone</p>
                      </div>
                    </div>
                    <Switch checked={bgMusic} onCheckedChange={setBgMusic} />
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="text" className="space-y-4 mt-4">
              <div className="space-y-1.5">
                <Label>Source Content</Label>
                <Textarea
                  value={originalContent}
                  onChange={(e) => setOriginalContent(e.target.value)}
                  placeholder="Paste your blog post, article, newsletter, or any content here..."
                  className="min-h-[200px] resize-y"
                />
                <p className="text-xs text-muted-foreground">{originalContent.length} characters</p>
              </div>
            </TabsContent>
          </Tabs>

          {/* Target Platforms */}
          <div className="space-y-2">
            <Label>Target Platforms</Label>
            <div className="flex flex-wrap gap-2">
              {ALL_PLATFORMS.map((platform) => (
                <button
                  key={platform}
                  onClick={() => togglePlatform(platform)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    selectedPlatforms.includes(platform)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  {platform.charAt(0) + platform.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedPlatforms.length} platform{selectedPlatforms.length !== 1 ? "s" : ""} selected
            </p>
          </div>

          {/* Publish to Channels */}
          {activeChannels.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Publish to Channels</Label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedChannelIds(
                      selectedChannelIds.length === activeChannels.length ? [] : activeChannels.map((c: any) => c.id)
                    )}
                    className="text-[10px] text-primary hover:underline"
                  >
                    {selectedChannelIds.length === activeChannels.length ? "Deselect All" : "Select All"}
                  </button>
                </div>
              </div>
              {activeChannels.length > 5 && (
                <Input
                  placeholder="Search channels..."
                  value={channelSearch}
                  onChange={(e) => setChannelSearch(e.target.value)}
                  className="h-8 text-xs"
                />
              )}
              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                {filteredChannels.map((channel: any) => (
                  <button
                    key={channel.id}
                    onClick={() => setSelectedChannelIds((prev) =>
                      prev.includes(channel.id) ? prev.filter((id) => id !== channel.id) : [...prev, channel.id]
                    )}
                    className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                      selectedChannelIds.includes(channel.id)
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    {channel.avatar && (
                      <img src={channel.avatar} alt="" className="h-4 w-4 rounded-full object-cover" />
                    )}
                    <span>{channel.name}</span>
                    <Badge variant="secondary" className="text-[9px] px-1 py-0">
                      {channel.platform.charAt(0) + channel.platform.slice(1).toLowerCase()}
                    </Badge>
                  </button>
                ))}
                {filteredChannels.length === 0 && channelSearch && (
                  <p className="text-xs text-muted-foreground py-2">No channels match "{channelSearch}"</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {selectedChannelIds.length} channel{selectedChannelIds.length !== 1 ? "s" : ""} selected for publishing
              </p>
            </div>
          )}

          {/* AI Provider */}
          <div className="w-48 space-y-1.5">
            <Label>AI Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as typeof providers[number])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI (GPT-4)</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="gemini">Google (Gemini)</SelectItem>
                <SelectItem value="grok">xAI (Grok)</SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
                <SelectItem value="gemma4">Google (Gemma 4)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Generate Button */}
          <Button
            onClick={handleGenerate}
            disabled={
              (sourceMode === "url" ? !url : !originalContent) ||
              selectedPlatforms.length === 0 ||
              isLoading
            }
            className="w-full gap-2"
            size="lg"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {isLoading
              ? sourceMode === "text"
                ? "Generating captions..."
                : `Generating ${format === "carousel" ? "carousel" : format === "reel" ? "reel" : format === "ai_video" ? "AI video with Veo3 (1-3 min)" : format === "seedance_video" ? "AI video with Seedance 2.0 (30s-3 min)" : "post"}...`
              : sourceMode === "text"
                ? "Generate Captions"
                : `Repurpose as ${FORMAT_OPTIONS.find((f) => f.id === format)?.label || "Static Post"}`}
          </Button>
        </CardContent>
      </Card>

      {/* Activity Log */}
      {progressSteps.length > 0 && (
        <Card className="border-zinc-200 dark:border-zinc-800">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              Activity Log
              {isLoading && <Loader2 className="h-3 w-3 animate-spin ml-auto text-muted-foreground" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <div className="space-y-1.5">
              {progressSteps.map((s, i) => (
                <div key={`${s.step}-${i}`} className="flex items-start gap-2 text-xs">
                  {s.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500 mt-0.5 shrink-0" />}
                  {s.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />}
                  {s.status === "error" && <XCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />}
                  {s.status === "skipped" && <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 mt-0.5 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <span className={s.status === "error" ? "text-red-600 dark:text-red-400" : s.status === "skipped" ? "text-yellow-600 dark:text-yellow-400" : "text-foreground"}>
                      {s.step}
                    </span>
                    {s.detail && (
                      <span className="text-muted-foreground ml-1.5">— {s.detail}</span>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                    {new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-4">
          {/* Extracted Article Summary */}
          {results.extracted && (
            <Card className="border-blue-200 bg-blue-50/30 dark:border-blue-900 dark:bg-blue-950/20">
              <CardContent className="pt-4">
                <div className="flex items-start gap-4">
                  {results.extracted.images?.[0] && (
                    <img src={results.extracted.images[0]} alt="" className="h-20 w-20 rounded-lg object-cover shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-sm leading-tight">{results.extracted.title}</h3>
                    {results.extracted.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{results.extracted.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="outline" className="text-[10px]">{results.extracted.siteName}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{results.extracted.type}</Badge>
                      <a href={results.extracted.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-500 hover:underline flex items-center gap-0.5">
                        <ExternalLink className="h-2.5 w-2.5" /> Source
                      </a>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Media-generation failure notice (Fix 4): captions exist but the
              image/video could not be produced. Never silently show nothing. */}
          {results.mediaFailed && results.mediaUrls.length === 0 && (
            <Card className="border-destructive/50 bg-destructive/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  {results.format === "reel" || results.format === "ai_video" || results.format === "seedance_video" ? "Video" : results.format === "carousel" ? "Carousel" : "Image"} could not be generated
                </CardTitle>
                <CardDescription>
                  Your captions are ready below, but the {results.format === "reel" || results.format === "ai_video" || results.format === "seedance_video" ? "video" : "image"} generation failed. Check the activity log above for the exact provider error (commonly an AI image/video provider key or billing issue). You can still copy the captions and add your own media.
                </CardDescription>
              </CardHeader>
            </Card>
          )}

          {/* Generated Media Preview */}
          {results.mediaUrls.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {results.format === "ai_video" || results.format === "seedance_video" ? <Video className="h-4 w-4 text-purple-500" /> : results.format === "reel" ? <Film className="h-4 w-4 text-purple-500" /> : results.mediaUrls.length > 1 ? <Layers className="h-4 w-4 text-blue-500" /> : <Image className="h-4 w-4 text-green-500" />}
                  Generated {results.format === "ai_video" ? "AI Video (Veo3)" : results.format === "seedance_video" ? "AI Video (Seedance 2.0)" : results.format === "reel" ? "Reel Video" : results.mediaUrls.length > 1 ? `Carousel (${results.mediaUrls.length} slides)` : "Static Post"}
                </CardTitle>
                <CardDescription>
                  {results.format === "ai_video" ? "Cinematic AI video with text slides, visuals & music by Veo3" : results.format === "seedance_video" ? "Cinematic 2K video with native audio by Seedance 2.0" : results.format === "reel" ? "AI-generated video with slides" : results.format === "static" ? "AI-generated background with branded overlay" : "Swipe through carousel slides"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {(results.mediaType === "video/mp4" || results.format === "ai_video" || results.format === "seedance_video") && results.mediaUrls[0] ? (
                  <div className="flex flex-col items-center gap-3">
                    <video
                      src={results.mediaUrls[0]}
                      controls
                      className="w-full max-w-xs rounded-xl shadow-lg aspect-[4/5]"
                      poster={undefined}
                    />
                    <a
                      href={results.mediaUrls[0]}
                      download={`repurposed-video-${Date.now()}.mp4`}
                      className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
                    >
                      <Download className="h-4 w-4" />
                      Download Video
                    </a>
                  </div>
                ) : results.mediaUrls.length === 1 ? (
                  <div className="flex flex-col items-center gap-3">
                    <img
                      src={results.mediaUrls[0]}
                      alt="Generated post"
                      className="w-full max-w-xs rounded-xl shadow-lg"
                    />
                    <div className="flex items-center gap-2">
                      <a
                        href={results.mediaUrls[0]}
                        download={`repurposed-image-${Date.now()}.png`}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
                      >
                        <Download className="h-4 w-4" />
                        Download Image
                      </a>
                      {/* E3b: re-roll just this image (plan-gated server-side). */}
                      <button
                        type="button"
                        onClick={() => handleRegenerate("static")}
                        disabled={regenTarget !== null}
                        title="Generate a new version of this image"
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-60"
                      >
                        {regenTarget === "static" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Regenerate
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex gap-3 overflow-x-auto pb-3 snap-x snap-mandatory">
                      {results.mediaUrls.map((mediaUrl, i) => (
                        <div key={i} className="shrink-0 snap-center">
                          <div className="relative group">
                            <img
                              src={mediaUrl}
                              alt={`Slide ${i + 1}`}
                              className="h-72 rounded-xl shadow-md aspect-[4/5] object-cover"
                            />
                            <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                              {i + 1}/{results.mediaUrls.length}
                            </div>
                            <a
                              href={mediaUrl}
                              download={`slide-${i + 1}-${Date.now()}.png`}
                              className="absolute bottom-2 right-2 rounded-full bg-black/60 p-2 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </a>
                            {/* E3b: re-roll the carousel COVER (slide 0) image only. */}
                            {i === 0 && (
                              <button
                                type="button"
                                onClick={() => handleRegenerate(0)}
                                disabled={regenTarget !== null}
                                title="Generate a new cover image"
                                className="absolute bottom-2 left-2 rounded-full bg-black/60 p-2 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 disabled:opacity-100"
                              >
                                {regenTarget === 0 ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3.5 w-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-center">
                      <button
                        onClick={() => {
                          results.mediaUrls.forEach((url, i) => {
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `slide-${i + 1}.png`;
                            a.click();
                          });
                        }}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
                      >
                        <Download className="h-4 w-4" />
                        Download All Slides
                      </button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Platform Captions with Unique Creatives */}
          <h2 className="text-lg font-semibold">Platform Creatives & Captions</h2>
          <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
            {Object.entries(results.platformContent).map(([platform, content]) => {
              const platformMedia = results.mediaMap?.[platform];
              const platformImage = platformMedia?.url || results.mediaUrls[0];
              const platformMediaId = platformMedia?.mediaId;
              return (
                <Card key={platform} className="border-green-200 bg-green-50/30 dark:border-green-900 dark:bg-green-950/20 overflow-hidden">
                  {/* Platform-specific AI creative preview */}
                  {platformImage && results.format === "static" && (
                    <div className="relative group">
                      <img
                        src={platformImage}
                        alt={`${platform} creative`}
                        className="w-full aspect-[4/5] object-cover"
                      />
                      <div className="absolute top-2 left-2">
                        <Badge className="bg-black/60 text-white border-0 text-[10px]">
                          {platform.charAt(0) + platform.slice(1).toLowerCase()}
                        </Badge>
                      </div>
                      <a
                        href={platformImage}
                        download={`${platform.toLowerCase()}-creative-${Date.now()}.png`}
                        className="absolute bottom-2 right-2 rounded-full bg-black/60 p-2.5 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                      >
                        <Download className="h-4 w-4" />
                      </a>
                    </div>
                  )}
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">
                        {platform.charAt(0) + platform.slice(1).toLowerCase()}
                      </CardTitle>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className="text-[10px]">{content.length} chars</Badge>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => copyContent(platform, content)}>
                          {copiedPlatform === platform ? (
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="whitespace-pre-wrap rounded-lg bg-background p-3 text-sm leading-relaxed max-h-40 overflow-y-auto">{content}</div>
                    <div className="mt-2 flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-xs"
                        onClick={() => {
                          // Carousel must forward ALL slide media ids (not just slide 0) so
                          // Compose attaches every slide and the carousel publish path triggers.
                          const query = buildCreatePostQuery({
                            format: results.format,
                            content,
                            image: platformImage,
                            mediaId: platformMediaId,
                            carouselMediaIds: results.carouselMediaIds,
                            carouselImages: results.mediaUrls,
                          });
                          window.location.href = `/dashboard/content-agent?${query}`;
                        }}
                      >
                        <FileText className="h-3 w-3" />
                        Create Post
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Publish to Selected Channels — or save a channel-less draft */}
          <div className="flex flex-col items-center gap-3">
            {selectedChannelIds.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No channels selected — you can still save this as a draft and pick channels later in Posts
              </p>
            )}
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="gap-2"
                disabled={publishingState === "publishing"}
                onClick={async () => {
                  setPublishingState("publishing");
                  try {
                    // Build content variants per platform
                    const contentVariants: Record<string, string> = {};
                    for (const [platform, content] of Object.entries(results.platformContent)) {
                      contentVariants[platform] = content as string;
                    }

                    // Get first platform's content as default
                    const defaultContent = Object.values(results.platformContent)[0] as string || "";

                    // Collect all media IDs
                    const mediaIds: string[] = [];
                    if (results.carouselMediaIds && results.carouselMediaIds.length > 0) {
                      mediaIds.push(...results.carouselMediaIds);
                    } else if (results.mediaMap) {
                      const seen = new Set<string>();
                      for (const m of Object.values(results.mediaMap)) {
                        if (m.mediaId && !seen.has(m.mediaId)) {
                          mediaIds.push(m.mediaId);
                          seen.add(m.mediaId);
                        }
                      }
                    }

                    await createPost.mutateAsync({
                      content: defaultContent,
                      contentVariants,
                      channelIds: selectedChannelIds,
                      mediaIds,
                      aiGenerated: true,
                      aiProvider: provider,
                    });

                    setPublishingState("done");
                    toast({
                      title: selectedChannelIds.length === 0 ? "Draft saved!" : "Draft posts created!",
                      description:
                        selectedChannelIds.length === 0
                          ? "Saved without channels — open it in Posts to add channels and publish."
                          : `${selectedChannelIds.length} draft post${selectedChannelIds.length > 1 ? "s" : ""} created. Go to Posts to review & schedule.`,
                    });
                  } catch {
                    setPublishingState("idle");
                  }
                }}
              >
                {publishingState === "publishing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : publishingState === "done" ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                {publishingState === "done"
                  ? selectedChannelIds.length === 0 ? "Draft Saved" : "Drafts Created"
                  : selectedChannelIds.length === 0
                    ? "Save as Draft"
                    : `Create Drafts (${selectedChannelIds.length} channel${selectedChannelIds.length !== 1 ? "s" : ""})`}
              </Button>

              {publishingState === "done" && (
                <Button
                  variant="default"
                  className="gap-2"
                  onClick={() => window.location.href = "/dashboard/posts"}
                >
                  <ArrowRight className="h-4 w-4" />
                  View Posts
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
