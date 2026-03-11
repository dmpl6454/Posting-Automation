"use client";

import { useState } from "react";
import Link from "next/link";
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
import { Sparkles, Copy, Check, Loader2, ArrowRight, Wand2 } from "lucide-react";

const platforms = ["TWITTER", "LINKEDIN", "INSTAGRAM", "FACEBOOK", "REDDIT", "YOUTUBE"] as const;
const tones = ["professional", "casual", "humorous", "formal", "inspiring"] as const;
const providers = ["openai", "anthropic", "gemini"] as const;

export default function AIStudioPage() {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState<string>("TWITTER");
  const [tone, setTone] = useState<typeof tones[number]>("professional");
  const [provider, setProvider] = useState<typeof providers[number]>("openai");
  const [result, setResult] = useState("");
  const [copied, setCopied] = useState(false);

  const generate = trpc.ai.generateContent.useMutation({
    onSuccess: (data) => {
      setResult(data.content);
      toast({ title: "Content generated!", description: "Your AI content is ready." });
    },
    onError: () => {
      toast({ title: "Generation failed", description: "Please check your AI provider keys.", variant: "destructive" });
    },
  });

  const handleGenerate = () => {
    if (!prompt) return;
    generate.mutate({ prompt, platform, tone, provider });
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(result);
    setCopied(true);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI Studio</h1>
        <p className="text-muted-foreground">
          Generate engaging social media content with AI
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-purple-500" />
            Content Generator
          </CardTitle>
          <CardDescription>
            Configure your preferences and let AI craft the perfect post
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Settings Row */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Platform</Label>
              <Select value={platform} onValueChange={setPlatform}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {platforms.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.charAt(0) + p.slice(1).toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tone</Label>
              <Select value={tone} onValueChange={(v) => setTone(v as typeof tones[number])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tones.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>AI Provider</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as typeof providers[number])}>
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
          </div>

          {/* Prompt */}
          <div className="space-y-1.5">
            <Label>Describe your content</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g., Product launch announcement for our new AI tool that helps with email productivity"
              className="min-h-[120px] resize-none"
            />
          </div>

          <Button
            onClick={handleGenerate}
            disabled={!prompt || generate.isPending}
            className="w-full gap-2"
          >
            {generate.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {generate.isPending ? "Generating..." : "Generate Content"}
          </Button>
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <Card className="border-green-200 bg-green-50/30 dark:border-green-900 dark:bg-green-950/20">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-green-600" />
                Generated Content
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={copyToClipboard} className="gap-1.5">
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="whitespace-pre-wrap rounded-lg bg-background p-4 text-sm leading-relaxed">
              {result}
            </div>
            <div className="flex items-center justify-between">
              <Badge variant="outline">
                {result.length} characters
              </Badge>
              <Button asChild className="gap-2">
                <Link href={`/dashboard/posts/new?content=${encodeURIComponent(result)}`}>
                  Use in Post
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
