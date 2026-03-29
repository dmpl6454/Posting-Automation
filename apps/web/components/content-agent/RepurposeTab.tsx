"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";

const ALL_PLATFORMS = [
  "TWITTER", "LINKEDIN", "INSTAGRAM", "FACEBOOK", "REDDIT", "YOUTUBE",
  "TIKTOK", "PINTEREST", "THREADS", "MASTODON", "BLUESKY", "MEDIUM", "DEVTO",
] as const;

const providers = ["openai", "anthropic", "gemini", "grok", "deepseek"] as const;

const FORMAT_OPTIONS = [
  { id: "static" as const, label: "Static Post", icon: Image, desc: "Single branded image + caption" },
  { id: "carousel" as const, label: "Carousel", icon: Layers, desc: "Multi-slide carousel post" },
  { id: "reel" as const, label: "Reel / Video", icon: Film, desc: "Slideshow video from key points" },
];

const THEMES = [
  { id: "dark" as const, label: "Dark", color: "bg-zinc-900" },
  { id: "light" as const, label: "Light", color: "bg-zinc-100" },
  { id: "gradient" as const, label: "Gradient", color: "bg-gradient-to-r from-indigo-900 to-purple-900" },
];

export function RepurposeTab() {
  const { toast } = useToast();

  // Source mode
  const [sourceMode, setSourceMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [originalContent, setOriginalContent] = useState("");

  // Options
  const [format, setFormat] = useState<"static" | "carousel" | "reel">("static");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["INSTAGRAM", "TWITTER", "LINKEDIN"]);
  const [provider, setProvider] = useState<typeof providers[number]>("gemini");
  const [theme, setTheme] = useState<"dark" | "light" | "gradient">("dark");
  const [voiceOver, setVoiceOver] = useState(true);
  const [voiceType, setVoiceType] = useState<string>("nova");
  const [bgMusic, setBgMusic] = useState(true);

  // Results
  const [results, setResults] = useState<{
    extracted?: { title: string; description: string; siteName: string; type: string; url: string; images?: string[] };
    platformContent: Record<string, string>;
    mediaUrls: string[];
    mediaMap?: Record<string, { url: string; mediaId: string }>;
    mediaType: string;
    format: string;
  } | null>(null);
  const [copiedPlatform, setCopiedPlatform] = useState<string | null>(null);

  // Channel info (for branding)
  const { data: channels } = trpc.channel.list.useQuery();
  const primaryChannel = (channels as any[])?.[0];

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
      toast({ title: "Extraction failed", description: err.message, variant: "destructive" });
    },
  });

  // Text-based repurpose (existing)
  const repurpose = trpc.repurpose.repurpose.useMutation({
    onSuccess: (data) => {
      setResults({ platformContent: data.platformContent, mediaUrls: [], mediaType: "", format: "text" });
      toast({ title: "Content repurposed!" });
    },
    onError: (err) => {
      toast({ title: "Repurpose failed", description: err.message, variant: "destructive" });
    },
  });

  // URL-based repurpose
  const repurposeFromUrl = trpc.repurpose.repurposeFromUrl.useMutation({
    onSuccess: (data) => {
      setResults(data);
      const mediaCount = data.mediaUrls.length;
      toast({
        title: "Content repurposed!",
        description: `${Object.keys(data.platformContent).length} captions + ${mediaCount} ${data.format === "reel" ? "video" : mediaCount === 1 ? "image" : "slides"} generated.`,
      });
    },
    onError: (err) => {
      toast({ title: "Repurpose failed", description: err.message, variant: "destructive" });
    },
  });

  const handleExtractPreview = () => {
    if (!url) return;
    extractMutation.mutate({ url });
  };

  const handleGenerate = () => {
    if (sourceMode === "url") {
      if (!url || selectedPlatforms.length === 0) return;
      repurposeFromUrl.mutate({
        url,
        format,
        targetPlatforms: selectedPlatforms,
        provider,
        channelName: primaryChannel?.name || "Channel",
        channelHandle: primaryChannel?.username || "",
        logoUrl: primaryChannel?.avatar || "",
        theme,
        voiceOver: format === "reel" ? voiceOver : false,
        voiceType: voiceType as any,
        bgMusic: format === "reel" ? bgMusic : false,
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

  const isLoading = repurpose.isPending || repurposeFromUrl.isPending;
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
            Paste a URL or text content to create social media posts, carousels, or reels
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
                <div className="grid grid-cols-3 gap-2">
                  {FORMAT_OPTIONS.map(({ id, label, icon: Icon, desc }) => (
                    <button
                      key={id}
                      onClick={() => setFormat(id)}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all ${
                        format === id
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <Icon className={`h-5 w-5 ${format === id ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="text-xs font-medium">{label}</span>
                      <span className="text-[10px] text-muted-foreground">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Theme (for carousel/reel) */}
              {(format === "carousel" || format === "reel") && (
                <div className="space-y-2">
                  <Label>Slide Theme</Label>
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

              {/* Voice-over & Music (Reel only) */}
              {format === "reel" && (
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
              ? `Generating ${format === "carousel" ? "carousel" : format === "reel" ? "reel" : "post"}...`
              : `Repurpose as ${FORMAT_OPTIONS.find((f) => f.id === format)?.label || "Static Post"}`}
          </Button>
        </CardContent>
      </Card>

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

          {/* Generated Media Preview */}
          {results.mediaUrls.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {results.format === "reel" ? <Film className="h-4 w-4 text-purple-500" /> : results.mediaUrls.length > 1 ? <Layers className="h-4 w-4 text-blue-500" /> : <Image className="h-4 w-4 text-green-500" />}
                  Generated {results.format === "reel" ? "Reel Video" : results.mediaUrls.length > 1 ? `Carousel (${results.mediaUrls.length} slides)` : "Static Post"}
                </CardTitle>
                <CardDescription>
                  {results.format === "reel" ? "AI-generated video with slides" : results.format === "static" ? "AI-generated background with branded overlay" : "Swipe through carousel slides"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {results.mediaType === "video/mp4" ? (
                  <div className="flex justify-center">
                    <video
                      src={results.mediaUrls[0]}
                      controls
                      className="w-full max-w-xs rounded-xl shadow-lg aspect-[4/5]"
                      poster={undefined}
                    />
                  </div>
                ) : results.mediaUrls.length === 1 ? (
                  <div className="flex justify-center">
                    <img
                      src={results.mediaUrls[0]}
                      alt="Generated post"
                      className="w-full max-w-xs rounded-xl shadow-lg"
                    />
                  </div>
                ) : (
                  <div className="flex gap-3 overflow-x-auto pb-3 snap-x snap-mandatory">
                    {results.mediaUrls.map((mediaUrl, i) => (
                      <div key={i} className="shrink-0 snap-center">
                        <div className="relative">
                          <img
                            src={mediaUrl}
                            alt={`Slide ${i + 1}`}
                            className="h-72 rounded-xl shadow-md aspect-[4/5] object-cover"
                          />
                          <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                            {i + 1}/{results.mediaUrls.length}
                          </div>
                        </div>
                      </div>
                    ))}
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
                    <div className="relative">
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
                          const mediaParam = platformImage ? `&aiImage=${encodeURIComponent(platformImage)}` : "";
                          const mediaIdParam = platformMediaId ? `&aiMediaId=${encodeURIComponent(platformMediaId)}` : "";
                          window.location.href = `/dashboard/content-agent?tab=compose&content=${encodeURIComponent(content)}${mediaParam}${mediaIdParam}`;
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

          <div className="flex justify-center">
            <Button
              className="gap-2"
              onClick={() => {
                toast({ title: "Posts created as drafts", description: `${Object.keys(results.platformContent).length} draft posts created.` });
              }}
            >
              <ArrowRight className="h-4 w-4" />
              Create Draft Posts for All Platforms
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
