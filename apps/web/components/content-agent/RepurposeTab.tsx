"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
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
    extracted?: { title: string; description: string; siteName: string; type: string; url: string };
    platformContent: Record<string, string>;
    mediaUrls: string[];
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
        channelName: primaryChannel?.name,
        channelHandle: primaryChannel?.username,
        logoUrl: primaryChannel?.avatar,
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
          {/* Generated Media */}
          {results.mediaUrls.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {results.format === "reel" ? <Film className="h-4 w-4" /> : results.mediaUrls.length > 1 ? <Layers className="h-4 w-4" /> : <Image className="h-4 w-4" />}
                  Generated {results.format === "reel" ? "Reel Video" : results.mediaUrls.length > 1 ? `Carousel (${results.mediaUrls.length} slides)` : "Image"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {results.mediaType === "video/mp4" ? (
                  <video
                    src={results.mediaUrls[0]}
                    controls
                    className="w-full max-w-sm rounded-lg mx-auto aspect-[4/5]"
                  />
                ) : results.mediaUrls.length === 1 ? (
                  <img
                    src={results.mediaUrls[0]}
                    alt="Generated"
                    className="w-full max-w-sm rounded-lg mx-auto aspect-[4/5] object-cover"
                  />
                ) : (
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {results.mediaUrls.map((url, i) => (
                      <img
                        key={i}
                        src={url}
                        alt={`Slide ${i + 1}`}
                        className="h-64 rounded-lg shrink-0 aspect-[4/5] object-cover"
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Platform Captions */}
          <h2 className="text-lg font-semibold">Platform Captions</h2>
          <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
            {Object.entries(results.platformContent).map(([platform, content]) => (
              <Card key={platform} className="border-green-200 bg-green-50/30 dark:border-green-900 dark:bg-green-950/20">
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
                  <div className="whitespace-pre-wrap rounded-lg bg-background p-3 text-sm leading-relaxed">{content}</div>
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => {
                        const mediaParam = results.mediaUrls[0] ? `&aiImage=${encodeURIComponent(results.mediaUrls[0])}` : "";
                        window.location.href = `/dashboard/content-agent?tab=compose&content=${encodeURIComponent(content)}${mediaParam}`;
                      }}
                    >
                      <FileText className="h-3 w-3" />
                      Create Post
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
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
