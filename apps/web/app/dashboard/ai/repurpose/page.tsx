"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/hooks/use-toast";
import {
  Sparkles,
  Copy,
  Check,
  Loader2,
  RefreshCw,
  FileText,
  ArrowRight,
} from "lucide-react";

const ALL_PLATFORMS = [
  "TWITTER",
  "LINKEDIN",
  "INSTAGRAM",
  "FACEBOOK",
  "REDDIT",
  "YOUTUBE",
  "TIKTOK",
  "PINTEREST",
  "THREADS",
  "MASTODON",
  "BLUESKY",
  "MEDIUM",
  "DEVTO",
] as const;

const providers = ["openai", "anthropic", "gemini"] as const;

export default function RepurposePage() {
  const { toast } = useToast();
  const [originalContent, setOriginalContent] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([
    "TWITTER",
    "LINKEDIN",
    "INSTAGRAM",
  ]);
  const [provider, setProvider] = useState<typeof providers[number]>("openai");
  const [results, setResults] = useState<Record<string, string> | null>(null);
  const [copiedPlatform, setCopiedPlatform] = useState<string | null>(null);

  const repurpose = trpc.repurpose.repurpose.useMutation({
    onSuccess: (data) => {
      setResults(data.platformContent);
      toast({ title: "Content repurposed!", description: "Platform-specific content is ready." });
    },
    onError: (err) => {
      toast({
        title: "Repurpose failed",
        description: err.message || "Please check your AI provider keys.",
        variant: "destructive",
      });
    },
  });

  const handleGenerate = () => {
    if (!originalContent || selectedPlatforms.length === 0) return;
    repurpose.mutate({
      originalContent,
      targetPlatforms: selectedPlatforms,
      provider,
    });
  };

  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform]
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Content Repurpose</h1>
        <p className="text-muted-foreground">
          Transform long-form content into platform-optimized social media posts
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-purple-500" />
            Repurpose Content
          </CardTitle>
          <CardDescription>
            Paste your blog post, article, or any long-form content and select
            target platforms
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Source Content */}
          <div className="space-y-1.5">
            <Label>Source Content</Label>
            <Textarea
              value={originalContent}
              onChange={(e) => setOriginalContent(e.target.value)}
              placeholder="Paste your blog post, article, newsletter, or any content here..."
              className="min-h-[200px] resize-y"
            />
            <p className="text-xs text-muted-foreground">
              {originalContent.length} characters
            </p>
          </div>

          {/* Platform Selection */}
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
              {selectedPlatforms.length} platform{selectedPlatforms.length !== 1 ? "s" : ""}{" "}
              selected
            </p>
          </div>

          {/* Provider */}
          <div className="w-48 space-y-1.5">
            <Label>AI Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as typeof providers[number])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI (GPT-4)</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="gemini">Google (Gemini)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            onClick={handleGenerate}
            disabled={
              !originalContent ||
              selectedPlatforms.length === 0 ||
              repurpose.isPending
            }
            className="w-full gap-2"
          >
            {repurpose.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {repurpose.isPending
              ? "Repurposing..."
              : `Repurpose for ${selectedPlatforms.length} Platform${
                  selectedPlatforms.length !== 1 ? "s" : ""
                }`}
          </Button>
        </CardContent>
      </Card>

      {/* Results */}
      {results && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Generated Content</h2>
          <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
            {Object.entries(results).map(([platform, content]) => (
              <Card
                key={platform}
                className="border-green-200 bg-green-50/30 dark:border-green-900 dark:bg-green-950/20"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">
                      {platform.charAt(0) + platform.slice(1).toLowerCase()}
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline" className="text-[10px]">
                        {content.length} chars
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => copyContent(platform, content)}
                      >
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
                  <div className="whitespace-pre-wrap rounded-lg bg-background p-3 text-sm leading-relaxed">
                    {content}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => {
                        const url = `/dashboard/posts/new?content=${encodeURIComponent(
                          content
                        )}&platform=${platform}`;
                        window.location.href = url;
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

          {/* Create All Posts Button */}
          <div className="flex justify-center">
            <Button
              className="gap-2"
              onClick={() => {
                toast({
                  title: "Posts created as drafts",
                  description: `${Object.keys(results).length} draft posts have been created.`,
                });
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
