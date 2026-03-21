"use client";

import { useState, useRef, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Separator } from "~/components/ui/separator";
import { useToast } from "~/hooks/use-toast";
import { MediaPickerDialog } from "~/components/media-picker-dialog";
import {
  Loader2, Zap, CheckCircle2, XCircle, Edit2, Send,
  ChevronDown, ChevronUp, Settings2, Hash, MessageSquare,
  CheckSquare, Square, Download, Image as ImageIcon,
} from "lucide-react";

const TEMPLATE_TYPES = [
  "breaking_news","luxury_news","cinematic","viral_entertainment",
  "paparazzi_stamp","minimal_dark","magazine","quote_typography",
];
const CAPTION_STYLES = [
  "editorial","dramatic","breaking","fan-reaction","insider",
  "minimalist","viral","question-hook","timeline","announcement",
];
const LOGO_POSITIONS    = ["bottom_center","bottom_left","top_left","top_right","footer_strip","timestamp_bar","masthead_style"];
const USERNAME_POSITIONS = ["below_logo","footer_center","lower_third","corner_signature","ticker_strip","watermark_line"];

type GeneratedPayload = {
  channelId:    string;
  channelName:  string;
  username:     string;
  platform:     string;
  avatar:       string | null;
  caption:      string;
  hashtags:     string[];
  cta:          string;
  creativeSpec: {
    template: string; layout: string; gradient: string;
    frameStyle: string; overlayIntensity: string;
    logoPosition: string; usernamePosition: string;
    brandPalette: string; fontFamily: string;
  };
  onImageText:  string;
  logoUsed:     string | null;
  approved:     boolean;
  scheduleTime: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// News Card Templates
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_CONFIGS: Record<string, {
  bg: string; accentColor: string; headlineColor: string;
  subColor: string; overlayBg: string; tag?: string; tagBg?: string;
}> = {
  breaking_news: {
    bg: "linear-gradient(180deg,#0d0000 0%,#1a0000 40%,#0d0000 100%)",
    accentColor: "#ff1a1a", headlineColor: "#ffffff",
    subColor: "#ffaaaa", overlayBg: "rgba(180,0,0,0.85)",
    tag: "⚡ BREAKING", tagBg: "#cc0000",
  },
  luxury_news: {
    bg: "linear-gradient(160deg,#080808 0%,#1a1500 60%,#080808 100%)",
    accentColor: "#c9a84c", headlineColor: "#fff8e7",
    subColor: "#c9a84c", overlayBg: "rgba(0,0,0,0.80)",
    tag: "✦ EXCLUSIVE", tagBg: "transparent",
  },
  cinematic: {
    bg: "linear-gradient(180deg,#000 0%,#0a0a1a 50%,#000 100%)",
    accentColor: "#d4af37", headlineColor: "#ffffff",
    subColor: "#d4af37", overlayBg: "rgba(0,0,0,0.70)",
  },
  viral_entertainment: {
    bg: "linear-gradient(135deg,#1a0033 0%,#2d0052 40%,#0d001a 100%)",
    accentColor: "#c940ff", headlineColor: "#ffffff",
    subColor: "#e896ff", overlayBg: "rgba(100,0,160,0.75)",
    tag: "🔥 VIRAL", tagBg: "#8800cc",
  },
  paparazzi_stamp: {
    bg: "linear-gradient(180deg,#080808 0%,#111 100%)",
    accentColor: "#ff6600", headlineColor: "#ffffff",
    subColor: "#ff9955", overlayBg: "rgba(0,0,0,0.75)",
    tag: "📸 SPOTTED", tagBg: "#cc4400",
  },
  minimal_dark: {
    bg: "linear-gradient(180deg,#000 0%,#0a0a0a 100%)",
    accentColor: "#ffffff", headlineColor: "#ffffff",
    subColor: "#888888", overlayBg: "rgba(0,0,0,0.60)",
  },
  magazine: {
    bg: "linear-gradient(180deg,#0c0c0c 0%,#1a1a1a 55%,#0c0c0c 100%)",
    accentColor: "#e8e8e8", headlineColor: "#ffffff",
    subColor: "#aaaaaa", overlayBg: "rgba(0,0,0,0.65)",
    tag: "MAGAZINE", tagBg: "transparent",
  },
  quote_typography: {
    bg: "linear-gradient(135deg,#050510 0%,#0a0a20 100%)",
    accentColor: "#4a9eff", headlineColor: "#ffffff",
    subColor: "#4a9eff", overlayBg: "rgba(0,0,30,0.70)",
  },
};

const NewsCard = ({
  cardRef, template, headline, channelName, username, logoUrl, date, size = "preview",
}: {
  cardRef?: React.RefObject<HTMLDivElement>;
  template: string;
  headline: string;
  channelName: string;
  username: string;
  logoUrl?: string | null;
  date?: string;
  size?: "preview" | "full";
}) => {
  const cfg = TEMPLATE_CONFIGS[template] ?? TEMPLATE_CONFIGS.cinematic;
  const w = size === "full" ? 540 : 240;
  const h = Math.round(w * (5 / 4));
  const scale = w / 540;

  const fs = (base: number) => Math.round(base * scale);
  const today = date ?? new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div
      ref={cardRef}
      style={{
        width: w, height: h, position: "relative", overflow: "hidden",
        borderRadius: size === "full" ? 0 : 10,
        background: cfg.bg, fontFamily: "'Arial Black', 'Arial Bold', Arial, sans-serif",
        flexShrink: 0,
      }}
    >
      {/* Top accent bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        height: fs(4), background: cfg.accentColor,
      }} />

      {/* Top tag badge */}
      {cfg.tag && (
        <div style={{
          position: "absolute", top: fs(14), left: fs(14),
          background: cfg.tagBg || cfg.accentColor,
          border: cfg.tagBg === "transparent" ? `1px solid ${cfg.accentColor}` : "none",
          color: cfg.tagBg === "transparent" ? cfg.accentColor : "#fff",
          padding: `${fs(4)}px ${fs(10)}px`,
          borderRadius: fs(3),
          fontSize: fs(10), fontWeight: 800,
          letterSpacing: "0.08em",
          textTransform: "uppercase" as const,
        }}>
          {cfg.tag}
        </div>
      )}

      {/* Main content area */}
      <div style={{
        position: "absolute",
        top: fs(cfg.tag ? 50 : 30),
        left: fs(14), right: fs(14),
        bottom: fs(90),
        display: "flex", flexDirection: "column", justifyContent: "center",
        gap: fs(10),
      }}>
        {/* Accent line */}
        <div style={{ width: fs(32), height: fs(3), background: cfg.accentColor, borderRadius: 2 }} />

        {/* Headline */}
        <div style={{
          color: cfg.headlineColor,
          fontSize: fs(template === "minimal_dark" ? 28 : template === "magazine" ? 24 : 21),
          fontWeight: 900,
          lineHeight: 1.2,
          letterSpacing: template === "minimal_dark" ? "-0.02em" : "0",
          textTransform: template === "magazine" ? "uppercase" as const : "none" as const,
          wordBreak: "break-word" as const,
        }}>
          {headline}
        </div>

        {/* Quote marks for quote_typography */}
        {template === "quote_typography" && (
          <div style={{
            color: cfg.accentColor, fontSize: fs(48), lineHeight: 0.5,
            fontFamily: "Georgia, serif", opacity: 0.4,
            position: "absolute", top: fs(-8), left: fs(-4),
          }}>
            "
          </div>
        )}

        {/* Date */}
        <div style={{
          color: cfg.subColor, fontSize: fs(9),
          letterSpacing: "0.1em", textTransform: "uppercase" as const,
          marginTop: fs(4),
        }}>
          {today}
        </div>
      </div>

      {/* Bottom overlay / footer */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        height: fs(80),
        background: cfg.overlayBg,
        backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center",
        padding: `${fs(8)}px ${fs(14)}px`,
        gap: fs(10),
        borderTop: `1px solid ${cfg.accentColor}33`,
      }}>
        {/* Logo */}
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={channelName}
            style={{
              width: fs(36), height: fs(36),
              objectFit: "contain", borderRadius: fs(4),
              flexShrink: 0,
            }}
            crossOrigin="anonymous"
          />
        ) : (
          <div style={{
            width: fs(36), height: fs(36), borderRadius: fs(4),
            background: cfg.accentColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 900, fontSize: fs(14), flexShrink: 0,
          }}>
            {channelName[0]?.toUpperCase()}
          </div>
        )}

        {/* Channel info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            color: "#fff", fontWeight: 700,
            fontSize: fs(11), lineHeight: 1.2,
            whiteSpace: "nowrap" as const, overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {channelName}
          </div>
          <div style={{
            color: cfg.subColor, fontSize: fs(9),
            fontWeight: 400, letterSpacing: "0.05em",
          }}>
            @{username}
          </div>
        </div>

        {/* Bottom accent dot */}
        <div style={{
          width: fs(6), height: fs(6), borderRadius: "50%",
          background: cfg.accentColor, flexShrink: 0,
        }} />
      </div>

      {/* Bottom accent bar */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        height: fs(3), background: cfg.accentColor,
      }} />
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Export card as PNG via html2canvas
// ─────────────────────────────────────────────────────────────────────────────
async function exportCardAsPng(
  template: string, headline: string, channelName: string,
  username: string, logoUrl: string | null, channelId: string,
): Promise<void> {
  const html2canvas = (await import("html2canvas")).default;
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:-9999px;top:0;z-index:9999;";
  document.body.appendChild(container);

  const { createRoot } = await import("react-dom/client");
  const React = await import("react");
  const root = createRoot(container);
  const cardRef = { current: null as HTMLDivElement | null };

  await new Promise<void>((resolve) => {
    root.render(
      React.createElement(NewsCard, {
        cardRef: cardRef as any,
        template, headline, channelName, username,
        logoUrl, size: "full",
      })
    );
    setTimeout(resolve, 300);
  });

  if (cardRef.current) {
    const canvas = await html2canvas(cardRef.current, {
      scale: 2, useCORS: true, allowTaint: false, backgroundColor: null,
    });
    const link = document.createElement("a");
    link.download = `${channelName.replace(/\s+/g, "_")}_${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  root.unmount();
  document.body.removeChild(container);
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel Profile Modal (with logo picker from media library)
// ─────────────────────────────────────────────────────────────────────────────
function ChannelProfileModal({ channel, onClose, onSave }: {
  channel: any;
  onClose: () => void;
  onSave: (data: any) => void;
}) {
  const profile = (channel.metadata as any) ?? {};
  const [form, setForm] = useState({
    logo_path:         profile.logo_path ?? "",
    font_family:       profile.font_family ?? "sans-serif",
    brand_palette:     profile.brand_palette ?? "",
    caption_style:     profile.caption_style ?? "editorial",
    template_type:     profile.template_type ?? "cinematic",
    logo_position:     profile.logo_position ?? "bottom_center",
    username_position: profile.username_position ?? "below_logo",
    language_style:    profile.language_style ?? "EN",
  });
  const [showLogoPicker, setShowLogoPicker] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-lg font-semibold">Brand Profile — {channel.name}</h3>
        <div className="space-y-3">

          {/* Logo picker */}
          <div className="space-y-1.5">
            <Label>Channel Logo</Label>
            <div className="flex items-center gap-2">
              {form.logo_path && (
                <img src={form.logo_path} alt="logo" className="h-10 w-10 rounded-md object-contain border bg-muted" />
              )}
              <div className="flex flex-1 gap-2">
                <Input
                  value={form.logo_path}
                  onChange={(e) => setForm((p) => ({ ...p, logo_path: e.target.value }))}
                  placeholder="https://… or pick from library"
                  className="text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() => setShowLogoPicker(true)}
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  Library
                </Button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Caption Style</Label>
              <Select value={form.caption_style} onValueChange={(v) => setForm((p) => ({ ...p, caption_style: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{CAPTION_STYLES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Template</Label>
              <Select value={form.template_type} onValueChange={(v) => setForm((p) => ({ ...p, template_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TEMPLATE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Logo Position</Label>
              <Select value={form.logo_position} onValueChange={(v) => setForm((p) => ({ ...p, logo_position: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{LOGO_POSITIONS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Username Position</Label>
              <Select value={form.username_position} onValueChange={(v) => setForm((p) => ({ ...p, username_position: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{USERNAME_POSITIONS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Brand Palette</Label>
            <Input value={form.brand_palette} onChange={(e) => setForm((p) => ({ ...p, brand_palette: e.target.value }))} placeholder="e.g. gold, red-black, purple" />
          </div>

          <div>
            <Label>Font Family</Label>
            <Input value={form.font_family} onChange={(e) => setForm((p) => ({ ...p, font_family: e.target.value }))} placeholder="e.g. Playfair Display, Roboto" />
          </div>
        </div>

        {/* Template preview */}
        <div className="mt-4">
          <Label className="text-xs text-muted-foreground">Preview</Label>
          <div className="mt-1.5">
            <NewsCard
              template={form.template_type}
              headline="Hardik Pandya spotted at Naman Awards 2026"
              channelName={channel.name}
              username={channel.username ?? channel.name.toLowerCase().replace(/\s/g, "")}
              logoUrl={form.logo_path || null}
              size="preview"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(form)}>Save Profile</Button>
        </div>
      </div>

      {showLogoPicker && (
        <MediaPickerDialog
          open={showLogoPicker}
          onOpenChange={setShowLogoPicker}
          onSelect={(url) => {
            setForm((p) => ({ ...p, logo_path: url }));
            setShowLogoPicker(false);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function NewsGridPage() {
  const { toast } = useToast();

  const [headline, setHeadline]             = useState("");
  const [summary, setSummary]               = useState("");
  const [contentType, setContentType]       = useState("celebrity");
  const [celebName, setCelebName]           = useState("");
  const [eventName, setEventName]           = useState("");
  const [location, setLocation]             = useState("");
  const [moodStyle, setMoodStyle]           = useState("");
  const [includeHashtags, setIncludeHashtags] = useState(true);
  const [includeCTA, setIncludeCTA]         = useState(true);
  const [language, setLanguage]             = useState<"EN"|"HI"|"MIX">("EN");
  const [provider, setProvider]             = useState<"openai"|"anthropic"|"gemini"|"grok"|"deepseek">("openai");
  const [postFormat, setPostFormat]         = useState<"single"|"carousel"|"reel"|"story">("single");
  const [showOptional, setShowOptional]     = useState(false);
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(new Set());
  const [profileModal, setProfileModal]     = useState<any>(null);
  const [results, setResults]               = useState<GeneratedPayload[]>([]);
  const [expandedCards, setExpandedCards]   = useState<Set<string>>(new Set());
  const [editingCaption, setEditingCaption] = useState<Record<string, string>>({});
  const [scheduleMap, setScheduleMap]       = useState<Record<string, string>>({});
  const [step, setStep]                     = useState<"form"|"results">("form");
  const [exportingId, setExportingId]       = useState<string | null>(null);

  const { data: channelsData, isLoading: channelsLoading } = trpc.newsgrid.channelsWithProfiles.useQuery();

  const updateProfile = trpc.newsgrid.updateChannelProfile.useMutation({
    onSuccess: () => { toast({ title: "Profile saved" }); setProfileModal(null); },
  });

  const generate = trpc.newsgrid.generate.useMutation({
    onSuccess: (data) => {
      setResults(data.results as GeneratedPayload[]);
      const sm: Record<string, string> = {};
      data.results.forEach((r: any) => { sm[r.channelId] = ""; });
      setScheduleMap(sm);
      setStep("results");
    },
    onError: (err) => toast({ title: "Generation failed", description: err.message, variant: "destructive" }),
  });

  const bulkPublish = trpc.newsgrid.bulkPublish.useMutation({
    onSuccess: (data) => {
      toast({ title: `Published ${data.count} posts`, description: "Posts queued successfully." });
      setResults([]); setStep("form");
    },
    onError: (err) => toast({ title: "Publish failed", description: err.message, variant: "destructive" }),
  });

  const channels = channelsData ?? [];
  const instagramChannels = channels.filter((c) => c.platform === "INSTAGRAM");
  const allSelected = instagramChannels.length > 0 && instagramChannels.every((c) => selectedChannelIds.has(c.id));

  const toggleChannel = (id: string) => {
    setSelectedChannelIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelectedChannelIds(new Set());
    else setSelectedChannelIds(new Set(instagramChannels.map((c) => c.id)));
  };

  const handleGenerate = () => {
    if (!headline.trim()) { toast({ title: "Headline required", variant: "destructive" }); return; }
    if (selectedChannelIds.size === 0) { toast({ title: "Select at least one channel", variant: "destructive" }); return; }
    generate.mutate({
      headline, summary, contentType, celebName, eventName, location,
      moodStyle, includeHashtags, includeCTA, language, provider, postFormat,
      channelIds: [...selectedChannelIds],
    });
  };

  const approvedResults = results.filter((r) => r.approved);

  const handleBulkPublish = () => {
    if (approvedResults.length === 0) { toast({ title: "Approve at least one channel result", variant: "destructive" }); return; }
    bulkPublish.mutate({
      headline,
      payloads: approvedResults.map((r) => ({
        channelId:    r.channelId,
        caption:      editingCaption[r.channelId] ?? r.caption,
        hashtags:     r.hashtags,
        cta:          r.cta,
        scheduleTime: scheduleMap[r.channelId] || null,
      })),
    });
  };

  const toggleApprove    = (id: string) => setResults((p) => p.map((r) => r.channelId === id ? { ...r, approved: !r.approved } : r));
  const approveAll       = () => setResults((p) => p.map((r) => ({ ...r, approved: true })));
  const unapproveAll     = () => setResults((p) => p.map((r) => ({ ...r, approved: false })));
  const toggleCard       = (id: string) => setExpandedCards((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const handleExport = async (r: GeneratedPayload) => {
    setExportingId(r.channelId);
    try {
      await exportCardAsPng(r.creativeSpec.template, r.onImageText, r.channelName, r.username, r.logoUsed, r.channelId);
    } catch (e) {
      toast({ title: "Export failed", variant: "destructive" });
    } finally {
      setExportingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Zap className="h-6 w-6 text-yellow-500" />
            NewsGrid Bot
          </h1>
          <p className="text-sm text-muted-foreground">
            One headline → unique branded posts for all your channels
          </p>
        </div>
        {step === "results" && (
          <Button variant="outline" onClick={() => setStep("form")}>← Back to Form</Button>
        )}
      </div>

      {step === "form" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          {/* Left: Form */}
          <div className="space-y-5">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">News Input</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Headline <span className="text-destructive">*</span></Label>
                  <Input
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    placeholder="e.g. Hardik Pandya spotted at Naman Awards 2026"
                    className="text-base"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Summary (optional)</Label>
                  <Textarea
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    placeholder="Brief context about the news..."
                    className="min-h-[80px] resize-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Content Type</Label>
                    <Select value={contentType} onValueChange={setContentType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["celebrity","event","breaking","sports","fashion","music","film","paparazzi"].map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Post Format</Label>
                    <Select value={postFormat} onValueChange={(v) => setPostFormat(v as any)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["single","carousel","reel","story"].map((f) => (
                          <SelectItem key={f} value={f}>{f}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <button
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setShowOptional((v) => !v)}
                >
                  {showOptional ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  Optional fields
                </button>
                {showOptional && (
                  <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Celebrity Name</Label>
                        <Input value={celebName} onChange={(e) => setCelebName(e.target.value)} placeholder="e.g. Hardik Pandya" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Event Name</Label>
                        <Input value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="e.g. Naman Awards 2026" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Location</Label>
                        <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Mumbai" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Mood / Style</Label>
                        <Input value={moodStyle} onChange={(e) => setMoodStyle(e.target.value)} placeholder="e.g. glamorous" />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Language</Label>
                        <Select value={language} onValueChange={(v) => setLanguage(v as any)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="EN">English</SelectItem>
                            <SelectItem value="HI">Hindi</SelectItem>
                            <SelectItem value="MIX">Hinglish</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">AI Provider</Label>
                        <Select value={provider} onValueChange={(v) => setProvider(v as any)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {["openai","anthropic","gemini","grok","deepseek"].map((p) => (
                              <SelectItem key={p} value={p}>{p}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      <div className="flex items-center gap-2">
                        <Switch checked={includeHashtags} onCheckedChange={setIncludeHashtags} />
                        <Label className="text-xs">Include Hashtags</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={includeCTA} onCheckedChange={setIncludeCTA} />
                        <Label className="text-xs">Include CTA</Label>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Button
              className="w-full gap-2" size="lg"
              onClick={handleGenerate}
              disabled={generate.isPending || selectedChannelIds.size === 0 || !headline.trim()}
            >
              {generate.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Generating for {selectedChannelIds.size} channels…</>
              ) : (
                <><Zap className="h-4 w-4" /> Generate for {selectedChannelIds.size} channel{selectedChannelIds.size !== 1 ? "s" : ""}</>
              )}
            </Button>
          </div>

          {/* Right: Channel Selector */}
          <Card className="h-fit">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Instagram Channels
                  {selectedChannelIds.size > 0 && (
                    <Badge className="ml-2" variant="secondary">{selectedChannelIds.size} selected</Badge>
                  )}
                </CardTitle>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={toggleAll}>
                  {allSelected ? <><Square className="mr-1 h-3 w-3" />Deselect all</> : <><CheckSquare className="mr-1 h-3 w-3" />Select all</>}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {channelsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : instagramChannels.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No Instagram channels connected.</p>
              ) : (
                <div className="max-h-[480px] space-y-1 overflow-y-auto pr-1">
                  {instagramChannels.map((channel) => {
                    const isSelected = selectedChannelIds.has(channel.id);
                    const profile = (channel.metadata as any) ?? {};
                    const logoUrl = profile.logo_path || null;
                    return (
                      <div
                        key={channel.id}
                        className={`flex items-center gap-3 rounded-lg border p-2.5 transition-colors cursor-pointer ${isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                        onClick={() => toggleChannel(channel.id)}
                      >
                        <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isSelected ? "border-primary bg-primary" : "border-muted-foreground"}`}>
                          {isSelected && <CheckCircle2 className="h-3 w-3 text-primary-foreground" />}
                        </div>
                        {/* Logo or avatar */}
                        {logoUrl ? (
                          <img src={logoUrl} alt="" className="h-8 w-8 rounded-md object-contain border bg-muted" />
                        ) : channel.avatar ? (
                          <img src={channel.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-bold">
                            {channel.name[0]}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{channel.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {profile.caption_style ?? "editorial"} · {profile.template_type ?? "cinematic"}
                            {logoUrl && <span className="ml-1 text-green-600">· logo ✓</span>}
                          </p>
                        </div>
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                          onClick={(e) => { e.stopPropagation(); setProfileModal(channel); }}
                          title="Edit brand profile"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {step === "results" && (
        <div className="space-y-4">
          {/* Bulk actions bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
            <div className="flex items-center gap-3">
              <p className="text-sm font-medium">
                {results.length} channels generated
                {approvedResults.length > 0 && (
                  <span className="ml-2 text-green-600 font-semibold">· {approvedResults.length} approved</span>
                )}
              </p>
              <Button variant="outline" size="sm" onClick={approveAll} className="h-7 text-xs gap-1">
                <CheckCircle2 className="h-3 w-3" />Approve All
              </Button>
              <Button variant="ghost" size="sm" onClick={unapproveAll} className="h-7 text-xs gap-1">
                <XCircle className="h-3 w-3" />Clear
              </Button>
            </div>
            <Button
              onClick={handleBulkPublish}
              disabled={bulkPublish.isPending || approvedResults.length === 0}
              className="gap-2"
            >
              {bulkPublish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Publish {approvedResults.length} approved
            </Button>
          </div>

          {/* Results grid */}
          <div className="space-y-3">
            {results.map((r) => {
              const isExpanded = expandedCards.has(r.channelId);
              const caption = editingCaption[r.channelId] ?? r.caption;
              return (
                <Card
                  key={r.channelId}
                  className={`transition-colors ${r.approved ? "border-green-500/50 bg-green-500/5" : ""}`}
                >
                  <div
                    className="flex cursor-pointer items-center gap-3 p-4"
                    onClick={() => toggleCard(r.channelId)}
                  >
                    {r.avatar ? (
                      <img src={r.avatar} alt="" className="h-10 w-10 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted font-bold">
                        {r.channelName[0]}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{r.channelName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        @{r.username} · {r.creativeSpec.template}
                        {r.logoUsed && <span className="ml-1 text-green-600">· logo ✓</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={r.approved ? "default" : "secondary"} className="text-xs">
                        {r.approved ? "Approved" : "Pending"}
                      </Badge>
                      <Button
                        size="sm" variant={r.approved ? "outline" : "default"}
                        className="h-7 text-xs"
                        onClick={(e) => { e.stopPropagation(); toggleApprove(r.channelId); }}
                      >
                        {r.approved ? "Unapprove" : "Approve"}
                      </Button>
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </div>
                  </div>

                  {isExpanded && (
                    <>
                      <Separator />
                      <div className="grid gap-4 p-4 md:grid-cols-[260px_1fr]">
                        {/* News card preview */}
                        <div className="flex flex-col items-center gap-3">
                          <NewsCard
                            template={r.creativeSpec.template}
                            headline={r.onImageText}
                            channelName={r.channelName}
                            username={r.username}
                            logoUrl={r.logoUsed}
                            size="preview"
                          />
                          <Button
                            variant="outline" size="sm"
                            className="w-full gap-1.5 text-xs"
                            disabled={exportingId === r.channelId}
                            onClick={() => handleExport(r)}
                          >
                            {exportingId === r.channelId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5" />
                            )}
                            Export PNG
                          </Button>
                          <div className="w-full space-y-1 rounded-lg bg-muted/50 p-2 text-xs">
                            <p><span className="text-muted-foreground">Template:</span> {r.creativeSpec.template}</p>
                            <p><span className="text-muted-foreground">Layout:</span> {r.creativeSpec.layout}</p>
                            <p><span className="text-muted-foreground">Frame:</span> {r.creativeSpec.frameStyle}</p>
                          </div>
                        </div>

                        {/* Caption, hashtags, CTA */}
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label className="flex items-center gap-1.5 text-xs">
                              <MessageSquare className="h-3 w-3" />Caption
                            </Label>
                            <Textarea
                              value={caption}
                              onChange={(e) => setEditingCaption((p) => ({ ...p, [r.channelId]: e.target.value }))}
                              className="min-h-[80px] resize-none text-sm"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="flex items-center gap-1.5 text-xs">
                              <Hash className="h-3 w-3" />Hashtags
                            </Label>
                            <div className="flex flex-wrap gap-1">
                              {r.hashtags.map((tag) => (
                                <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                              ))}
                            </div>
                          </div>
                          {r.cta && (
                            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2 text-sm">
                              <span className="text-xs text-muted-foreground">CTA:</span>
                              <span className="font-medium">{r.cta}</span>
                            </div>
                          )}
                          <div className="space-y-1.5">
                            <Label className="text-xs">Schedule Time (optional)</Label>
                            <Input
                              type="datetime-local"
                              value={scheduleMap[r.channelId] ?? ""}
                              onChange={(e) => setScheduleMap((p) => ({ ...p, [r.channelId]: e.target.value }))}
                              min={new Date().toISOString().slice(0, 16)}
                              className="text-xs"
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {profileModal && (
        <ChannelProfileModal
          channel={profileModal}
          onClose={() => setProfileModal(null)}
          onSave={(data) => updateProfile.mutate({ channelId: profileModal.id, ...data })}
        />
      )}
    </div>
  );
}
