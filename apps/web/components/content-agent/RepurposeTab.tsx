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
import { MediaPickerDialog } from "~/components/media-picker-dialog";
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
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  X,
  UploadCloud,
  Crop,
} from "lucide-react";

// Round 15 — the 14 headline fonts the renderer supports.
// Mirrors `FONT_OPTIONS` from @postautomation/ai (card-engine.ts). Hardcoded
// locally rather than imported because that barrel pulls in server-only AI
// provider SDKs, which must not enter the client bundle. The `value`s MUST stay
// in sync with the server's FontFamily enum / headlineFont zod input.
const HEADLINE_FONT_OPTIONS = [
  { value: "inter",          label: "Inter (modern sans)" },
  { value: "serif_display",  label: "Playfair (elegant serif)" },
  { value: "condensed",      label: "Oswald (condensed news)" },
  { value: "montserrat",     label: "Montserrat (bold geometric)" },
  { value: "poppins",        label: "Poppins (rounded modern)" },
  { value: "bebas",          label: "Bebas Neue (display impact)" },
  { value: "anton",          label: "Anton (ultra-heavy display)" },
  { value: "archivo_black",  label: "Archivo Black (bold grotesque)" },
  { value: "dm_serif",       label: "DM Serif (modern editorial)" },
  { value: "lora",           label: "Lora (refined serif)" },
  { value: "roboto_slab",    label: "Roboto Slab (technical slab)" },
  { value: "bitter",         label: "Bitter (screen slab)" },
  { value: "space_grotesk",  label: "Space Grotesk (tech sans)" },
  { value: "libre_franklin", label: "Libre Franklin (news grotesque)" },
] as const;

// Union of the 14 font values (+ "" = auto). Keeps `headlineFont` state assignable
// to the strict mutation input while still holding any of the 14 fonts.
type HeadlineFont = (typeof HEADLINE_FONT_OPTIONS)[number]["value"] | "";

const ALL_PLATFORMS = [
  "TWITTER", "LINKEDIN", "INSTAGRAM", "FACEBOOK", "REDDIT", "YOUTUBE",
  "TIKTOK", "PINTEREST", "THREADS", "MASTODON", "BLUESKY", "MEDIUM", "DEVTO",
] as const;

const providers = ["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"] as const;
const PROVIDER_LABELS: Record<typeof providers[number], string> = {
  openai: "OpenAI (GPT-4)", anthropic: "Anthropic (Claude)",
  gemini: "Google (Gemini)", grok: "xAI (Grok)",
  deepseek: "DeepSeek", gemma4: "Google (Gemma 4)",
};

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

/** Plain-English "which AI made this image" chip — rendered SEPARATELY in the
 *  UI (above the post preview), never baked into the picture, so non-technical
 *  users always know the source. `engines` is the unique set used across the
 *  run: one for static, possibly mixed for carousel/reel slides ("Gemini +
 *  OpenAI" when a slide fell back mid-batch). Hidden when no AI image was made
 *  (the card description already explains the article-photo fallback). */
function ImageEngineChip({ engines, label = "Image created by" }: { engines: string[]; label?: string }) {
  if (engines.length === 0) return null;
  const names = engines.map((e) => (e === "openai" ? "OpenAI (GPT Image)" : "Google Gemini (Nano Banana)"));
  return (
    <div className="mt-1.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
      <Sparkles className="h-3 w-3 text-purple-500" />
      {label} {names.join(" + ")}
    </div>
  );
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
  const [provider, setProvider] = useState<typeof providers[number]>("openai");
  const { data: aiConfig } = trpc.ai.getConfig.useQuery();
  useEffect(() => {
    if (!aiConfig) return;
    const configured: Record<string, boolean> = {
      openai: aiConfig.openai, anthropic: aiConfig.anthropic,
      gemini: aiConfig.gemini, grok: aiConfig.grok,
      deepseek: aiConfig.deepseek, gemma4: aiConfig.gemma4,
    };
    if (!configured[provider]) {
      const first = (["openai", "anthropic", "gemini", "gemma4", "grok", "deepseek"] as const)
        .find((p) => configured[p]);
      if (first) setProvider(first);
    }
  }, [aiConfig, provider]);
  const [theme, setTheme] = useState<"dark" | "light" | "gradient">("light");
  // Brand accent color — sourced from the picker below and from a saved
  // template's brandColor. Sent to the router as accentColor when non-empty.
  const [accentColor, setAccentColor] = useState<string>("");
  // Mirror accentColor into a ref so classifyAndPreselect can read the LATEST
  // value without taking it as a dep — that keeps the callback stable (deps [])
  // so every caller (paste/blur/change) uses the same fresh logic. (Without this
  // the paste path, defined before classifyAndPreselect, captured a stale "".)
  const accentColorRef = useRef<string>("");
  useEffect(() => { accentColorRef.current = accentColor; }, [accentColor]);
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
  // E1: aesthetic/style reference image. OpenAI vision detects its layout and
  // drives the rendered template style/theme/accent (+ prefers the real photo).
  const [aestheticRefUrl, setAestheticRefUrl] = useState<string>("");
  // Media id of an UPLOADED style reference (so "Save as template" can persist it
  // as the saved style's reference thumbnail). Empty for pasted URLs.
  const [aestheticRefMediaId, setAestheticRefMediaId] = useState<string>("");
  // E3a: free-text aesthetic/style notes appended to the AI background prompt.
  const [imageContext, setImageContext] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  // Advanced options toggle — Background Theme, Logo Position, and Aesthetic/style
  // notes are collapsed by default. The Creative Style picker is now ALWAYS visible
  // (T2b) — it decides the rendered layout; the reference only pre-selects it.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // T2b: true once a style reference auto-suggested the picker value. Cleared the
  // moment the user clicks a style button (their explicit choice) or clears the ref.
  const [styleAutoSuggested, setStyleAutoSuggested] = useState(false);
  // Round 10: opt-in true style mimicry. When ON (only offered when a style
  // reference is attached), the static post + carousel cover are recreated from
  // the reference's LAYOUT via Gemini image-to-image — not just tinted. OFF
  // (default) = today's template render.
  const [referenceMimicry, setReferenceMimicry] = useState(false);
  // Round 10 D5: "ai" = AI renders the headline inside the recreated layout
  // (most faithful — proven cleanest in the visual gate; default). "overlay" =
  // AI leaves headline space, code overlays exact text (guaranteed-legible, but
  // its fixed bottom band can collide with a mimicked footer). User-selectable.
  // The static + regen mimicry paths always render text deterministically (the
  // engine ignores this), so there's no user-facing text-mode toggle anymore. Kept
  // as a constant default so the mutation payload contract is unchanged.
  const [mimicryTextMode] = useState<"ai" | "overlay">("ai");
  // D2: Real⇄AI image toggle. Default ON preserves the prior always-AI behaviour.
  const [aiImages, setAiImages] = useState<boolean>(true);
  // D10: per-slot user image assignments (all formats). Keyed by slot:
  //   "background" (static) | "slide:0".."slide:N" (carousel). Each entry carries
  //   the org-owned Media id + url (for preview). The picker writes here; the
  //   mutate payload maps it to [{slot, mediaId}].
  const [imageAssignments, setImageAssignments] = useState<Record<string, { mediaId: string; url: string }>>({});
  // The slot whose Media Library picker is currently open (one shared dialog).
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  // A user-assigned STATIC background image becomes the whole post media, so the
  // AI-styling controls are irrelevant in that case (parity w/ the old behaviour).
  const useOwnImage = format === "static" && !!imageAssignments["background"];

  // Feature 2 — Brand name on card. Explicit name wins over any saved-style name
  // in computeActiveBrandName. Saved as "name" kind templates.
  const [brandNameInput, setBrandNameInput] = useState<string>("");

  // Feature 3 — Inline headline edit. Initialized from renderedHeadline when
  // results arrive; Regenerate prefers this over the server's rendered value.
  const [editedHeadline, setEditedHeadline] = useState<string>("");
  // REP-2 — Per-slide carousel text edits. Keyed by slide index; cleared on each new generate.
  const [slideEdits, setSlideEdits] = useState<Record<number, { title?: string; body?: string }>>({});

  // Round 14/15 — Headline font + text-color pickers.
  // Empty string = use the reference-detected value (server default).
  // Round 15: widened to the 14-font union (+ "" = auto) so it can hold any FONT_OPTIONS value.
  const [headlineFont, setHeadlineFont] = useState<HeadlineFont>("");
  const [headlineColor, setHeadlineColor] = useState<string>("");

  // Round 17 — additional reference-card controls (all "" / "" = auto/default).
  // headlineAlign: headline alignment override; labelColor: brand-name/eyebrow
  // color; logoSize: explicit logo size (4–40, only meaningful when a logo is set).
  const [headlineAlign, setHeadlineAlign] = useState<"left" | "center" | "right" | "">("");
  const [labelColor, setLabelColor] = useState<string>("");
  const [logoSize, setLogoSize] = useState<number | "">("");

  // FIX C — Hero photo editor state.
  // Whether the hero editor panel is open (only shown for the static result card).
  const [heroEditorOpen, setHeroEditorOpen] = useState(false);
  // The source image the user has chosen to crop: either a picked article URL or
  // an uploaded file URL. null = nothing chosen yet.
  const [heroSrcUrl, setHeroSrcUrl] = useState<string | null>(null);
  // Crop/zoom/pan state: zoom is a scale factor (1.0 = fit-to-frame), offsetX/Y
  // are pixel offsets within the preview canvas coordinate space.
  const [heroZoom, setHeroZoom] = useState<number>(1);
  const [heroOffsetX, setHeroOffsetX] = useState<number>(0);
  const [heroOffsetY, setHeroOffsetY] = useState<number>(0);
  // Track pointer drag for pan.
  const heroDragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  // The <img> element loaded for the hero source (used by canvas drawImage).
  const heroImgRef = useRef<HTMLImageElement | null>(null);
  // Whether the hero source image is currently uploading/processing.
  const [heroUploading, setHeroUploading] = useState(false);

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
    // Which AI image engine(s) made the visuals — drives the "Image created by
    // X" chip. Plural covers carousel/reel (slides can mix engines mid-batch).
    // bgSource: "ai" = AI-generated; "real" = actual article/user photo;
    // "branded" = a branded gradient (rare — the no-photo guard blocks most).
    bgSource?: "ai" | "real" | "branded" | null;
    imageEngine?: string | null;
    imageEngines?: string[];
    // C/D: what an uploaded style reference actually drove this render to (so the
    // UI confirms it was honoured, vs. the old silent no-op).
    referenceApplied?: boolean;
    appliedStyle?: string | null;
    appliedTheme?: string | null;
    usedRealPhoto?: boolean;
    // Round 10: which mimicry rung produced the static/cover image (honest chip).
    // null when mimicry was OFF or fell through to the 4-template render.
    mimicryEngine?: "gemini-img2img" | "openai-described" | "gemini-composite" | "layout-extract" | null;
    // FIX 1(c) (Round 16): the article's hero photo was unfetchable (e.g. NDTV
    // hard-403), so the mimicry card rendered photoless — prompt the user to add one.
    heroPhotoMissing?: boolean;
    // REP-2: per-slide text returned by the backend so the editor can seed each slide.
    carouselSlides?: { index: number; role: string; title: string; body: string; mediaId: string }[];
  } | null>(null);
  const [copiedPlatform, setCopiedPlatform] = useState<string | null>(null);

  // Progress / activity log
  interface ProgressStep { step: string; status: "running" | "done" | "error" | "skipped"; detail?: string; ts: number }
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [progressId, setProgressId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Round 17 — honest cancel. When the user cancels a running generation we set
  // this; the mutation onSuccess/onError check it at the top and bail so a
  // late-arriving server response does NOT overwrite the cancelled UI state.
  const cancelledRef = useRef(false);

  // Async video (reel / seedance): the mutation returns { videoPending } and the
  // worker pushes a terminal `video_ready`/`video_error` over the SAME SSE the
  // activity log already listens to. While the worker generates, keep the spinner
  // up via this flag (the mutation has long since resolved, so isLoading is false).
  const [videoGenerating, setVideoGenerating] = useState(false);
  const videoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wall-clock guard for the synchronous static/carousel path: if the server
  // dies mid-render and the SSE never emits __finished__, this fires after 4
  // minutes and clears the spinner rather than leaving it stuck forever.
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stop the SSE + clear the safety timeout in one place.
  const closeVideoStream = useCallback(() => {
    if (videoTimeoutRef.current) {
      clearTimeout(videoTimeoutRef.current);
      videoTimeoutRef.current = null;
    }
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  // Clipboard paste handler for the style-reference URL input. Reads an image
  // from the clipboard and uploads it exactly like the file uploader does.
  const handleRefPaste = useCallback(async (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", "aesthetic-ref");
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (res.ok) {
      const { id, url } = await res.json();
      setAestheticRefUrl(url);
      setAestheticRefMediaId(id ?? "");
      classifyAndPreselect(url);
    } else {
      toast({ title: "Pasted image upload failed", variant: "destructive" });
    }
  }, [toast]);

  // T2b: classify the just-attached reference and pre-select the closest creative
  // style. Uses the url passed in (not stale state). Null suggestion = no-op.
  // Also pre-fills accent color + theme from the reference — only when the user
  // hasn't already set their own accent (don't clobber an explicit brand decision).
  const classifyAndPreselect = useCallback((refUrl: string) => {
    if (!refUrl) return;
    classifyRef.mutate(
      { aestheticRefUrl: refUrl },
      {
        onSuccess: (r) => {
          let touched = false;
          if (r.suggestedStyle) { setCreativeStyle(r.suggestedStyle); touched = true; }
          // Pre-fill accent + theme from the reference — only when the user hasn't
          // already set their own accent (don't clobber an explicit brand decision).
          // Read the LATEST accent via the ref so this stays dep-free + stable.
          if (r.accentColor && !accentColorRef.current) { setAccentColor(r.accentColor); touched = true; }
          if (r.theme) { setTheme(r.theme); touched = true; }
          if (touched) setStyleAutoSuggested(true);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Cleanup SSE + safety timeouts on unmount
  useEffect(() => {
    return () => {
      if (videoTimeoutRef.current) clearTimeout(videoTimeoutRef.current);
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      eventSourceRef.current?.close();
    };
  }, []);

  // Channel info (for branding + publishing)
  const { data: channels } = trpc.channel.list.useQuery();
  const { data: creativeTemplates } = trpc.creativeTemplate.list.useQuery();
  const createTemplate = trpc.creativeTemplate.create.useMutation();
  const updateTemplate = trpc.creativeTemplate.update.useMutation();
  const deleteTemplate = trpc.creativeTemplate.delete.useMutation();
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
      // Round 17: a cancelled run must not overwrite the cleared UI even if the
      // server eventually responds. Reset the flag and bail.
      if (cancelledRef.current) { cancelledRef.current = false; return; }
      setResults({ platformContent: data.platformContent, mediaUrls: [], mediaType: "", format: "text" });
      toast({ title: "Content repurposed!" });
    },
    onError: (err) => {
      if (cancelledRef.current) { cancelledRef.current = false; return; }
      toast({ title: "Repurpose failed", description: humanizeError(err), variant: "destructive" });
    },
  });

  // URL-based repurpose
  const repurposeFromUrl = trpc.repurpose.repurposeFromUrl.useMutation({
    onSuccess: (data) => {
      // Round 17: honest cancel — if the user cancelled, the server response is
      // discarded so it can't repopulate results behind the cancelled state.
      if (cancelledRef.current) { cancelledRef.current = false; return; }
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
      // Clear the static/carousel wall-clock guard — we got a normal response.
      if (syncTimeoutRef.current) { clearTimeout(syncTimeoutRef.current); syncTimeoutRef.current = null; }
      setResults(data);
      // Feature 3: initialize the editable headline from the server's rendered value.
      setEditedHeadline(data.renderedHeadline ?? data.extracted?.title ?? "");
      // REP-2: reset per-slide edits on each new generate (carouselSlides seeds from fresh data).
      setSlideEdits({});
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
      // Round 17: a cancelled run's late error is a no-op (UI already reset).
      if (cancelledRef.current) { cancelledRef.current = false; return; }
      // Clear the static/carousel wall-clock guard — the mutation errored normally.
      if (syncTimeoutRef.current) { clearTimeout(syncTimeoutRef.current); syncTimeoutRef.current = null; }
      toast({ title: "Repurpose failed", description: humanizeError(err), variant: "destructive" });
      setProgressSteps((prev) => [...prev, { step: "Request failed", status: "error" as const, detail: err.message, ts: Date.now() }]);
      eventSourceRef.current?.close();
    },
  });

  // T2b — classify an attached style reference and pre-select the closest creative
  // style. Fail-soft on the backend (never throws); a null suggestion is a no-op.
  const classifyRef = trpc.repurpose.classifyStyleReference.useMutation();

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
    // FIX 3(a) (Round 16): mirror handleGenerate — on the mimicry path send ONLY an
    // explicit logo (no channel-avatar fallback) so the avatar never renders as a
    // logo circle on the mimicked/layout-extract card. Template path keeps the avatar.
    const mimicryActive = !!aestheticRefUrl && referenceMimicry;
    return {
      channelName: ch?.name || "Channel",
      channelHandle: ch?.username || "",
      logoUrl: logoUrl || (mimicryActive ? undefined : ch?.avatar || undefined),
    };
  };

  const handleRegenerate = async (target: "static" | number) => {
    if (!results) return;
    // REP-2: for a numbered (carousel slide) target, source headline from the slide's
    // own text — NOT from editedHeadline which belongs to the cover/static image.
    // Use the COMPACTED position: carouselSlides is built lock-step with
    // mediaUrls/carouselMediaIds (same `if (!slide) continue`), so position i in
    // the display map aligns with carouselSlides[i] even if a middle slide failed
    // to render. (Do NOT match on s.index — that's the original allSlides index,
    // which diverges from the compacted display index on a mid-carousel failure.)
    const slideForTarget = typeof target === "number"
      ? results.carouselSlides?.[target]
      : undefined;
    const slideEdit = typeof target === "number" ? slideEdits[target] : undefined;
    // Headline: for a slide use the edited/seed slide title; for "static" keep the existing editedHeadline path verbatim.
    const headline = typeof target === "number"
      ? (slideEdit?.title ?? slideForTarget?.title ?? "").trim()
      : (editedHeadline.trim() || (results.renderedHeadline ?? results.extracted?.title ?? "")).trim();
    if (!headline) {
      toast({ title: "Can't regenerate", description: "No headline found for this image.", variant: "destructive" });
      return;
    }
    const { channelName, channelHandle, logoUrl: brandLogo } = resolveBranding();
    // Prefer a user-assigned hero (imageAssignments["background"]) over the
    // article's first image so that regenerate keeps the chosen/cropped photo.
    const bgImageUrl =
      imageAssignments["background"]?.url ||
      results.extracted?.images?.find((u) => u.startsWith("https://"));
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
        referenceMimicry: aestheticRefUrl ? referenceMimicry : false,
        mimicryTextMode,
        channelName,
        channelHandle,
        // R3 parity: carry the rendered hook line, the article background photo,
        // and the article-context blurb so the regenerated image matches.
        hookLine: results.hookLine ?? undefined,
        bgImageUrl: bgImageUrl || undefined,
        bgContext: bgContext || undefined,
        brandName: computeActiveBrandName(),
        headlineFont: headlineFont || undefined,
        headlineColor: headlineColor || undefined,
        // Round 17: alignment / brand-name color / logo size overrides.
        headlineAlign: headlineAlign || undefined,
        labelColor: labelColor || undefined,
        logoSize: typeof logoSize === "number" ? logoSize : undefined,
        // REP-2: pass slide role + body text for body-slide regeneration.
        slideRole: slideForTarget?.role as "cover" | "body" | "cta" | undefined,
        slideBody: slideForTarget?.role === "body" ? (slideEdit?.body ?? slideForTarget?.body) : undefined,
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
        // Refresh the "Image created by X" chip from THIS regenerate: a static
        // regen replaces the engine outright; a carousel-slide regen unions into
        // the existing set (the other slides keep whichever engine made them).
        const prevEngines = prev.imageEngines ?? (prev.imageEngine ? [prev.imageEngine] : []);
        const nextEngines =
          target === "static"
            ? (res.imageEngine ? [res.imageEngine] : [])
            : res.imageEngine && !prevEngines.includes(res.imageEngine)
              ? [...prevEngines, res.imageEngine]
              : prevEngines;
        // REP-2: sync the edited title/body back into carouselSlides so the editor
        // stays in sync after a slide regen (the new mediaId is also updated).
        let nextCarouselSlides = prev.carouselSlides;
        if (typeof target === "number" && nextCarouselSlides) {
          // Match on the COMPACTED position (slotIdx), consistent with how the
          // display map and handleRegenerate(target) index carouselSlides — NOT
          // on s.index (the original allSlides index, which can diverge).
          nextCarouselSlides = nextCarouselSlides.map((s, slotIdx) => {
            if (slotIdx !== target) return s;
            return {
              ...s,
              mediaId: res.mediaId,
              ...(slideEdit?.title !== undefined ? { title: slideEdit.title } : {}),
              ...(slideEdit?.body !== undefined ? { body: slideEdit.body } : {}),
            };
          });
        }
        return {
          ...prev,
          mediaUrls: nextUrls,
          carouselMediaIds: nextCarouselIds,
          mediaMap: nextMap,
          imageEngines: nextEngines,
          carouselSlides: nextCarouselSlides,
          ...(target === "static" ? { bgSource: res.bgSource as "ai" | "real" | "branded" | null, imageEngine: res.imageEngine, mimicryEngine: res.mimicryEngine ?? null } : {}),
        };
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

  // Compute the active brand name to send as `brandName` to the router, so the
  // mimicry eyebrow shows a real on-card brand — NOT a UI library label.
  //
  // FIX 3(b) (Round 16): a SAVED-STYLE template's `name` (e.g. "moviefied template")
  // and a LOGO template's `name` are LIBRARY LABELS, not brand names — they were
  // leaking into the eyebrow. Removed both. The user sets the on-card brand explicitly
  // via the brand-name input (a "name" kind template applies itself by setting
  // brandNameInput, so it flows through the first branch).
  // Priority: explicit brandNameInput → channel name → undefined.
  const computeActiveBrandName = (): string | undefined => {
    if (brandNameInput.trim()) return brandNameInput.trim();
    const ch = selectedChannelIds.length > 0
      ? activeChannels.find((c: any) => c.id === selectedChannelIds[0])
      : primaryChannel;
    return ch?.name || undefined;
  };

  const handleGenerate = () => {
    // Round 17: fresh run — clear any prior cancel flag so this run's response is honoured.
    cancelledRef.current = false;
    if (sourceMode === "url") {
      if (!url || selectedPlatforms.length === 0) return;
      const pid = startProgress();
      // Wall-clock guard for the synchronous static/carousel path. Video formats
      // have their own 10-min timeout (videoTimeoutRef); this covers the case
      // where the server dies mid-render and the SSE never sends __finished__,
      // leaving the spinner stuck indefinitely. Cleared on onSuccess / onError.
      if (format !== "reel" && format !== "ai_video" && format !== "seedance_video") {
        if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = setTimeout(() => {
          syncTimeoutRef.current = null;
          setProgressSteps((prev) => finalizeRunningSteps(prev, "error"));
          eventSourceRef.current?.close();
          eventSourceRef.current = null;
          toast({
            title: "Generation timed out",
            description: "The server took too long to respond — please try again.",
            variant: "destructive",
          });
        }, 4 * 60 * 1000); // 4 minutes
      }
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
        // FIX 3(a) (Round 16): only send an EXPLICITLY chosen brand logo as logoUrl.
        // For the mimicry/layout-extract path, do NOT fall back to the channel avatar
        // — the avatar is a generic profile picture, not a brand logo, and was rendering
        // as an orange logo circle on the mimicked card (resolveLogoForOrg classifies any
        // incoming logoUrl as "explicit"). When mimicry is active and there's no explicit
        // logo, send undefined → the card renders with NO logo. The non-mimicry template
        // path keeps the avatar fallback (it relies on it for brand consistency).
        logoUrl: logoUrl || ((aestheticRefUrl && referenceMimicry)
          ? undefined
          : (() => {
              const ch = selectedChannelIds.length > 0
                ? activeChannels.find((c: any) => c.id === selectedChannelIds[0])
                : primaryChannel;
              return ch?.avatar || "";
            })()),
        creativeStyle,
        logoPosition,
        theme,
        accentColor: accentColor || undefined,
        aestheticRefUrl: aestheticRefUrl || undefined,
        // Round 10: only meaningful with a reference; the server also guards on a
        // usable fetched ref. Send the raw flags; server falls back gracefully.
        referenceMimicry: aestheticRefUrl ? referenceMimicry : false,
        mimicryTextMode,
        // Strip bare URLs out of the free-text notes at send time so a URL pasted
        // into the NOTES box doesn't leak into the AI prompt as literal text.
        imageContext: stripBareUrls(imageContext) || undefined,
        // D2 (Real⇄AI) + D10 (per-slot images). When off, slots resolve real-first;
        // each assignment overrides AI/article for that one slot.
        aiImages,
        // Only send assignments backed by a real Media id. A url-only entry (the
        // tainted-canvas "use uncropped" fallback for the background slot) has an
        // empty mediaId — it can't be an imageAssignment (schema requires min(1)
        // + IDOR-checks the id); it reaches the render via bgImageUrl on regen instead.
        imageAssignments: Object.entries(imageAssignments)
          .filter(([, v]) => !!v.mediaId)
          .map(([slot, v]) => ({ slot, mediaId: v.mediaId })),
        brandName: computeActiveBrandName(),
        slideCount,
        videoDuration,
        // Seedance generates its own native audio, so the voiceOver/bgMusic
        // toggles are hidden for seedance_video — only reel & ai_video use them.
        voiceOver: (format === "reel" || format === "ai_video") ? voiceOver : false,
        voiceType: voiceType as any,
        bgMusic: (format === "reel" || format === "ai_video") ? bgMusic : false,
        headlineFont: headlineFont || undefined,
        headlineColor: headlineColor || undefined,
        // Round 17: alignment / brand-name color / logo size overrides.
        headlineAlign: headlineAlign || undefined,
        labelColor: labelColor || undefined,
        logoSize: typeof logoSize === "number" ? logoSize : undefined,
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

              {/* D2/D10: Real⇄AI image toggle + per-slot "your image" picker. The
                  toggle governs whether the AI invents a photo for any slot with no
                  assigned image; the picker assigns YOUR photo to a specific slot
                  (it overrides AI/article for that slot only). */}
              {(format === "static" || format === "carousel" || format === "reel") && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                    <div className="pr-3">
                      <Label className="text-sm font-medium">AI image generation</Label>
                      <p className="text-xs text-muted-foreground">
                        {aiImages
                          ? "On — the AI invents a photo when no real one is assigned to a slot"
                          : "Off — uses your image, the article photo, or a branded background"}
                      </p>
                    </div>
                    <Switch checked={aiImages} onCheckedChange={setAiImages} />
                  </div>

                  {(format === "static" || format === "carousel") && (() => {
                    const slotKeys =
                      format === "carousel"
                        ? Array.from({ length: slideCount }, (_, i) => `slide:${i}`)
                        : ["background"];
                    const slotLabel = (slot: string) =>
                      slot === "background" ? "Background" : `Slide ${Number(slot.split(":")[1]) + 1}`;
                    return (
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Your images (optional)</Label>
                        <p className="text-xs text-muted-foreground">
                          Assign your own photo to a slot — it overrides AI/article for that slot only.
                        </p>
                        {slotKeys.map((slot) => {
                          const cur = imageAssignments[slot];
                          return (
                            <div key={slot} className="flex items-center gap-2">
                              <span className="w-20 shrink-0 text-xs text-muted-foreground">{slotLabel(slot)}</span>
                              {cur ? (
                                <>
                                  <img src={cur.url} alt={slot} className="h-9 w-9 rounded border object-cover" />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setImageAssignments((p) => {
                                        const n = { ...p };
                                        delete n[slot];
                                        return n;
                                      })
                                    }
                                  >
                                    Clear
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    id={`slot-upload-${slot}`}
                                    onChange={async (e) => {
                                      const file = e.target.files?.[0];
                                      e.target.value = "";
                                      if (!file) return;
                                      const fd = new FormData();
                                      fd.append("file", file);
                                      const res = await fetch("/api/upload", { method: "POST", body: fd });
                                      if (!res.ok) {
                                        toast({ title: "Image upload failed", variant: "destructive" });
                                        return;
                                      }
                                      const d = await res.json();
                                      setImageAssignments((p) => ({ ...p, [slot]: { mediaId: d.id, url: d.url } }));
                                    }}
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => document.getElementById(`slot-upload-${slot}`)?.click()}
                                  >
                                    Upload
                                  </Button>
                                  <Button type="button" variant="outline" size="sm" onClick={() => setPickerSlot(slot)}>
                                    Library
                                  </Button>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* ONE shared Media Library dialog for whichever slot is picking. */}
                  <MediaPickerDialog
                    open={pickerSlot !== null}
                    onOpenChange={(v) => {
                      if (!v) setPickerSlot(null);
                    }}
                    onSelect={(u, _n, mediaId) => {
                      const slot = pickerSlot;
                      if (mediaId && slot) setImageAssignments((p) => ({ ...p, [slot]: { mediaId, url: u } }));
                    }}
                  />
                </div>
              )}

              {/* Creative style + brand reference (static + carousel cover).
                  Hidden when the user attached their own static image (no AI
                  image is generated, so the styling controls are irrelevant). */}
              {((format === "static" && !useOwnImage) || format === "carousel") && (
                <div className="space-y-2">
                  {/* ── Creative Style ── ALWAYS visible (T2b). This picker DECIDES
                       the rendered layout; a style reference only pre-selects the
                       closest one (and the user can change it). ── */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Creative style</Label>
                      {styleAutoSuggested && aestheticRefUrl && (
                        <span className="text-[10px] text-primary">Suggested from your reference</span>
                      )}
                    </div>
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
                          onClick={() => {
                            setCreativeStyle(s.id as typeof creativeStyle);
                            // Manual pick = explicit choice — drop the "suggested" badge.
                            setStyleAutoSuggested(false);
                          }}
                          className={`rounded-lg border px-3 py-2 text-xs font-medium ${creativeStyle === s.id ? "border-primary bg-primary/10" : "border-border"}`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Pick how the post looks. A style reference pre-selects the closest one — change it anytime.
                    </p>
                  </div>

                  {/* ── Advanced toggle ── now gates Theme, Logo Position & style
                       notes only (the style picker above is always visible). ── */}
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((v) => !v)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Advanced — theme, logo &amp; notes
                  </button>

                  {/* ── Library — split into "Brand logos" and "Saved styles" sections.
                       No silent auto-save: items only land here when you click
                       "Save as template". Each can be applied, renamed, or deleted.
                       Always visible (not gated by advancedOpen). ── */}
                  {(() => {
                    const logoTemplates = (creativeTemplates ?? []).filter((t) => (t as any).kind === "logo");
                    const styleTemplates = (creativeTemplates ?? []).filter((t) => (t as any).kind === "style");
                    const nameTemplates = (creativeTemplates ?? []).filter((t) => (t as any).kind === "name");
                    return (
                      <>
                        {/* Section 1 — Brand logos */}
                        {logoTemplates.length > 0 && (
                          <div className="rounded-lg border border-border p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-semibold">Brand logos</Label>
                              <span className="text-[10px] text-muted-foreground">Click to use a logo — won&apos;t change your style</span>
                            </div>
                            <div className="flex flex-wrap gap-2 pt-1">
                              {logoTemplates.map((t) => (
                                <div
                                  key={t.id}
                                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs ${logoMediaId === t.logoMediaId && t.logoMediaId ? "border-primary bg-primary/10" : "border-border"}`}
                                >
                                  <button
                                    type="button"
                                    title="Use this logo"
                                    onClick={() => {
                                      setLogoUrl((t as any).logoMedia?.url ?? "");
                                      setLogoMediaId(t.logoMediaId ?? "");
                                      if (t.logoPosition) setLogoPosition(t.logoPosition as "top-left" | "top-right");
                                      // Logo color is only a FALLBACK: if NO style reference is active,
                                      // adopt the logo's saved brand color; if a reference IS active,
                                      // never touch the color.
                                      if (!aestheticRefUrl && t.brandColor) setAccentColor(t.brandColor);
                                    }}
                                    className="flex items-center gap-1.5"
                                  >
                                    {(t as any).logoMedia?.url ? (
                                      <img src={(t as any).logoMedia.url} alt={t.name} className="h-10 w-10 rounded object-contain border" />
                                    ) : (
                                      <div className="h-10 w-10 rounded border flex items-center justify-center bg-muted text-[10px] text-muted-foreground">logo</div>
                                    )}
                                    <span className="max-w-[6rem] truncate">{t.name}</span>
                                  </button>
                                  <button
                                    type="button"
                                    title="Rename"
                                    onClick={async () => {
                                      const name = window.prompt("Rename this logo:", t.name);
                                      if (!name || name.trim() === t.name) return;
                                      await updateTemplate.mutateAsync({ id: t.id, name: name.trim() });
                                      utils.creativeTemplate.list.invalidate();
                                    }}
                                    className="text-muted-foreground hover:text-foreground"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    title="Delete"
                                    onClick={async () => {
                                      if (!window.confirm(`Delete brand logo "${t.name}"?`)) return;
                                      await deleteTemplate.mutateAsync({ id: t.id });
                                      utils.creativeTemplate.list.invalidate();
                                      toast({ title: "Brand logo deleted" });
                                    }}
                                    className="text-muted-foreground hover:text-destructive"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Section 2 — Saved styles (kind === "style" only) */}
                        {styleTemplates.length > 0 && (
                          <div className="rounded-lg border border-border p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-semibold">Saved styles</Label>
                              <span className="text-[10px] text-muted-foreground">Click to apply a saved look (style + theme + color)</span>
                            </div>
                            <div className="flex flex-wrap gap-2 pt-1">
                              {styleTemplates.map((t) => (
                                <div
                                  key={t.id}
                                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs ${selectedTemplateId === t.id ? "border-primary bg-primary/10" : "border-border"}`}
                                >
                                  <button
                                    type="button"
                                    title="Apply this style"
                                    onClick={() => {
                                      setSelectedTemplateId(t.id);
                                      if (t.style) setCreativeStyle(t.style as typeof creativeStyle);
                                      if (t.brandColor) setAccentColor(t.brandColor);
                                      if (t.logoPosition) setLogoPosition(t.logoPosition as "top-left" | "top-right");
                                      const cs = (t as any).cardSpec?.controls;
                                      if (cs?.theme) setTheme(cs.theme);
                                      // Round 11: a saved STYLE that stored its reference image IS the
                                      // "mimic this look" intent. Hand the reference to the mimicry engine
                                      // (sets aestheticRefUrl so the toggle appears) and auto-arm it — this
                                      // was the gap that made saved-style picks silently run the old
                                      // template path. Clearing the ref / unticking still fully opts out.
                                      const refUrl = (t as any).referenceMedia?.url as string | undefined;
                                      if (refUrl) {
                                        setAestheticRefUrl(refUrl);
                                        setAestheticRefMediaId(t.referenceMediaId ?? "");
                                        setReferenceMimicry(true);
                                      }
                                    }}
                                    className="flex items-center gap-1.5"
                                  >
                                    {(t as any).referenceMedia?.url ? (
                                      <img src={(t as any).referenceMedia.url} alt={t.name} className="h-10 w-10 rounded object-cover" />
                                    ) : (
                                      <div className="h-10 w-10 rounded border flex items-center justify-center bg-muted text-[10px] text-muted-foreground">style</div>
                                    )}
                                    <span className="max-w-[6rem] truncate">{t.name}</span>
                                  </button>
                                  <button
                                    type="button"
                                    title="Rename"
                                    onClick={async () => {
                                      const name = window.prompt("Rename this style:", t.name);
                                      if (!name || name.trim() === t.name) return;
                                      await updateTemplate.mutateAsync({ id: t.id, name: name.trim() });
                                      utils.creativeTemplate.list.invalidate();
                                    }}
                                    className="text-muted-foreground hover:text-foreground"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    title="Delete"
                                    onClick={async () => {
                                      if (!window.confirm(`Delete saved style "${t.name}"?`)) return;
                                      await deleteTemplate.mutateAsync({ id: t.id });
                                      if (selectedTemplateId === t.id) setSelectedTemplateId("");
                                      utils.creativeTemplate.list.invalidate();
                                      toast({ title: "Saved style deleted" });
                                    }}
                                    className="text-muted-foreground hover:text-destructive"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                  {/* Round 17 — off-switch for the selected style: clears the
                                      selection AND the reference it armed. */}
                                  {selectedTemplateId === t.id && (
                                    <button
                                      type="button"
                                      title="Unselect this style"
                                      onClick={() => {
                                        setSelectedTemplateId("");
                                        setAestheticRefUrl("");
                                        setAestheticRefMediaId("");
                                        setReferenceMimicry(false);
                                      }}
                                      className="text-muted-foreground hover:text-foreground"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Section 3 — Saved names (kind === "name") */}
                        {nameTemplates.length > 0 && (
                          <div className="rounded-lg border border-border p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-semibold">Saved names</Label>
                              <span className="text-[10px] text-muted-foreground">Click to set the brand name shown on the card</span>
                            </div>
                            <div className="flex flex-wrap gap-2 pt-1">
                              {nameTemplates.map((t) => (
                                <div
                                  key={t.id}
                                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs ${brandNameInput === t.name ? "border-primary bg-primary/10" : "border-border"}`}
                                >
                                  <button
                                    type="button"
                                    title="Use this name"
                                    onClick={() => setBrandNameInput(t.name)}
                                    className="max-w-[8rem] truncate"
                                  >
                                    {t.name}
                                  </button>
                                  <button
                                    type="button"
                                    title="Rename"
                                    onClick={async () => {
                                      const name = window.prompt("Rename this saved name:", t.name);
                                      if (!name || name.trim() === t.name) return;
                                      await updateTemplate.mutateAsync({ id: t.id, name: name.trim() });
                                      utils.creativeTemplate.list.invalidate();
                                    }}
                                    className="text-muted-foreground hover:text-foreground"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    title="Delete"
                                    onClick={async () => {
                                      if (!window.confirm(`Delete saved name "${t.name}"?`)) return;
                                      await deleteTemplate.mutateAsync({ id: t.id });
                                      utils.creativeTemplate.list.invalidate();
                                      toast({ title: "Saved name deleted" });
                                    }}
                                    className="text-muted-foreground hover:text-destructive"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}

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
                    {/* Round 17 — remove the current logo. */}
                    {(logoUrl || logoMediaId) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => { setLogoUrl(""); setLogoMediaId(""); }}
                      >
                        Remove
                      </Button>
                    )}
                    {/* Round 17 — save the current logo to the "Brand logos" library. */}
                    {(logoUrl || logoMediaId) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        title="Save this logo for reuse"
                        onClick={async () => {
                          const fallbackName = computeActiveBrandName() || "Brand logo";
                          const name = (prompt("Name this logo", `${fallbackName} logo`) || "").trim();
                          if (!name) return;
                          await createTemplate.mutateAsync({
                            name,
                            kind: "logo",
                            logoMediaId: logoMediaId || undefined,
                            logoPosition,
                            ...(accentColor ? { brandColor: accentColor } : {}),
                          } as any);
                          utils.creativeTemplate.list.invalidate();
                          toast({ title: "Logo saved" });
                        }}
                      >
                        Save logo
                      </Button>
                    )}
                    {logoUrl && <img src={logoUrl} alt="logo" className="h-8 w-8 rounded object-contain border" />}
                    {advancedOpen && (
                      <Select value={logoPosition} onValueChange={(v) => setLogoPosition(v as "top-left" | "top-right")}>
                        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="top-right">Logo top-right</SelectItem>
                          <SelectItem value="top-left">Logo top-left</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
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

                  {/* ── Brand name on card (optional) — Feature 2 ── */}
                  <div className="flex items-center gap-2 pt-1">
                    <Label className="text-xs" htmlFor="brand-name-input">Brand name on card</Label>
                    <Input
                      id="brand-name-input"
                      value={brandNameInput}
                      onChange={(e) => setBrandNameInput(e.target.value)}
                      placeholder="e.g. Dashmani Media"
                      className="h-8 flex-1 text-xs"
                    />
                    {brandNameInput.trim() && (
                      <button
                        type="button"
                        onClick={async () => {
                          const name = brandNameInput.trim();
                          if (!name) return;
                          await createTemplate.mutateAsync({ name, kind: "name" } as any);
                          utils.creativeTemplate.list.invalidate();
                          toast({ title: "Name saved" });
                        }}
                        className="text-[10px] text-primary hover:underline whitespace-nowrap"
                        title="Save this name for reuse"
                      >
                        Save name
                      </button>
                    )}
                    {brandNameInput && (
                      <button
                        type="button"
                        onClick={() => setBrandNameInput("")}
                        className="text-[10px] text-muted-foreground hover:underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {/* ── Style reference (optional) ── ONE consolidated block (T6):
                       upload | paste/link a post + thumbnail + Clear, then one line
                       of helper copy. We match its theme, accent & logo and
                       pre-select the closest style (the picker above stays in control). */}
                  <div className="space-y-1.5 pt-1">
                    <Label className="text-xs">Style reference (optional)</Label>
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
                          const { id, url } = await res.json();
                          setAestheticRefUrl(url);
                          setAestheticRefMediaId(id ?? "");
                          classifyAndPreselect(url);
                        } else {
                          toast({ title: "Style reference upload failed", variant: "destructive" });
                        }
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById("aesthetic-ref-upload")?.click()}>
                        {aestheticRefUrl ? "Change" : "Upload"}
                      </Button>
                      <Input
                        type="url"
                        value={aestheticRefUrl}
                        onChange={(e) => { setAestheticRefUrl(e.target.value); setAestheticRefMediaId(""); }}
                        onPaste={handleRefPaste}
                        onBlur={(e) => {
                          // T2b: a typed/pasted URL is "committed" on blur — classify it
                          // and pre-select the closest style (looks-like-a-URL only).
                          const v = e.target.value.trim();
                          if (/^https?:\/\//i.test(v)) classifyAndPreselect(v);
                        }}
                        placeholder="Paste an image (Cmd/Ctrl+V) or a post URL"
                        className="h-8 flex-1 text-xs"
                      />
                      {aestheticRefUrl && (
                        <>
                          <img src={aestheticRefUrl} alt="style reference" className="h-8 w-8 rounded object-cover border shrink-0" />
                          <button
                            type="button"
                            onClick={() => { setAestheticRefUrl(""); setAestheticRefMediaId(""); setStyleAutoSuggested(false); setReferenceMimicry(false); setSelectedTemplateId(""); }}
                            className="text-[10px] text-muted-foreground hover:underline shrink-0"
                          >
                            Clear
                          </button>
                        </>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Upload, paste (Cmd/Ctrl+V), or link a post you want this to look like. We match its theme, accent &amp; logo and pre-select the closest style.
                    </p>
                    {looksLikePostUrl(aestheticRefUrl) && (
                      <p className="text-[10px] text-muted-foreground">We&apos;ll grab the post&apos;s main image automatically. (Instagram links often block automated fetch — uploading the image is more reliable.)</p>
                    )}
                  </div>

                  {aestheticRefUrl && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={referenceMimicry}
                          onChange={(e) => setReferenceMimicry(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span className="text-xs">
                          <span className="font-semibold">Recreate this reference&apos;s layout</span>
                          <span className="block text-[10px] text-muted-foreground mt-0.5">
                            Matches your reference&apos;s layout — its colors, logo position, alignment and headline treatment — using your real photo and your exact text.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}

                  {/* E3a: free-text aesthetic / style notes — Advanced only */}
                  {advancedOpen && (
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
                  )}

                  {/* Round 17 — "Save style": persists the current style/reference look
                      (style + theme + accent + reference thumbnail) into the "Saved styles"
                      library section. FORCES kind:"style" (logos save via "Save logo" beside
                      the uploader; names via "Save name"). Available whenever there's a look
                      worth keeping — a logo, an uploaded reference, or a brand color. */}
                  {(logoUrl || aestheticRefMediaId || accentColor) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title="Save the current style / reference look"
                      onClick={async () => {
                        const name = window.prompt("Name this style:");
                        if (!name?.trim()) return;
                        await createTemplate.mutateAsync({
                          name: name.trim(),
                          kind: "style",
                          style: creativeStyle,
                          logoMediaId: logoMediaId || undefined,
                          logoPosition,
                          ...(accentColor ? { brandColor: accentColor } : {}),
                          ...(aestheticRefMediaId ? { referenceMediaId: aestheticRefMediaId } : {}),
                          cardSpec: {
                            canvas: { w: 1080, h: 1350 },
                            blocks: [],
                            controls: {
                              theme,
                              ...(accentColor ? { brandColor: accentColor, highlightColor: accentColor } : {}),
                              logoPosition: logoPosition === "top-left" ? "tl" : "tr",
                            },
                          },
                        });
                        utils.creativeTemplate.list.invalidate();
                        toast({ title: "Style saved" });
                      }}
                    >
                      Save style
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
                  for an own-image static post — theme only styles the AI image.
                  Shown only when Advanced is open (auto-set from style reference). */}
              {advancedOpen && ((format === "static" && !useOwnImage) || format === "carousel" || format === "reel" || format === "ai_video") && (
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
                  <p className="text-xs text-muted-foreground py-2">No channels match &ldquo;{channelSearch}&rdquo;</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {selectedChannelIds.length} channel{selectedChannelIds.length !== 1 ? "s" : ""} selected for publishing
              </p>
            </div>
          )}

          {/* AI Text Provider — governs captions/headline/hook ONLY. Images are
              created by a separate image engine (Gemini → OpenAI fallback) that
              this control does NOT select; that's surfaced in the result card. */}
          <div className="w-64 space-y-1.5">
            <Label>AI Text Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as typeof providers[number])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(PROVIDER_LABELS) as [typeof providers[number], string][]).map(([value, label]) => {
                  const configured = aiConfig ? (aiConfig as Record<string, boolean>)[value] !== false : true;
                  return (
                    <SelectItem key={value} value={value} disabled={!configured}>
                      <span className="flex items-center gap-2">
                        {label}
                        {!configured && <span className="text-[10px] text-muted-foreground">Not configured</span>}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Writes captions &amp; headlines. Images are created by our image
              engine (Gemini, with OpenAI fallback) — not this setting.
            </p>
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
                  {results.format === "ai_video" ? "Cinematic AI video with text slides, visuals & music by Veo3" : results.format === "seedance_video" ? "Cinematic 2K video with native audio by Seedance 2.0" : results.format === "reel" ? "AI-generated video with slides" : results.format === "static" ? (results.bgSource === "real" ? "Made from the article's own photo with your branding" : results.bgSource === "branded" ? "Branded background" : results.bgSource === "ai" ? "AI-generated background with your branding" : "Your post image") : (results.imageEngines && results.imageEngines.length === 0 ? "Slides made from the article's photo and branded backgrounds (AI image was unavailable)" : "Swipe through carousel slides")}
                </CardDescription>
                <ImageEngineChip
                  engines={results.imageEngines ?? (results.bgSource === "ai" && results.imageEngine ? [results.imageEngine] : [])}
                  label={results.format === "reel" ? "Slide images created by" : results.format === "carousel" ? "Images created by" : "Image created by"}
                />
                {results.mimicryEngine === "gemini-composite" && (
                  <p className="text-[11px] font-medium text-emerald-600">
                    ✓ Recreated from your reference with your real photo (Google Gemini)
                  </p>
                )}
                {results.mimicryEngine === "gemini-img2img" && (
                  <p className="text-[11px] font-medium text-emerald-600">
                    ✓ Recreated from your reference (Google Gemini)
                  </p>
                )}
                {results.mimicryEngine === "layout-extract" && (
                  <p className="text-[11px] font-medium text-emerald-600">
                    ✓ Recreated your reference&apos;s layout with your real photo
                  </p>
                )}
                {results.mimicryEngine === "openai-described" && (
                  <p className="text-[11px] font-medium text-amber-600">
                    Styled after your reference (AI approximation)
                  </p>
                )}
                {referenceMimicry && aestheticRefUrl && results.mimicryEngine == null && results.format !== "reel" && results.format !== "ai_video" && results.format !== "seedance_video" && (
                  <p className="text-[11px] text-muted-foreground">
                    Style approximated with a template (AI recreation was unavailable)
                  </p>
                )}
                {results.referenceApplied && !results.mimicryEngine && (
                  <p className="text-[11px] text-muted-foreground">
                    Style reference applied for theme &amp; accent
                    {results.appliedTheme ? ` · ${results.appliedTheme} theme` : ""}
                    {results.usedRealPhoto ? " · using the article's real photo" : ""}
                  </p>
                )}
                {Object.keys(imageAssignments).length > 0 && (
                  <p className="text-[11px] text-muted-foreground">Includes your uploaded image(s) for the slot(s) you assigned.</p>
                )}
                {results.heroPhotoMissing && (
                  <p className="text-[11px] font-medium text-amber-600">
                    We couldn&apos;t load the article&apos;s photo — the card uses your brand background. Add your own photo via Replace/adjust photo for a richer card.
                  </p>
                )}
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
                    {/* Feature 3 — Inline headline edit. Edit text → Regenerate applies it. */}
                    <div className="w-full max-w-xs space-y-1">
                      <Label className="text-xs text-muted-foreground" htmlFor="edited-headline">Headline</Label>
                      <Input
                        id="edited-headline"
                        value={editedHeadline}
                        onChange={(e) => setEditedHeadline(e.target.value)}
                        placeholder="Edit headline before regenerating…"
                        className="text-sm"
                      />
                      <p className="text-[10px] text-muted-foreground">Edit headline, pick font &amp; color, then click Regenerate to re-render.</p>
                    </div>

                    {/* Round 15 — Headline font picker (dropdown of all 14 fonts).
                        Radix Select forbids an empty-string item value, so the
                        "Auto" option uses a "__auto__" sentinel mapped to "". */}
                    <div className="w-full max-w-xs space-y-1">
                      <Label className="text-xs text-muted-foreground">Headline font</Label>
                      <Select
                        value={headlineFont || "__auto__"}
                        onValueChange={(v) => setHeadlineFont(v === "__auto__" ? "" : (v as HeadlineFont))}
                      >
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue placeholder="Auto (match reference)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto__">Auto (match reference)</SelectItem>
                          {HEADLINE_FONT_OPTIONS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Round 15 — Headline text-color picker.
                        Primary control is the full native OS color picker; the
                        White/Dark swatches are quick shortcuts beside it. */}
                    <div className="w-full max-w-xs space-y-1">
                      <Label className="text-xs text-muted-foreground">Headline text color</Label>
                      <div className="flex items-center gap-2">
                        {/* Primary: full native color picker */}
                        <input
                          type="color"
                          value={headlineColor || "#ffffff"}
                          onChange={(e) => setHeadlineColor(e.target.value)}
                          className="h-9 w-16 cursor-pointer rounded border border-border bg-background p-0"
                          title="Pick any color"
                          aria-label="Pick any headline text color"
                        />
                        {/* Quick swatches */}
                        <button
                          type="button"
                          title="White"
                          onClick={() => setHeadlineColor("#ffffff")}
                          className={`h-8 w-8 rounded border-2 bg-white transition-colors ${headlineColor === "#ffffff" ? "border-primary" : "border-border"}`}
                        />
                        <button
                          type="button"
                          title="Dark"
                          onClick={() => setHeadlineColor("#0f1419")}
                          className={`h-8 w-8 rounded border-2 bg-[#0f1419] transition-colors ${headlineColor === "#0f1419" ? "border-primary" : "border-border"}`}
                        />
                        {/* Auto/reset */}
                        {headlineColor && (
                          <button
                            type="button"
                            onClick={() => setHeadlineColor("")}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
                          >
                            Auto
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Pick any color</p>
                    </div>

                    {/* Round 17 — Headline alignment override (Auto = use the
                        reference's detected alignment). */}
                    <div className="w-full max-w-xs space-y-1">
                      <Label className="text-xs text-muted-foreground">Headline alignment</Label>
                      <div className="flex items-center gap-2">
                        {([
                          { value: "left", label: "Left" },
                          { value: "center", label: "Center" },
                          { value: "right", label: "Right" },
                        ] as const).map((a) => (
                          <button
                            key={a.value}
                            type="button"
                            title={a.label}
                            onClick={() => setHeadlineAlign(a.value)}
                            className={`rounded border px-3 py-1 text-xs transition-colors ${headlineAlign === a.value ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}
                          >
                            {a.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          title="Auto (match reference)"
                          onClick={() => setHeadlineAlign("")}
                          className={`rounded border px-3 py-1 text-xs transition-colors ${headlineAlign === "" ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}
                        >
                          Auto
                        </button>
                      </div>
                    </div>

                    {/* Round 17 — Brand name (eyebrow/label) color. Mirrors the
                        headline text-color picker; Auto = use the theme/reference default. */}
                    <div className="w-full max-w-xs space-y-1">
                      <Label className="text-xs text-muted-foreground">Brand name color</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={labelColor || "#ffffff"}
                          onChange={(e) => setLabelColor(e.target.value)}
                          className="h-9 w-16 cursor-pointer rounded border border-border bg-background p-0"
                          title="Pick any color"
                          aria-label="Pick any brand name color"
                        />
                        <button
                          type="button"
                          title="White"
                          onClick={() => setLabelColor("#ffffff")}
                          className={`h-8 w-8 rounded border-2 bg-white transition-colors ${labelColor === "#ffffff" ? "border-primary" : "border-border"}`}
                        />
                        <button
                          type="button"
                          title="Dark"
                          onClick={() => setLabelColor("#0f1419")}
                          className={`h-8 w-8 rounded border-2 bg-[#0f1419] transition-colors ${labelColor === "#0f1419" ? "border-primary" : "border-border"}`}
                        />
                        {labelColor && (
                          <button
                            type="button"
                            onClick={() => setLabelColor("")}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
                          >
                            Auto
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Round 17 — Logo size (4–40). Only meaningful when a logo is
                        set; Auto = the engine's shape-aware default. */}
                    {logoUrl && (
                      <div className="w-full max-w-xs space-y-1">
                        <Label className="text-xs text-muted-foreground">Logo size</Label>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={4}
                            max={40}
                            value={typeof logoSize === "number" ? logoSize : 12}
                            onChange={(e) => setLogoSize(Number(e.target.value))}
                            className="h-2 flex-1 cursor-pointer"
                            aria-label="Logo size"
                          />
                          <span className="w-8 text-right text-xs text-muted-foreground">
                            {typeof logoSize === "number" ? logoSize : "Auto"}
                          </span>
                          {typeof logoSize === "number" && (
                            <button
                              type="button"
                              onClick={() => setLogoSize("")}
                              className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
                            >
                              Auto
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-2 flex-wrap justify-center">
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
                      {/* FIX C: hero photo editor toggle */}
                      <button
                        type="button"
                        onClick={() => setHeroEditorOpen((v) => !v)}
                        title="Replace or adjust the hero photo"
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
                      >
                        <Crop className="h-4 w-4" />
                        {heroEditorOpen ? "Close photo editor" : "Replace / adjust photo"}
                      </button>
                    </div>

                    {/* FIX C — Hero photo editor panel */}
                    {heroEditorOpen && (() => {
                      const PREVIEW_W = 270;
                      const PREVIEW_H = 337; // 270 * (5/4) = 337.5 ≈ 4:5

                      /**
                       * Load a source into heroImgRef so canvas can read it without taint.
                       *
                       * - For an article HTTPS URL: route through the same-origin
                       *   /api/proxy-image endpoint. The server fetches the image (SSRF-gated)
                       *   and returns it from our own origin, so the <img> is never cross-
                       *   origin and toBlob() / drawImage() never throw "operation is insecure".
                       *   We use this proxied URL for BOTH the preview and the canvas export.
                       *
                       * - For a data: URL (already same-origin by construction): load directly.
                       *
                       * The old "reload without crossOrigin" fallback is REMOVED — that path
                       * was the canvas-taint bug itself (the CORS-failed img taints the canvas).
                       */
                      const loadHeroSrc = (src: string) => {
                        setHeroZoom(1);
                        setHeroOffsetX(0);
                        setHeroOffsetY(0);

                        // Choose the URL to actually set on <img> / heroSrcUrl.
                        // data: URLs are already same-origin; everything else goes via the proxy.
                        const loadUrl = src.startsWith("data:")
                          ? src
                          : `/api/proxy-image?url=${encodeURIComponent(src)}`;

                        setHeroSrcUrl(loadUrl);
                        const img = new window.Image();
                        img.onload = () => { heroImgRef.current = img; };
                        img.onerror = () => {
                          toast({
                            title: "Couldn't load this image — try another",
                            description: "The image could not be fetched via the server proxy.",
                            variant: "destructive",
                          });
                          setHeroSrcUrl(null);
                          heroImgRef.current = null;
                        };
                        img.src = loadUrl;
                      };

                      /** Export the cropped region to canvas → upload → assign to background slot. */
                      const applyHeroCrop = async () => {
                        const img = heroImgRef.current;
                        if (!img || !heroSrcUrl) return;
                        setHeroUploading(true);
                        try {
                          const canvas = document.createElement("canvas");
                          canvas.width = 1080;
                          canvas.height = 1350;
                          const ctx2 = canvas.getContext("2d");
                          if (!ctx2) throw new Error("Canvas unavailable");

                          // Compute the source rectangle from zoom/offset.
                          // At zoom=1 the image fills the preview box; higher zoom
                          // crops in. offsetX/Y are deltas in preview-px.
                          const naturalW = img.naturalWidth;
                          const naturalH = img.naturalHeight;
                          // Scale so image covers the preview box at zoom=1.
                          const baseScale = Math.max(PREVIEW_W / naturalW, PREVIEW_H / naturalH);
                          const effScale = baseScale * heroZoom;
                          // Displayed dimensions in preview-px
                          const dispW = naturalW * effScale;
                          const dispH = naturalH * effScale;
                          // Top-left corner of the image in preview-px (offset from center)
                          const imgLeft = (PREVIEW_W - dispW) / 2 + heroOffsetX;
                          const imgTop  = (PREVIEW_H - dispH) / 2 + heroOffsetY;
                          // Visible source region in natural-px
                          const sx = (-imgLeft) / effScale;
                          const sy = (-imgTop) / effScale;
                          const sw = PREVIEW_W / effScale;
                          const sh = PREVIEW_H / effScale;
                          // Clamp to natural image bounds
                          const csx = Math.max(0, sx);
                          const csy = Math.max(0, sy);
                          const csw = Math.min(sw, naturalW - csx);
                          const csh = Math.min(sh, naturalH - csy);
                          // Fill canvas background first (in case image doesn't cover)
                          ctx2.fillStyle = "#000";
                          ctx2.fillRect(0, 0, 1080, 1350);
                          ctx2.drawImage(img, csx, csy, csw, csh, 0, 0, 1080, 1350);

                          const blob: Blob | null = await new Promise((resolve) =>
                            canvas.toBlob((b) => resolve(b), "image/png"),
                          );
                          if (!blob) throw new Error("Canvas export failed");
                          const fd = new FormData();
                          fd.append("file", blob, "hero-crop.png");
                          fd.append("category", "hero");
                          const resp = await fetch("/api/upload", { method: "POST", body: fd });
                          if (!resp.ok) throw new Error("Upload failed");
                          const { id, url: uploadedUrl } = await resp.json();
                          setImageAssignments((prev) => ({ ...prev, background: { mediaId: id, url: uploadedUrl } }));
                          toast({ title: "Hero photo applied", description: "Click Regenerate to re-render with the new photo." });
                          setHeroEditorOpen(false);
                        } catch (err: any) {
                          toast({ title: "Hero crop failed", description: err?.message, variant: "destructive" });
                        } finally {
                          setHeroUploading(false);
                        }
                      };

                      // Article images filtered to https only
                      const articleImages = (results.extracted?.images ?? []).filter((u) => u.startsWith("https://"));

                      return (
                        <div className="w-full max-w-xs rounded-xl border border-border bg-muted/30 p-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold flex items-center gap-1.5">
                              <Crop className="h-3.5 w-3.5" /> Hero photo editor
                            </p>
                            <button
                              type="button"
                              onClick={() => setHeroEditorOpen(false)}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* Current hero assignment badge */}
                          {imageAssignments["background"] && (
                            <div className="flex items-center gap-2 text-[11px] text-emerald-600 font-medium">
                              <img src={imageAssignments["background"].url} alt="hero" className="h-8 w-8 rounded object-cover border" />
                              Hero assigned — click Regenerate to apply
                              <button
                                type="button"
                                onClick={() => setImageAssignments((p) => { const n = { ...p }; delete n["background"]; return n; })}
                                className="ml-auto text-muted-foreground hover:text-destructive"
                                title="Clear hero assignment"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          )}

                          {/* Article image picker */}
                          {articleImages.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-[10px] text-muted-foreground font-medium">Pick from article</p>
                              <div className="flex gap-1.5 overflow-x-auto pb-1">
                                {articleImages.map((src, i) => (
                                  <button
                                    key={i}
                                    type="button"
                                    onClick={() => loadHeroSrc(src)}
                                    className={`shrink-0 rounded overflow-hidden border-2 transition-colors ${heroSrcUrl === src ? "border-primary" : "border-transparent hover:border-primary/50"}`}
                                    title={`Article image ${i + 1}`}
                                  >
                                    <img src={src} alt={`Article ${i + 1}`} className="h-12 w-12 object-cover" />
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Upload own photo */}
                          <div className="space-y-1">
                            <p className="text-[10px] text-muted-foreground font-medium">Or upload your own</p>
                            <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border border-dashed border-border px-3 py-2 text-xs hover:bg-muted transition-colors">
                              <UploadCloud className="h-3.5 w-3.5 text-muted-foreground" />
                              Choose file
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  e.target.value = "";
                                  if (!file) return;
                                  setHeroUploading(true);
                                  try {
                                    // Read as data URL for the CROPPER — data: URLs are
                                    // same-origin so canvas.toBlob() never throws "insecure".
                                    const dataUrl = await new Promise<string>((resolve, reject) => {
                                      const reader = new FileReader();
                                      reader.onload = () => resolve(reader.result as string);
                                      reader.onerror = reject;
                                      reader.readAsDataURL(file);
                                    });
                                    // Also upload to S3 so a Media id exists for the non-cropped
                                    // fallback (the imageAssignments path needs a mediaId).
                                    const fd = new FormData();
                                    fd.append("file", file);
                                    fd.append("category", "hero");
                                    const resp = await fetch("/api/upload", { method: "POST", body: fd });
                                    if (!resp.ok) throw new Error("Upload failed");
                                    const { id: uploadedId, url: uploadedUrl } = await resp.json();
                                    // Load the data URL into the cropper (taint-safe).
                                    // Store the S3 mediaId so Apply can reference it if needed.
                                    (heroImgRef as any)._uploadedMediaId = uploadedId;
                                    (heroImgRef as any)._uploadedUrl = uploadedUrl;
                                    loadHeroSrc(dataUrl);
                                  } catch {
                                    toast({ title: "Upload failed", variant: "destructive" });
                                  } finally {
                                    setHeroUploading(false);
                                  }
                                }}
                              />
                            </label>
                          </div>

                          {/* Crop / pan / zoom editor */}
                          {heroSrcUrl && (
                            <div className="space-y-2">
                              <p className="text-[10px] text-muted-foreground font-medium">Crop &amp; frame (drag to pan, slider to zoom)</p>
                              {/* Preview box — 4:5 aspect, 270×337 */}
                              <div
                                className="relative overflow-hidden rounded-lg border border-border mx-auto bg-black cursor-grab active:cursor-grabbing select-none"
                                style={{ width: PREVIEW_W, height: PREVIEW_H }}
                                onPointerDown={(e) => {
                                  heroDragRef.current = { startX: e.clientX, startY: e.clientY, ox: heroOffsetX, oy: heroOffsetY };
                                  (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                                }}
                                onPointerMove={(e) => {
                                  if (!heroDragRef.current) return;
                                  const dx = e.clientX - heroDragRef.current.startX;
                                  const dy = e.clientY - heroDragRef.current.startY;
                                  setHeroOffsetX(heroDragRef.current.ox + dx);
                                  setHeroOffsetY(heroDragRef.current.oy + dy);
                                }}
                                onPointerUp={() => { heroDragRef.current = null; }}
                              >
                                <img
                                  src={heroSrcUrl}
                                  alt="Hero preview"
                                  draggable={false}
                                  style={{
                                    position: "absolute",
                                    width: "100%",
                                    height: "100%",
                                    objectFit: "cover",
                                    transform: `scale(${heroZoom}) translate(${heroOffsetX / heroZoom}px, ${heroOffsetY / heroZoom}px)`,
                                    transformOrigin: "center center",
                                    userSelect: "none",
                                    pointerEvents: "none",
                                  }}
                                />
                              </div>
                              {/* Zoom slider */}
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground w-8">Zoom</span>
                                <input
                                  type="range"
                                  min={1}
                                  max={3}
                                  step={0.05}
                                  value={heroZoom}
                                  onChange={(e) => setHeroZoom(Number(e.target.value))}
                                  className="flex-1 h-1.5 accent-primary"
                                />
                                <span className="text-[10px] text-muted-foreground w-8 text-right">{heroZoom.toFixed(1)}×</span>
                              </div>
                              {/* Apply button */}
                              <Button
                                type="button"
                                size="sm"
                                className="w-full"
                                disabled={heroUploading}
                                onClick={applyHeroCrop}
                              >
                                {heroUploading ? (
                                  <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Applying…</>
                                ) : (
                                  <>Apply hero photo</>
                                )}
                              </Button>
                              <p className="text-[10px] text-muted-foreground text-center">
                                Crops to 1080×1350 (4:5) and re-renders your post.
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })()}
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
                          {/* REP-2: per-slide text editor for body/content slides (i >= 1). */}
                          {(() => {
                            // Positional match: carouselSlides[i] aligns with the
                            // compacted mediaUrls[i] (both skip failed slides together).
                            const slide = results.carouselSlides?.[i];
                            if (!slide || slide.role === "cta") return null;
                            return (
                              <div className="mt-2 space-y-1.5 w-full">
                                <Input
                                  value={slideEdits[i]?.title ?? slide.title ?? ""}
                                  onChange={(e) =>
                                    setSlideEdits((prev) => ({
                                      ...prev,
                                      [i]: { ...prev[i], title: e.target.value },
                                    }))
                                  }
                                  placeholder="Slide title…"
                                  className="text-xs h-7"
                                />
                                {slide.role === "body" && (
                                  <Textarea
                                    value={slideEdits[i]?.body ?? slide.body ?? ""}
                                    onChange={(e) =>
                                      setSlideEdits((prev) => ({
                                        ...prev,
                                        [i]: { ...prev[i], body: e.target.value },
                                      }))
                                    }
                                    placeholder="Slide body…"
                                    className="text-xs min-h-[56px] resize-none"
                                    rows={3}
                                  />
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleRegenerate(i)}
                                  disabled={regenTarget !== null}
                                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
                                >
                                  {regenTarget === i ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <RefreshCw className="h-3 w-3" />
                                  )}
                                  Regenerate
                                </button>
                              </div>
                            );
                          })()}
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
