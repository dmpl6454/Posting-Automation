"use client";

import { humanizeError } from "~/lib/errors";
import { withNormalizedVideoMime } from "~/lib/video-mime";
import { withPosterHint } from "~/lib/video-poster";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useActiveTask } from "~/lib/active-task";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { DateTimePicker } from "~/components/ui/datetime-picker";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import { Switch } from "~/components/ui/switch";
import { useToast } from "~/hooks/use-toast";
import {
  Sparkles,
  Send,
  Clock,
  Loader2,
  Save,
  AlertCircle,
  Eye,
  ImagePlus,
  X,
  Paintbrush,
  Upload,
  FolderOpen,
  Search,
  Check,
  Video,
  Film,
  LayoutGrid,
} from "lucide-react";
import dynamic from "next/dynamic";
import { PostPreviewSwitcher } from "~/components/previews";
import { MediaPickerDialog } from "~/components/media-picker-dialog";
import { ImageGenerationPanel } from "~/components/content-agent/ImageGenerationPanel";
import { ChannelAvatar } from "~/components/channel-avatar";

const MediaEditor = dynamic(
  () => import("~/components/media-editor/MediaEditor").then((m) => ({ default: m.MediaEditor })),
  { ssr: false }
);

interface ComposeTabProps {
  initialContent?: string;
  initialImage?: string;
  initialImageMediaId?: string;
  /**
   * Multiple pre-uploaded media ids (in order) to pre-attach — used by the
   * Repurpose carousel "Create Post" deep link so ALL slides attach, not just
   * the cover. Each already has a Media DB row, so post-create uses the id
   * directly (no URL download needed). Takes precedence over initialImage.
   */
  initialMediaIds?: string[];
  /** Parallel slide preview URLs for initialMediaIds (same order). */
  initialMediaUrls?: string[];
  onPostCreated?: () => void;
  externalMediaToAdd?: { dataUrl: string } | null;
  onExternalMediaConsumed?: () => void;
  /**
   * Whether the compose tab is the ACTIVE tab. Under forceMount the component
   * stays mounted across tab switches, so the sessionStorage "Use in Post"
   * pickup keys off this instead of mount. Leave undefined where ComposeTab
   * is always visible — undefined behaves as active.
   */
  isActive?: boolean;
}

// Fix #24: sessionStorage key for carrying draft content from GenerateTab / ImageTab
const COMPOSE_DRAFT_KEY = "compose:draftContent";

// Shared video classifier for postMedia items — the media tile and the Post
// Preview `mediaKinds` MUST agree on what's a video: a video URL fed into an
// <img> makes WebKit ingest the ENTIRE blob into memory (+1.57GB measured for
// a 1.6GB camera file — see components/previews/preview-media.tsx).
const isVideoMediaItem = (m: { url: string; file?: File }) =>
  !!(m.file?.type.startsWith("video/") || m.url.includes("video") || /\.(mp4|webm|mov)/.test(m.url));
// Tiles for local videos above this size skip the inline metadata <video> —
// WebKit does GB-scale opportunistic read bursts on high-bitrate blobs.
const TILE_VIDEO_PREVIEW_MAX_BYTES = 256 * 1024 * 1024;

// Module-scope FIFO semaphore bounding CONCURRENT FILE uploads (spans the
// image + video pickers and survives re-renders). Each multipart upload
// already runs 4 parallel part-PUTs; without this, selecting 8 files starts
// 32 competing pipelines on one uplink and queued parts burn their 10-min
// timers on congestion. Cap 2: a stalled multi-GB video never fully blocks a
// quick image upload.
const MAX_CONCURRENT_FILE_UPLOADS = 2;
let activeFileUploads = 0;
const fileUploadWaiters: (() => void)[] = [];
async function acquireUploadSlot(signal?: AbortSignal): Promise<void> {
  while (activeFileUploads >= MAX_CONCURRENT_FILE_UPLOADS) {
    await new Promise<void>((resolve) => fileUploadWaiters.push(resolve));
    if (signal?.aborted) {
      // We consumed a wakeup meant to admit one waiter — pass it on.
      fileUploadWaiters.shift()?.();
      throw new Error("Upload aborted");
    }
  }
  activeFileUploads++;
}
function releaseUploadSlot(): void {
  activeFileUploads = Math.max(0, activeFileUploads - 1);
  fileUploadWaiters.shift()?.();
}

export function ComposeTab({ initialContent, initialImage, initialImageMediaId, initialMediaIds, initialMediaUrls, onPostCreated, externalMediaToAdd, onExternalMediaConsumed, isActive }: ComposeTabProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [content, setContent] = useState(initialContent || "");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  // PR-5: unique caption per channel (AI) — only meaningful with >1 channel.
  const [uniqueCaptions, setUniqueCaptions] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [postMedia, setPostMedia] = useState<{ url: string; mediaId?: string; file?: File; uploading?: boolean; progress?: number }[]>([]);
  // Aspect ratio of the first attached video (width/height). Null until measured.
  // Used to block non-vertical videos chosen as YouTube Shorts before publishing,
  // since YouTube only treats 9:16 vertical/square clips as Shorts and the worker
  // would otherwise reject a landscape Short after a slow upload.
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingImageIndex, setEditingImageIndex] = useState<number | null>(null);
  const [editorPreview, setEditorPreview] = useState<string | null>(null);
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [channelSearch, setChannelSearch] = useState("");
  const [channelDropdownOpen, setChannelDropdownOpen] = useState(false);
  const [formatByChannelId, setFormatByChannelId] = useState<Record<string, "FEED" | "REEL" | "STORY" | "SHORT" | "VIDEO" | "CAROUSEL">>({});
  const [ytMetadata, setYtMetadata] = useState<{ title?: string; privacyStatus?: "public" | "unlisted" | "private" }>({});
  const channelSectionRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const { addTask, removeTask, getTask } = useActiveTask();
  const TASK_ID = "compose-draft";

  // Fix #24: read draft content/image from sessionStorage (set by GenerateTab /
  // ImageTab "Use in Post"). Re-fires whenever the compose tab becomes ACTIVE —
  // with forceMount the component never remounts on tab switch, so a mount-only
  // effect would run once at page load (key absent) and the handoff would die.
  // The keys only exist right after a "Use in Post" click, so re-firing on
  // every activation is harmless; removeItem keeps a key from firing later.
  useEffect(() => {
    if (typeof window === "undefined" || isActive === false) return;
    if (!initialContent) {
      const draft = sessionStorage.getItem(COMPOSE_DRAFT_KEY);
      if (draft) {
        setContent(draft);
        sessionStorage.removeItem(COMPOSE_DRAFT_KEY);
      }
    }
    if (!initialImage) {
      const imgRaw = sessionStorage.getItem("compose:draftImage");
      if (imgRaw) {
        try {
          const img = JSON.parse(imgRaw) as { url: string; mediaId: string };
          setPostMedia((prev) => [...prev, { url: img.url, mediaId: img.mediaId }]);
        } catch {}
        sessionStorage.removeItem("compose:draftImage");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Close channel dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (channelSectionRef.current && !channelSectionRef.current.contains(e.target as Node)) {
        setChannelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Restore draft from active task. Hydration-aware: on a hard reload the
  // ActiveTaskProvider loads localStorage in a parent effect AFTER this child
  // mounts, so getTask() is empty on first run — getTask's identity changes
  // when the provider hydrates (useCallback on [tasks]), re-firing this effect.
  // restoredRef + empty-state guards prevent clobbering anything typed since.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || initialContent) return;
    const saved = getTask(TASK_ID);
    if (!saved?.draft) return;
    restoredRef.current = true;
    if (saved.draft.content && !content.trim()) setContent(saved.draft.content);
    if (saved.draft.channels?.length && selectedChannels.length === 0) {
      setSelectedChannels(saved.draft.channels);
    }
    // Restore attachments that are losslessly restorable (Media-row id or a
    // non-blob URL). Never resurrect blob: tiles (their File died with the old
    // page) and never pre-empt deep-link media (carousel/initialImage flow).
    const hasDeepLinkMedia = (initialMediaIds && initialMediaIds.length > 0) || !!initialImage;
    const media = (saved.draft.media ?? []).filter(
      (m) => m.mediaId || (m.url && !m.url.startsWith("blob:"))
    );
    if (!hasDeepLinkMedia && media.length > 0) {
      setPostMedia((prev) =>
        prev.length === 0 ? media.map(({ url, mediaId }) => ({ url, mediaId })) : prev
      );
      // Reconcile restored ids against the live library (best-effort, mirrors
      // the channel-id reconciliation above): a Media row deleted since the
      // draft was saved would otherwise fail the ENTIRE post.create at submit.
      // Stripping the id keeps the tile — resolvePostMediaIds re-resolves the
      // URL losslessly if the object still exists, else surfaces a clear
      // per-item error instead of an opaque whole-post rejection.
      const ids = media.map((m) => m.mediaId).filter((x): x is string => !!x);
      if (ids.length > 0) {
        void utils.media.verifyIds
          .fetch({ ids })
          .then(({ ownedIds }) => {
            const owned = new Set(ownedIds);
            if (ids.every((id) => owned.has(id))) return;
            setPostMedia((prev) =>
              prev.map((m) => (m.mediaId && !owned.has(m.mediaId) ? { ...m, mediaId: undefined } : m))
            );
          })
          .catch(() => {
            // Transient verify failure — keep the restored tiles untouched.
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getTask]);

  // Track compose as active task when content is being written.
  // Keyed on a signature of the PERSISTED fields (url + mediaId) — not the
  // postMedia array identity, which changes on every upload-progress tick.
  // The old [postMedia] dep made every tick do a synchronous localStorage
  // JSON write plus an ActiveTaskProvider re-render of the whole subtree,
  // several times per second for the duration of a video upload.
  const draftMediaSignature = useMemo(
    () => JSON.stringify(postMedia.map((m) => [m.url, m.mediaId ?? null])),
    [postMedia]
  );
  useEffect(() => {
    if (content.trim().length > 0 || selectedChannels.length > 0 || postMedia.length > 0) {
      addTask({
        id: TASK_ID,
        type: "compose",
        label: "Composing post",
        description: content.slice(0, 60) || "New post",
        href: "/dashboard/content-agent?tab=compose",
        draft: {
          content,
          channels: selectedChannels,
          mediaUrls: postMedia.map((m) => m.url),
          // Only losslessly-restorable items (library picks, AI images,
          // completed uploads) — blob-only tiles can't survive a remount.
          media: postMedia
            .filter((m) => m.mediaId || (m.url && !m.url.startsWith("blob:")))
            .map(({ url, mediaId }) => ({ url, mediaId })),
        },
        createdAt: getTask(TASK_ID)?.createdAt || Date.now(),
      });
    } else {
      removeTask(TASK_ID);
    }
    // postMedia is read in the body but deliberately keyed via its persisted
    // signature — see the comment above draftMediaSignature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, selectedChannels, draftMediaSignature]);

  useEffect(() => {
    if (initialContent) setContent(initialContent);
    // Carousel deep link: pre-attach ALL slide media ids (in order) so the post
    // attaches every slide. Each id already has a Media row, so post-create uses
    // the id directly; the parallel URL (if present) is only for the thumbnail.
    if (initialMediaIds && initialMediaIds.length > 0) {
      setPostMedia((prev) =>
        prev.length === 0
          ? initialMediaIds.map((mediaId, i) => ({ url: initialMediaUrls?.[i] || "", mediaId }))
          : prev
      );
    } else if (initialImage) {
      setPostMedia((prev) => (prev.length === 0 ? [{ url: initialImage, mediaId: initialImageMediaId }] : prev));
    }
  }, [initialContent, initialImage, initialMediaIds, initialMediaUrls]);

  useEffect(() => {
    if (!externalMediaToAdd) return;
    const { dataUrl } = externalMediaToAdd;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mimeType = match[1] ?? "image/png";
      const byteString = atob(match[2] ?? "");
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      const file = new File([ab], `ai-image-${Date.now()}.png`, { type: mimeType });
      const objectUrl = URL.createObjectURL(file);
      // Add without auto-uploading — media record is created only when the post is submitted
      setPostMedia((prev) => [...prev, { url: objectUrl, file }]);
    }
    onExternalMediaConsumed?.();
  }, [externalMediaToAdd]);

  const { data: channels, isLoading: channelsLoading } = trpc.channel.list.useQuery();
  const { data: recentlyUsedIds } = trpc.channel.recentlyUsed.useQuery();
  // Channel Groups (org-scoped) power the "Groups" quick-select block below.
  // Group selection state is always DERIVED from selectedChannels — never
  // persisted (draft persistence saves the flat channel id list only).
  const { data: channelGroups } = trpc.channelGroup.list.useQuery();
  const utils = trpc.useUtils();

  // Reconcile the selected channels against the live (org-scoped) channel list.
  // A restored draft or stale UI state can hold channel IDs that no longer exist
  // — e.g. a channel that was deleted, or disconnected+reconnected (which mints a
  // NEW id). Submitting those phantom IDs makes post.create reject the whole
  // request with "One or more channels do not belong to this organization."
  // Drop any selected ID that isn't in the current channel list so only real,
  // owned channels are ever submitted.
  useEffect(() => {
    if (!channels) return;
    const liveIds = new Set((channels as any[]).map((c) => c.id));
    setSelectedChannels((prev) => {
      const reconciled = prev.filter((id) => liveIds.has(id));
      return reconciled.length === prev.length ? prev : reconciled;
    });
  }, [channels]);

  // Measure the first attached video's aspect ratio so we can warn about
  // non-vertical Shorts before publishing.
  //
  // ⚠️ MUST stay keyed on the first video's URL STRING — never on the postMedia
  // array. Every whole-percent upload-progress tick rewrites postMedia with a
  // new identity; a [postMedia] dep re-ran this effect per tick, creating a
  // fresh detached <video> (a whole media player + metadata demux of the file)
  // several times per second for the entire upload. WebKit caps live media
  // players and frees them lazily, so a fast uplink exhausted the pool within
  // seconds and ballooned the tab until the OS killed it (confirmed on prod
  // nginx logs 2026-07-21: parts 200 OK, then all in-flight parts cut at the
  // moment the tab died). Same class of bug as the ActivityPanel SSE storm.
  const firstVideoUrl = useMemo(() => {
    const videoItem = postMedia.find((m) => {
      const t = m.file?.type ?? "";
      return t.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(m.url);
    });
    return videoItem?.url ?? null;
  }, [postMedia]);
  useEffect(() => {
    if (!firstVideoUrl) {
      setVideoAspect(null);
      return;
    }
    const el = document.createElement("video");
    el.preload = "metadata";
    // Full WebKit teardown: clearing the handler alone leaves the media
    // player alive until GC — removeAttribute + load() releases it now.
    // Released the moment metadata arrives (not just on unmount): an idle
    // media element bound to a high-bitrate blob triggers GB-scale
    // opportunistic read bursts in WebKit (measured 2026-07-21).
    const release = () => {
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute("src");
      el.load();
    };
    el.onloadedmetadata = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) {
        setVideoAspect(el.videoWidth / el.videoHeight);
      }
      release();
    };
    el.onerror = release;
    el.src = firstVideoUrl;
    return release;
  }, [firstVideoUrl]);

  // Warn before leaving while media is still uploading. Closing/refreshing the
  // tab mid-multipart-upload is unrecoverable: the in-flight parts are orphaned
  // on S3 (no abort fires) and no Media row exists yet. This guards accidental
  // navigation — it cannot (and shouldn't) block a real crash.
  // `isUploading` covers the submit-time path (resolvePostMediaIds re-uploads
  // items whose auto-upload failed) which never sets item-level flags.
  const anyUploading = isUploading || postMedia.some((m) => m.uploading);
  useEffect(() => {
    if (!anyUploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyUploading]);

  // iOS Safari never fires beforeunload and suspends the page on backgrounding
  // (XHRs stall; WebKit may jettison the tab). We can't prevent that — but on
  // return we can tell the user their upload may have been interrupted instead
  // of leaving a silently frozen tile. Coarse-pointer gate keeps desktop
  // tab-switching (where background XHRs continue fine) noise-free; the toast
  // renders on RETURN only (rendering is paused while hidden).
  const isTouchDevice =
    typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
  const hiddenAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!anyUploading || !isTouchDevice) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
      } else if (hiddenAtRef.current && Date.now() - hiddenAtRef.current > 10_000) {
        hiddenAtRef.current = null;
        toast({
          title: "Upload may have been interrupted",
          description:
            "The app was in the background for a while. Keep this screen open and awake until the upload finishes.",
          variant: "destructive",
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [anyUploading, isTouchDevice]);

  // Keep the screen awake while media uploads run — mobile auto-lock suspends
  // the page exactly like backgrounding (XHRs stall; iOS may jettison the tab,
  // orphaning multipart parts). Best-effort + additive: no-op where
  // unsupported, no permission prompt, and the OS auto-releases the sentinel
  // whenever the page hides — so re-acquire on return to visibility.
  useEffect(() => {
    if (!anyUploading || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: { release(): Promise<void> } | null = null;
    let disposed = false;
    const acquire = async () => {
      try {
        const s = await (
          navigator as unknown as {
            wakeLock: { request(t: "screen"): Promise<{ release(): Promise<void> }> };
          }
        ).wakeLock.request("screen");
        if (disposed) {
          // Effect cleaned up while the request was pending — don't leak it.
          s.release().catch(() => {});
          return;
        }
        sentinel = s;
      } catch {
        // Page hidden / battery saver / unsupported — ignore.
      }
    };
    void acquire();
    const onVis = () => {
      if (!disposed && document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVis);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [anyUploading]);

  const createPost = trpc.post.create.useMutation({
    onSuccess: (post: any) => {
      // PR-5: a unique-captions post is parked while the fanout worker writes
      // one caption per channel — say so instead of the generic toast.
      const fanoutCount = post?.metadata?.captionFanout?.requested ? (post?.targets?.length ?? 0) : 0;
      toast(
        fanoutCount > 0
          ? { title: "Post created!", description: `Generating ${fanoutCount} unique captions — publishing when ready.` }
          : { title: "Post created!", description: "Your post has been saved successfully." }
      );
      // Invalidate recently used cache so it refreshes
      utils.channel.recentlyUsed.invalidate();
      setContent("");
      setSelectedChannels([]);
      setScheduledAt("");
      setUniqueCaptions(false);
      setPostMedia([]);
      removeTask(TASK_ID);
      onPostCreated?.();
      // Open the post's detail page so the live upload/publish progress and final
      // status are visible immediately — instead of leaving the user on compose
      // with no indication of where the post went.
      if (post?.id) router.push(`/dashboard/posts/${post.id}`);
    },
    onError: (err) => {
      toast({ title: "Error", description: humanizeError(err), variant: "destructive" });
    },
  });
  const getUploadUrl = trpc.media.getUploadUrl.useMutation();
  const saveGeneratedImage = trpc.image.saveGenerated.useMutation();
  const generateAI = trpc.ai.generateContent.useMutation();
  const { data: aiConfig } = trpc.ai.getConfig.useQuery();
  const generateCarousel = trpc.post.generateCarousel.useMutation();
  // Multipart upload mutations — used by uploadFileToS3 below
  const uploadInitiate = trpc.upload.initiate.useMutation();
  const uploadSignPart = trpc.upload.signPart.useMutation();
  const uploadComplete = trpc.upload.complete.useMutation();
  const uploadAbort = trpc.upload.abort.useMutation();
  const [isGeneratingCarousel, setIsGeneratingCarousel] = useState(false);
  const [carouselSlideCount, setCarouselSlideCount] = useState(5);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isCreatingWithAI, setIsCreatingWithAI] = useState(false);

  const handleAIGenerate = async () => {
    if (!content) return;
    if (!aiConfig?.anyConfigured) {
      toast({
        title: "AI not configured",
        description: "No AI provider API key is set. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GEMINI_API_KEY to your environment.",
        variant: "destructive",
      });
      return;
    }
    setIsGenerating(true);
    // Pick the first available provider
    const provider = aiConfig.anthropic ? "anthropic" : aiConfig.openai ? "openai" : "gemini";
    try {
      const enhancePrompt = `ENHANCE the following social media post for better engagement. IMPORTANT RULES:
1. Do NOT change the core meaning or topic
2. Do NOT invent or fabricate any facts, names, movie titles, dates, prices, or statistics
3. If the content mentions specific items (movies, people, events), keep ONLY those that are factually correct
4. If the content asks about upcoming/latest/trending topics, the system will provide VERIFIED REAL-TIME DATA — use ONLY that data
5. Remove any information you cannot verify as factual
6. Improve writing quality, grammar, formatting, and add relevant hashtags
7. If the original content contains a list, only include items that are verified in the real-time data provided

Original post:
${content}`;
      const result = await generateAI.mutateAsync({ prompt: enhancePrompt, provider });
      setContent(result.content);
      toast({ title: "Content enhanced!", description: "AI verified and improved your content." });
    } catch {
      // Error toast is surfaced by the global mutationCacheOnError handler
      // (lib/trpc/react.tsx). Do NOT toast here too — it would double-toast.
    }
    setIsGenerating(false);
  };

  const handleCreateWithAI = async () => {
    if (!aiPrompt.trim()) return;
    if (!aiConfig?.anyConfigured) {
      toast({
        title: "AI not configured",
        description: "No AI provider API key is set. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GEMINI_API_KEY to your environment.",
        variant: "destructive",
      });
      return;
    }
    setIsCreatingWithAI(true);
    const provider = aiConfig.anthropic ? "anthropic" : aiConfig.openai ? "openai" : "gemini";
    try {
      const selectedPlatform = channels?.find((ch: any) => selectedChannels.includes(ch.id))?.platform as string | undefined;
      const result = await generateAI.mutateAsync({
        prompt: aiPrompt,
        provider,
        platform: selectedPlatform || undefined,
      });
      setContent(result.content);
      setAiPrompt("");
      toast({ title: "Content created!", description: "AI generated your post. You can edit it before publishing." });
    } catch {
      // Error toast is surfaced by the global mutationCacheOnError handler
      // (lib/trpc/react.tsx). Do NOT toast here too — it would double-toast.
    }
    setIsCreatingWithAI(false);
  };

  // Track carousel generation as active task
  useEffect(() => {
    if (isGeneratingCarousel) {
      addTask({
        id: "compose-carousel",
        type: "image",
        label: `Generating ${carouselSlideCount} carousel slides`,
        description: content.slice(0, 40) || "Carousel",
        href: "/dashboard/content-agent?tab=compose",
        createdAt: Date.now(),
      });
    } else {
      removeTask("compose-carousel");
    }
  }, [isGeneratingCarousel]);

  const handleGenerateCarousel = async () => {
    if (!content || content.trim().length < 10) {
      toast({ title: "Content too short", description: "Write some content first to generate carousel slides.", variant: "destructive" });
      return;
    }
    setIsGeneratingCarousel(true);
    // Find selected channel info for branding
    const selectedChannel = (channels as any[])?.find((c: any) => selectedChannels.includes(c.id));
    try {
      const result = await generateCarousel.mutateAsync({
        content,
        slideCount: carouselSlideCount,
        channelName: selectedChannel?.name || "",
        channelHandle: selectedChannel?.username || "",
        channelLogoUrl: selectedChannel?.avatar || undefined,
      });
      // Replace existing media with carousel slides
      setPostMedia(result.slides.map((s) => ({ url: s.url, mediaId: s.mediaId })));
      toast({
        title: "Carousel generated!",
        description: `${result.slideCount} slides created and ready to post.`,
      });
    } catch {
      // Error toast is surfaced by the global mutationCacheOnError handler
      // (lib/trpc/react.tsx). Do NOT toast here too — it would double-toast.
    }
    setIsGeneratingCarousel(false);
  };

  const handleOpenEditor = (imageIndex?: number) => {
    setEditingImageIndex(imageIndex ?? null);
    setEditorOpen(true);
  };

  const handleEditorApply = async (blobUrl: string) => {
    // Convert blob URL to File
    const resp = await fetch(blobUrl);
    const blob = await resp.blob();
    const file = new File([blob], `design-${Date.now()}.png`, { type: "image/png" });
    if (editingImageIndex !== null) {
      // The tile being replaced may still be auto-uploading — abort the OLD
      // transfer first (mirrors the X-button) or it completes headless into an
      // orphan Media row while its abort handle desyncs from the new url.
      const old = postMedia[editingImageIndex];
      if (old) uploadAbortsRef.current.get(old.url)?.abort();
      setPostMedia((prev) => prev.map((item, i) => (i === editingImageIndex ? { url: blobUrl, file, uploading: true } : item)));
    } else {
      setPostMedia((prev) => [...prev, { url: blobUrl, file, uploading: true }]);
    }
    startAutoUpload(file, blobUrl);
    setEditorOpen(false);
    setEditingImageIndex(null);
    setEditorPreview(null);
  };

  const handleEditorCancel = () => {
    setEditorOpen(false);
    setEditingImageIndex(null);
    setEditorPreview(null);
  };

  const startAutoUpload = (file: File, objectUrl: string) => {
    // One AbortController per in-flight tile, keyed by its preview objectUrl —
    // removing the tile aborts the transfer (frees the S3 multipart parts)
    // instead of leaving a ghost multi-GB upload running.
    const controller = new AbortController();
    uploadAbortsRef.current.set(objectUrl, controller);
    (async () => {
      await acquireUploadSlot(controller.signal);
      try {
        return await uploadFileToS3(file, objectUrl, controller.signal);
      } finally {
        releaseUploadSlot();
      }
    })()
      .then(({ id, url }) => {
        // Swap the tile/preview to the durable S3 URL once the Media row
        // exists: the blob: URL only lives as long as this page, previews
        // render local blobs as a placeholder (WebKit ingest guard), and a
        // restored draft can't resurrect a blob — the remote URL fixes all
        // three at once.
        setPostMedia((prev) =>
          prev.map((item) =>
            item.url === objectUrl ? { ...item, mediaId: id, url: url || item.url, uploading: false, progress: 100 } : item
          )
        );
        if (url && objectUrl.startsWith("blob:")) {
          // Deferred so the re-rendered <video> has committed its new src
          // before the blob backing the old src is released.
          setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return; // user removed the tile — silent
        toast({ title: "Upload failed", description: humanizeError(err), variant: "destructive" });
        setPostMedia((prev) =>
          prev.map((item) => (item.url === objectUrl ? { ...item, uploading: false } : item))
        );
      })
      .finally(() => {
        uploadAbortsRef.current.delete(objectUrl);
      });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) {
        // Windows/mobile pickers occasionally report an EMPTY type for odd
        // extensions — say so instead of silently dropping the file.
        toast({
          title: "File skipped",
          description: `"${file.name}" isn't a recognized image${file.type ? ` (${file.type})` : ""}. Use JPG, PNG, GIF, WebP or AVIF.`,
          variant: "destructive",
        });
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        toast({ title: "Image too large", description: "Images must be under 50MB.", variant: "destructive" });
        return;
      }
      const url = URL.createObjectURL(file);
      setPostMedia((prev) => [...prev, { url, file, uploading: true }]);
      startAutoUpload(file, url);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((rawFile) => {
      // Normalize patchy OS MIME reporting (empty type for .mov/.mp4 on
      // Windows, Apple's video/x-m4v alias) before the type gates — the
      // server allowlist keys on this type.
      const file = withNormalizedVideoMime(rawFile) ?? rawFile;
      if (!file.type.startsWith("video/")) {
        toast({
          title: "File skipped",
          description: `"${file.name}" isn't a recognized video${file.type ? ` (${file.type})` : ""}. Use MP4, MOV or WebM.`,
          variant: "destructive",
        });
        return;
      }
      if (file.size > 4 * 1024 * 1024 * 1024) {
        toast({ title: "Video too large", description: "Videos must be under 4GB.", variant: "destructive" });
        return;
      }
      const url = URL.createObjectURL(file);
      setPostMedia((prev) => [...prev, { url, file, uploading: true }]);
      startAutoUpload(file, url);
    });
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

  const handleMediaLibrarySelect = (url: string, _fileName: string, mediaId?: string) => {
    setPostMedia((prev) => [...prev, { url, mediaId }]);
    setShowMediaPicker(false);
  };

  // Abort controllers for in-flight tile uploads, keyed by preview objectUrl.
  const uploadAbortsRef = useRef(new Map<string, AbortController>());

  // On TRUE unmount (route navigation away — tab switches keep this mounted
  // via forceMount), abort every in-flight upload: the component state that
  // could ever attach the result is gone, so letting the transfer run headless
  // just wastes bandwidth and orphans parts. Drives the same abort path as the
  // tile X-button; aborts are toast-silent. StrictMode-safe: map is empty at
  // mount, so the dev double-invoke aborts nothing.
  useEffect(() => {
    const aborts = uploadAbortsRef.current;
    return () => {
      aborts.forEach((c) => c.abort());
    };
  }, []);

  const uploadFileToS3 = async (
    file: File,
    objectUrl?: string,
    signal?: AbortSignal
  ): Promise<{ id: string; url?: string }> => {
    // Small files (≤8MB) use the legacy single-shot endpoint — faster and no CORS prerequisite.
    // Larger files use direct-to-S3 multipart uploads (browser → S3) so we don't buffer
    // multi-GB videos in the Next.js process memory.
    const MULTIPART_THRESHOLD = 8 * 1024 * 1024;

    if (file.size <= MULTIPART_THRESHOLD) {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form, signal });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || "Upload failed");
      }
      const data = await res.json();
      return { id: data.id, url: data.url };
    }

    const { uploadFileMultipart } = await import("~/lib/upload-multipart");
    // Cap progress re-paints at ~4/s. The multipart engine already reports
    // whole-percent changes only, but on a fast uplink a mid-size video
    // crosses 10+ percent boundaries per second — and every setPostMedia
    // re-renders the entire compose tree. 100% always paints (completion).
    let lastProgressPaintAt = 0;
    const result = await uploadFileMultipart({
      file,
      signal,
      onProgress: (percent) => {
        if (!objectUrl) return;
        const now = Date.now();
        if (percent < 100 && now - lastProgressPaintAt < 250) return;
        lastProgressPaintAt = now;
        setPostMedia((prev) =>
          prev.map((item) => (item.url === objectUrl ? { ...item, progress: percent } : item))
        );
      },
      api: {
        initiate: (input) => uploadInitiate.mutateAsync(input),
        signPart: (input) => uploadSignPart.mutateAsync(input),
        complete: (input) => uploadComplete.mutateAsync(input),
        abort: (input) => uploadAbort.mutateAsync(input),
      },
    });
    return { id: result.id, url: result.url };
  };

  /**
   * Turn the current `postMedia` into the ordered mediaIds the post needs,
   * resolving EVERY item shape — and NEVER silently dropping one.
   *
   * Item shapes:
   *  - { mediaId }            → use it directly (already an org Media row)
   *  - { file }               → upload now → mediaId
   *  - { url } (no id, no file) → resolve to an existing org Media row by URL
   *      (lossless), else download+reupload as a last resort.
   *
   * Bug this fixes (live-repro'd on prod 2026-06-26): a Repurpose "Create Post"
   * deep link `?aiImage=<url>` that arrives WITHOUT `aiMediaId` hydrates a
   * url-only `postMedia` item. The old create handlers persisted only
   * `mediaId`/`file`, so the url-only item was SKIPPED → a post with no image
   * while the preview still showed it. We now resolve it; if an image item
   * genuinely can't be resolved we THROW so the caller blocks the create with a
   * clear toast instead of silently saving a media-less post.
   *
   * blob: object-URLs are local-only previews and are NEVER a resolvable source
   * on their own — such an item must also carry a `file` (it always does), so a
   * blob-without-file is treated as unresolvable.
   */
  const resolvePostMediaIds = async (): Promise<string[]> => {
    // First pass: collect url-only items (no mediaId, no file, non-blob) and
    // resolve them to existing org Media ids in ONE round-trip.
    const urlOnly = postMedia
      .filter((m) => !m.mediaId && !m.file && m.url && !m.url.startsWith("blob:"))
      .map((m) => m.url);
    let urlToId: Record<string, string> = {};
    if (urlOnly.length > 0) {
      try {
        const { map } = await utils.media.resolveByUrl.fetch({ urls: Array.from(new Set(urlOnly)) });
        urlToId = map;
      } catch {
        // resolver unavailable → fall through to per-item download+reupload below
      }
    }

    const mediaIds: string[] = [];
    const unresolved: string[] = [];
    for (const item of postMedia) {
      if (item.mediaId) {
        mediaIds.push(item.mediaId);
      } else if (item.file) {
        const { id } = await uploadFileToS3(item.file, item.url);
        // Persist the id so a later failure in this loop (or a createPost
        // error) doesn't force a full re-upload on retry — the retry then
        // takes the item.mediaId fast path above.
        setPostMedia((prev) => prev.map((m) => (m.url === item.url ? { ...m, mediaId: id } : m)));
        mediaIds.push(id);
      } else if (item.url && !item.url.startsWith("blob:")) {
        // Prefer the lossless resolve (existing org Media row for this URL)…
        const resolved = urlToId[item.url];
        if (resolved) {
          mediaIds.push(resolved);
          continue;
        }
        // …otherwise download the external URL and re-upload it. If THAT fails,
        // record it as unresolved (do NOT silently drop — the old bug).
        try {
          const resp = await fetch(item.url);
          if (!resp.ok) throw new Error(`fetch ${resp.status}`);
          const blob = await resp.blob();
          const ext = item.url.match(/\.(png|jpg|jpeg|webp|gif|mp4|webm|mov)(?:\?|$)/i)?.[1] || "jpg";
          const file = new File([blob], `compose-${Date.now()}.${ext}`, { type: blob.type || "image/jpeg" });
          mediaIds.push((await uploadFileToS3(file)).id);
        } catch {
          unresolved.push(item.url);
        }
      } else {
        // blob: with no file, or empty url — nothing we can persist.
        unresolved.push(item.url || "(unknown)");
      }
    }

    if (unresolved.length > 0) {
      throw new Error(
        `${unresolved.length} attached ${unresolved.length === 1 ? "image" : "images"} could not be saved. ` +
          `Please re-attach the image and try again.`,
      );
    }
    return mediaIds;
  };

  const handleSubmit = async (publishNow: boolean) => {
    if (!content || selectedChannels.length === 0) {
      toast({
        title: "Missing required fields",
        description: "Please add content and select at least one channel.",
        variant: "destructive",
      });
      return;
    }

    const stillUploading = postMedia.some((item) => item.uploading);
    if (stillUploading) {
      toast({ title: "Please wait", description: "Media is still uploading...", variant: "destructive" });
      return;
    }

    if (youtubeBlockReason) {
      toast({ title: "Cannot publish to YouTube", description: youtubeBlockReason, variant: "destructive" });
      return;
    }

    try {
      setIsUploading(true);
      // Resolve every attached media item to a real mediaId. Throws (and blocks
      // the create) if an attached image can't be saved — no silent media-less post.
      const mediaIds = await resolvePostMediaIds();

      createPost.mutate({
        content,
        channelIds: selectedChannels,
        // DateTimePicker emits a LOCAL "YYYY-MM-DDTHH:mm" string; the API's
        // z.string().datetime() requires full ISO — convert at the submit
        // boundary exactly like BulkTab and the post-detail page do. Sending
        // the raw picker value 400s every Compose "Schedule" click.
        scheduledAt: publishNow
          ? new Date().toISOString()
          : scheduledAt
            ? new Date(scheduledAt).toISOString()
            : undefined,
        // PR-5: only sent on the schedule/publish path (draft-save keeps it off).
        ...(uniqueCaptions && selectedChannels.length > 1 && { uniqueCaptions: true }),
        ...(mediaIds.length > 0 && { mediaIds }),
        ...(Object.keys(formatByChannelId).length > 0 && { formatByChannelId }),
        ...(Object.keys(ytMetadata).length > 0 && { metadata: ytMetadata }),
      });
    } catch (err: any) {
      toast({
        title: "Couldn't attach your image",
        description: humanizeError(err) || "Failed to save the attached image. Please re-attach and try again.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const charCount = content.length;

  const selectedPlatforms: string[] = channels
    ? channels
        .filter((ch: any) => selectedChannels.includes(ch.id))
        .map((ch: any) => (ch.platform as string).toLowerCase())
        .filter((p: string, i: number, arr: string[]) => arr.indexOf(p) === i)
    : [];

  // YouTube only accepts video uploads — gate the UI to prevent invalid combinations.
  const hasYouTube = selectedPlatforms.includes("youtube");
  const hasInstagram = selectedPlatforms.includes("instagram");
  const hasVideoAttached = postMedia.some((m) => {
    const t = m.file?.type ?? "";
    return t.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(m.url);
  });
  const hasImageAttached = postMedia.some((m) => {
    const t = m.file?.type ?? "";
    return t.startsWith("image/") || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(m.url);
  });
  // Is any selected YouTube channel set to publish as a Short?
  const youtubeShortSelected = (channels as any[] | undefined)?.some(
    (ch) => ch.platform === "YOUTUBE" && selectedChannels.includes(ch.id) && formatByChannelId[ch.id] === "SHORT"
  ) ?? false;
  // A Short must be vertical/square (height >= width). videoAspect = width/height,
  // so a Short requires aspect <= 1. Landscape (aspect > 1) can't become a Short.
  const shortNeedsVertical = youtubeShortSelected && hasVideoAttached && videoAspect !== null && videoAspect > 1;

  // Block publish if YouTube is selected with: (a) no video, (b) any image attached,
  // or (c) a non-vertical video chosen as a Short.
  const youtubeBlockReason = hasYouTube
    ? !hasVideoAttached
      ? "YouTube requires a video. Attach an MP4/WebM/MOV before publishing."
      : hasImageAttached
        ? "YouTube does not accept images. Remove image attachments before publishing."
        : shortNeedsVertical
          ? "This video is landscape — YouTube Shorts must be vertical (9:16). Switch the format to “Video”, or attach a vertical clip."
          : null
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="grid min-w-0 gap-6 xl:grid-cols-[1fr,400px]">
        {/* Left column - Editor */}
        <div className="min-w-0 space-y-6">
          {editorOpen ? (
            <MediaEditor
              initialImage={editingImageIndex !== null ? postMedia[editingImageIndex]?.url : undefined}
              onApply={handleEditorApply}
              onCancel={handleEditorCancel}
              onPreviewUpdate={setEditorPreview}
            />
          ) : (
          <>
          {/* Create Design Button */}
          <Button
            variant="outline"
            onClick={() => handleOpenEditor()}
            className="w-full gap-2"
          >
            <Paintbrush className="h-4 w-4" />
            Create Design
          </Button>

          {/* Create with AI */}
          <Card className="border-purple-200 bg-gradient-to-r from-purple-50/50 to-blue-50/50 dark:border-purple-900 dark:from-purple-950/20 dark:to-blue-950/20">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-500" />
                  <CardTitle className="text-base">Create with AI</CardTitle>
                </div>
                {aiConfig?.anyConfigured && (
                  <span className="text-[11px] text-muted-foreground">
                    via {aiConfig.anthropic ? "Claude" : aiConfig.openai ? "GPT-4" : "Gemini"}
                  </span>
                )}
              </div>
              <CardDescription>Describe what you want to post and AI will write it for you</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="e.g. Write a post about upcoming Marvel movies in 2026..."
                  className="min-w-0 flex-1 bg-background"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && aiPrompt.trim()) {
                      e.preventDefault();
                      handleCreateWithAI();
                    }
                  }}
                  disabled={isCreatingWithAI}
                />
                <Button
                  onClick={handleCreateWithAI}
                  disabled={!aiPrompt.trim() || isCreatingWithAI || !aiConfig?.anyConfigured}
                  className="shrink-0 gap-1.5 bg-purple-600 hover:bg-purple-700"
                  title={!aiConfig?.anyConfigured ? "No AI provider configured — add an API key to enable" : undefined}
                >
                  {isCreatingWithAI ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {isCreatingWithAI ? "Creating..." : "Generate"}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Content Editor */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Content</CardTitle>
                <div className="flex items-center gap-2">
                  {aiConfig?.anyConfigured && (
                    <span className="text-[11px] text-muted-foreground">
                      via {aiConfig.anthropic ? "Claude" : aiConfig.openai ? "GPT-4" : "Gemini"}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAIGenerate}
                    disabled={isGenerating || !content || !aiConfig?.anyConfigured}
                    className="gap-1.5"
                    title={!aiConfig?.anyConfigured ? "No AI provider configured — add an API key to enable" : undefined}
                  >
                    {isGenerating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className={`h-3.5 w-3.5 ${aiConfig?.anyConfigured ? "text-purple-500" : "text-muted-foreground"}`} />
                    )}
                    {isGenerating ? "Enhancing..." : "Enhance with AI"}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Write your post here, or use 'Create with AI' above to generate content..."
                className="min-h-[200px] resize-none"
              />
              <div className="flex items-center justify-end text-xs">
                <span className="tabular-nums text-muted-foreground">
                  {charCount} characters
                </span>
              </div>
            </CardContent>
          </Card>

          {/* AI Image Generation — link to Image tab */}
          {/* AI Image Generation */}
          <ImageGenerationPanel
            postContent={content}
            onAddToPost={async (imageDataUrl) => {
              // Upload the AI image to S3 immediately so we have a real mediaId
              const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
              if (!match) {
                toast({ title: "Invalid image format", variant: "destructive" });
                return;
              }
              const mimeType = match[1] ?? "image/png";
              const imageBase64 = match[2] ?? "";
              try {
                const result = await saveGeneratedImage.mutateAsync({
                  imageBase64,
                  mimeType,
                  fileName: `ai-image-${Date.now()}.png`,
                });
                setPostMedia((prev) => [...prev, { url: result.url, mediaId: result.id }]);
                toast({ title: "Image uploaded and added to post!" });
              } catch {
                // Fallback: add as file for upload at post time
                const byteString = atob(imageBase64);
                const ab = new ArrayBuffer(byteString.length);
                const ia = new Uint8Array(ab);
                for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                const file = new File([ab], `ai-image-${Date.now()}.png`, { type: mimeType });
                setPostMedia((prev) => [...prev, { url: imageDataUrl, file }]);
                toast({ title: "Image added to post", description: "Will upload when publishing." });
              }
            }}
          />

          {/* Media Attachments */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Media</CardTitle>
              <CardDescription>
                {hasYouTube ? "YouTube requires a video upload (MP4, WebM, or MOV)" : "Attach images or videos to your post"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {hasYouTube && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
                  <Video className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>
                    YouTube channel selected. Only video uploads are supported — images and text-only posts cannot be published to YouTube.
                  </span>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleFileUpload}
                />
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime"
                  className="hidden"
                  onChange={handleVideoUpload}
                />
                {!hasYouTube && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Image
                  </Button>
                )}
                <Button
                  variant={hasYouTube ? "default" : "outline"}
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => videoInputRef.current?.click()}
                >
                  <Video className="h-3.5 w-3.5" />
                  Video
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => setShowMediaPicker(true)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Library
                </Button>
              </div>
              {/* Generate Carousel — hidden when YouTube is the target since YT does not support image carousels */}
              {!hasYouTube && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5 border-dashed"
                  onClick={handleGenerateCarousel}
                  disabled={!content || isGeneratingCarousel}
                >
                  {isGeneratingCarousel ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Generating slides...
                    </>
                  ) : (
                    <>
                      <LayoutGrid className="h-3.5 w-3.5" />
                      Generate Carousel
                    </>
                  )}
                </Button>
                <select
                  value={carouselSlideCount}
                  onChange={(e) => setCarouselSlideCount(Number(e.target.value))}
                  disabled={isGeneratingCarousel}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  {[3, 4, 5, 6, 7, 8, 10].map((n) => (
                    <option key={n} value={n}>{n} slides</option>
                  ))}
                </select>
              </div>
              )}
              {anyUploading && isTouchDevice && (
                <p className="text-[11px] text-muted-foreground">
                  Keep this tab open — switching apps or locking the screen can interrupt the upload.
                </p>
              )}
              {postMedia.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {postMedia.map((item, idx) => {
                    const isVideo = isVideoMediaItem(item);
                    // No inline <video> for very large local files: even a
                    // metadata-only media element on a high-bitrate blob
                    // triggers GB-scale read bursts in WebKit. The Film-icon
                    // overlay below still marks the tile as a video.
                    const skipInlineVideo = !!item.file && item.file.size > TILE_VIDEO_PREVIEW_MAX_BYTES;
                    return (
                      <div key={idx} className="group relative flex-shrink-0">
                        {isVideo ? (
                          <div className="relative h-16 w-24 overflow-hidden rounded-md border bg-muted">
                            {!skipInlineVideo && (
                            <video
                              src={withPosterHint(item.url)}
                              className="h-full w-full object-cover"
                              muted
                              preload="metadata"
                            />
                            )}
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40">
                              {item.uploading ? (
                                <>
                                  <Loader2 className="h-5 w-5 animate-spin text-white drop-shadow" />
                                  {typeof item.progress === "number" && (
                                    <span className="text-[10px] font-medium text-white drop-shadow">{item.progress}%</span>
                                  )}
                                </>
                              ) : (
                                <Film className="h-6 w-6 text-white drop-shadow" />
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="relative h-16 w-16">
                            <img
                              src={item.url}
                              alt={`Attached ${idx + 1}`}
                              className="h-16 w-16 rounded-md border object-cover"
                            />
                            {item.uploading && (
                              <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/40">
                                <Loader2 className="h-4 w-4 animate-spin text-white" />
                              </div>
                            )}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            // Cancel any in-flight upload for this tile first.
                            uploadAbortsRef.current.get(item.url)?.abort();
                            setPostMedia((prev) => prev.filter((_, i) => i !== idx));
                          }}
                          className="absolute -right-1 -top-1 rounded-full bg-destructive p-1.5 [@media(hover:hover)]:p-0.5 text-destructive-foreground opacity-100 [@media(hover:hover)]:opacity-0 transition-opacity [@media(hover:hover)]:group-hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                        {!isVideo && (
                          <button
                            type="button"
                            onClick={() => handleOpenEditor(idx)}
                            className="absolute bottom-0 left-0 right-0 bg-black/50 py-0.5 text-center text-[10px] text-white opacity-100 [@media(hover:hover)]:opacity-0 transition-opacity [@media(hover:hover)]:group-hover:opacity-100"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Channel Selection — compact search & select */}
          <Card ref={channelSectionRef}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Select Channels</CardTitle>
                  <CardDescription>Search and pick channels to publish to</CardDescription>
                </div>
                {selectedChannels.length > 0 && (
                  <Badge variant="secondary">{selectedChannels.length} selected</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {channelsLoading ? (
                <div className="h-10 animate-pulse rounded-md border bg-muted" />
              ) : channels?.length === 0 ? (
                <div className="flex flex-col items-center rounded-lg border border-dashed p-6 text-center">
                  <AlertCircle className="mb-2 h-6 w-6 text-muted-foreground" />
                  <p className="text-sm font-medium">No channels connected</p>
                  <Button variant="outline" size="sm" className="mt-2" asChild>
                    <a href="/dashboard/channels">Connect Channel</a>
                  </Button>
                </div>
              ) : (
                <>
                  {/* Groups quick-select — pick a whole Channel Group as a unit.
                      Selection state is DERIVED from selectedChannels vs the
                      group's ACTIVE member ids (none / partial / all); it is
                      never stored, so draft persistence keeps saving the flat
                      channel id list. Inactive channels are excluded from the
                      union — they can't be published to. */}
                  {(() => {
                    // Only ever union ids that STILL exist in the live channel
                    // list — the channelGroup cache can lag a disconnect, and a
                    // stale id in selectedChannels would make post.create reject
                    // the whole request (foreign-channel FORBIDDEN).
                    const liveIds = new Set<string>(
                      ((channels as any[]) ?? []).map((c: any) => c.id as string)
                    );
                    const groupsWithActive = ((channelGroups as any[]) ?? [])
                      .map((group: any) => ({
                        ...group,
                        activeIds: ((group.channels ?? []) as any[])
                          .filter((c: any) => c.isActive && liveIds.has(c.id))
                          .map((c: any) => c.id as string),
                      }))
                      .filter((group: any) => group.activeIds.length > 0);
                    if (groupsWithActive.length === 0) return null;
                    return (
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Groups
                        </span>
                        {groupsWithActive.map((group: any) => {
                          const selectedCount = group.activeIds.filter((id: string) =>
                            selectedChannels.includes(id)
                          ).length;
                          const allSelected = selectedCount === group.activeIds.length;
                          const partial = selectedCount > 0 && !allSelected;
                          return (
                            <button
                              key={group.id}
                              type="button"
                              aria-pressed={allSelected}
                              aria-label={
                                allSelected
                                  ? `Deselect all ${group.activeIds.length} active channels in group ${group.name}`
                                  : `Select all ${group.activeIds.length} active channels in group ${group.name}`
                              }
                              onClick={() => {
                                if (allSelected) {
                                  // Remove the group's active member ids from the selection.
                                  const memberIds = new Set<string>(group.activeIds);
                                  setSelectedChannels((prev) => prev.filter((id) => !memberIds.has(id)));
                                } else {
                                  // Union the group's active member ids into the selection (deduped).
                                  setSelectedChannels((prev) => [
                                    ...new Set<string>([...prev, ...group.activeIds]),
                                  ]);
                                }
                              }}
                              className={`inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                                allSelected
                                  ? "border-primary bg-primary/10"
                                  : partial
                                    ? "border-primary/50 bg-primary/5"
                                    : "hover:bg-muted/50"
                              }`}
                            >
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ background: group.color }}
                              />
                              <span className="truncate">{group.name}</span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {partial
                                  ? `${selectedCount}/${group.activeIds.length}`
                                  : group.activeIds.length}
                              </span>
                              {allSelected && <Check className="h-3 w-3 shrink-0 text-primary" />}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* Selected channels as chips */}
                  {selectedChannels.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedChannels.map((id) => {
                        const ch = channels?.find((c: any) => c.id === id) as any;
                        if (!ch) return null;
                        return (
                          <span
                            key={id}
                            className="inline-flex items-center gap-1.5 rounded-full border bg-primary/5 px-2.5 py-1 text-xs font-medium"
                          >
                            <ChannelAvatar
                              avatar={ch.avatar}
                              name={ch.name}
                              className="h-4 w-4"
                              fallbackClassName="text-[8px]"
                            />
                            {ch.name}
                            <button
                              type="button"
                              onClick={() => setSelectedChannels(prev => prev.filter(i => i !== id))}
                              className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/10"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        );
                      })}
                      {selectedChannels.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setSelectedChannels([])}
                          className="text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                  )}

                  {/* Search input */}
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={channelSearch}
                      onChange={(e) => { setChannelSearch(e.target.value); setChannelDropdownOpen(true); }}
                      placeholder="Search channels by name, platform, or @handle..."
                      className="h-9 pl-8 text-sm"
                      onFocus={() => setChannelDropdownOpen(true)}
                      onClick={() => setChannelDropdownOpen(true)}
                    />
                  </div>

                  {/* Dropdown results — always visible when section is active */}
                  {(channelDropdownOpen || channels?.length) && (() => {
                    const recentSet = new Set(recentlyUsedIds || []);
                    const allFiltered = channels?.filter((channel: any) => {
                      const matchesSearch =
                        !channelSearch ||
                        channel.name.toLowerCase().includes(channelSearch.toLowerCase()) ||
                        channel.platform.toLowerCase().includes(channelSearch.toLowerCase()) ||
                        (channel.username || "").toLowerCase().includes(channelSearch.toLowerCase());
                      return matchesSearch;
                    }) || [];

                    // Sort: recently used first, then alphabetical
                    const sorted = [...allFiltered].sort((a: any, b: any) => {
                      const aRecent = recentSet.has(a.id) ? 0 : 1;
                      const bRecent = recentSet.has(b.id) ? 0 : 1;
                      if (aRecent !== bRecent) return aRecent - bRecent;
                      return a.name.localeCompare(b.name);
                    });

                    return (
                      <div className="max-h-48 overflow-y-auto rounded-md border bg-background shadow-sm">
                        {sorted.length === 0 ? (
                          <p className="p-3 text-center text-xs text-muted-foreground">No channels found</p>
                        ) : (
                          sorted.map((channel: any) => {
                            const isSelected = selectedChannels.includes(channel.id);
                            const isRecent = recentSet.has(channel.id);
                            return (
                              <button
                                key={channel.id}
                                type="button"
                                onClick={() => {
                                  if (isSelected) {
                                    setSelectedChannels(prev => prev.filter(i => i !== channel.id));
                                  } else {
                                    setSelectedChannels(prev => [...prev, channel.id]);
                                  }
                                }}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                                  isSelected ? "bg-primary/5" : ""
                                }`}
                              >
                                <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                  isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30"
                                }`}>
                                  {isSelected && <Check className="h-3 w-3" />}
                                </div>
                                <ChannelAvatar
                                  avatar={channel.avatar}
                                  name={channel.name}
                                  className="h-6 w-6 shrink-0"
                                  fallbackClassName="text-[9px]"
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium leading-tight">{channel.name}</p>
                                  {channel.username && (
                                    <p className="truncate text-xs leading-tight text-muted-foreground">@{channel.username}</p>
                                  )}
                                </div>
                                <Badge variant="outline" className="shrink-0 text-[9px]">{channel.platform}</Badge>
                                {isRecent && <Badge variant="secondary" className="shrink-0 text-[9px] px-1 py-0">Recent</Badge>}
                              </button>
                            );
                          })
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </CardContent>
          </Card>

          {/* Post Format — shown when YouTube or Instagram+video channels are selected */}
          {(hasYouTube && hasVideoAttached) || (hasInstagram && hasVideoAttached) ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Post Format</CardTitle>
                <CardDescription>Choose how this video will be posted per platform</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {channels?.filter((ch: any) => selectedChannels.includes(ch.id) && ["YOUTUBE", "INSTAGRAM"].includes(ch.platform)).map((ch: any) => {
                  const options: { value: "FEED" | "REEL" | "STORY" | "SHORT" | "VIDEO" | "CAROUSEL"; label: string }[] = ch.platform === "YOUTUBE"
                    ? [{ value: "VIDEO", label: "Video" }, { value: "SHORT", label: "Short" }]
                    : [{ value: "REEL", label: "Reel" }, { value: "STORY", label: "Story" }];
                  const current = formatByChannelId[ch.id] ?? options[0]!.value;
                  return (
                    <div key={ch.id} className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground min-w-0 truncate">{ch.name}</span>
                      <div className="flex gap-1 flex-shrink-0">
                        {options.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setFormatByChannelId((prev) => ({ ...prev, [ch.id]: opt.value }))}
                            className={`rounded px-3 py-1 text-xs font-medium border transition-colors ${current === opt.value ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {hasYouTube && (
                  <div className="mt-2 space-y-2 border-t pt-2">
                    <p className="text-xs text-muted-foreground font-medium">YouTube options</p>
                    <input
                      type="text"
                      placeholder="Video title (defaults to first 100 chars of content)"
                      className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                      value={ytMetadata.title ?? ""}
                      onChange={(e) => setYtMetadata((prev) => ({ ...prev, title: e.target.value || undefined }))}
                    />
                    <select
                      className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                      value={ytMetadata.privacyStatus ?? "public"}
                      onChange={(e) => setYtMetadata((prev) => ({ ...prev, privacyStatus: e.target.value as "public" | "unlisted" | "private" }))}
                    >
                      <option value="public">Public</option>
                      <option value="unlisted">Unlisted</option>
                      <option value="private">Private</option>
                    </select>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          {/* Schedule */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Schedule</CardTitle>
              <CardDescription>Set a date and time for publishing</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Label htmlFor="schedule-date" className="sr-only">
                    Schedule date
                  </Label>
                  <DateTimePicker
                    id="schedule-date"
                    value={scheduledAt}
                    onChange={setScheduledAt}
                    min={new Date().toISOString().slice(0, 16)}
                  />
                </div>
                {scheduledAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setScheduledAt("")}
                    className="text-muted-foreground"
                  >
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Unique captions (PR-5) — shown only when >1 channel is selected */}
          {selectedChannels.length > 1 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Captions</CardTitle>
                <CardDescription>
                  Write one distinct AI caption for each of your {selectedChannels.length} selected channels
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Label htmlFor="unique-captions" className="text-sm">
                      Unique caption per channel (AI)
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Captions are generated in the background — the post publishes when they&apos;re ready. You can review and edit each one on the post page.
                    </p>
                  </div>
                  <Switch
                    id="unique-captions"
                    checked={uniqueCaptions}
                    onCheckedChange={setUniqueCaptions}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          <Separator />
          <div className="flex flex-col gap-2 pb-8 sm:flex-row sm:justify-end sm:gap-3">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={async () => {
                if (postMedia.some((item) => item.uploading)) {
                  toast({ title: "Please wait", description: "Media is still uploading...", variant: "destructive" });
                  return;
                }
                try {
                  setIsUploading(true);
                  // Resolve EVERY attached item (incl. url-only deep-link images) to a
                  // real mediaId. Throws if an image can't be saved → we block the
                  // create instead of silently saving a draft with no image (the bug).
                  const mediaIds = await resolvePostMediaIds();
                  createPost.mutate({
                    content,
                    channelIds: selectedChannels.length > 0 ? selectedChannels : [],
                    ...(mediaIds.length > 0 && { mediaIds }),
                  });
                } catch (err: any) {
                  toast({
                    title: "Couldn't attach your image",
                    description: humanizeError(err) || "Failed to save the attached image. Please re-attach and try again.",
                    variant: "destructive",
                  });
                } finally {
                  setIsUploading(false);
                }
              }}
              disabled={!content || createPost.isPending || isUploading}
            >
              <Save className="mr-2 h-4 w-4" />
              Save as Draft
            </Button>
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={() => handleSubmit(false)}
              disabled={
                !content || selectedChannels.length === 0 || !scheduledAt || createPost.isPending || isUploading || !!youtubeBlockReason
              }
              title={youtubeBlockReason ?? undefined}
            >
              <Clock className="mr-2 h-4 w-4" />
              Schedule
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={() => handleSubmit(true)}
              disabled={!content || selectedChannels.length === 0 || createPost.isPending || isUploading || !!youtubeBlockReason}
              title={youtubeBlockReason ?? undefined}
            >
              {(createPost.isPending || isUploading) ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {isUploading ? "Uploading..." : "Publish Now"}
            </Button>
          </div>
          {youtubeBlockReason && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
              {youtubeBlockReason}
            </div>
          )}
          </>
          )}
        </div>

        {/* Right column - Preview Panel */}
        <div className="min-w-0 space-y-4 xl:sticky xl:top-6 xl:self-start">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Post Preview</h2>
          </div>
          <PostPreviewSwitcher
            content={content}
            mediaUrls={editorOpen && editorPreview ? [editorPreview] : postMedia.length > 0 ? postMedia.map(m => m.url) : undefined}
            mediaKinds={editorOpen && editorPreview ? ["image"] : postMedia.length > 0 ? postMedia.map((m) => (isVideoMediaItem(m) ? "video" : "image")) : undefined}
            platforms={selectedPlatforms.length > 0 ? selectedPlatforms : undefined}
            timestamp={scheduledAt ? new Date(scheduledAt) : new Date()}
          />
          {!content && selectedPlatforms.length === 0 && (
            <p className="text-center text-xs text-muted-foreground">
              Start typing and select channels to see platform previews
            </p>
          )}
        </div>
      </div>
      <MediaPickerDialog
        open={showMediaPicker}
        onOpenChange={setShowMediaPicker}
        onSelect={handleMediaLibrarySelect}
        title="Attach Image from Library"
      />
    </div>
  );
}
