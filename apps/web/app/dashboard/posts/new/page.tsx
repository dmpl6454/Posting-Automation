"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import { useToast } from "~/hooks/use-toast";
import { Sparkles, Send, Clock, Loader2, Save, AlertCircle, CheckCircle2, Eye, ImagePlus, ChevronDown, ChevronUp, X } from "lucide-react";
import { PostPreviewSwitcher } from "~/components/previews";

export default function NewPostPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [content, setContent] = useState("");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiImageOpen, setAiImageOpen] = useState(false);
  const [aiImagePrompt, setAiImagePrompt] = useState("");
  const [aiGeneratedImage, setAiGeneratedImage] = useState<string | null>(null);
  const [postMedia, setPostMedia] = useState<string[]>([]);

  const { data: channels, isLoading: channelsLoading } = trpc.channel.list.useQuery();
  const createPost = trpc.post.create.useMutation({
    onSuccess: () => {
      toast({ title: "Post created!", description: "Your post has been saved successfully." });
      router.push("/dashboard/posts");
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });
  const generateAI = trpc.ai.generateContent.useMutation();
  const generateImage = trpc.image.generate.useMutation({
    onSuccess: (data: any) => {
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      setAiGeneratedImage(imageUrl);
      toast({ title: "Image generated!", description: "Your AI image is ready." });
    },
    onError: (err: any) => {
      toast({
        title: "Image generation failed",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleGenerateImage = () => {
    if (!aiImagePrompt.trim()) return;
    generateImage.mutate({ prompt: aiImagePrompt });
  };

  const handleAddImageToPost = () => {
    if (aiGeneratedImage) {
      setPostMedia((prev) => [...prev, aiGeneratedImage]);
      setAiGeneratedImage(null);
      setAiImagePrompt("");
      toast({ title: "Image added", description: "Image has been attached to your post." });
    }
  };

  const handleAIGenerate = async () => {
    if (!content) return;
    setIsGenerating(true);
    try {
      const result = await generateAI.mutateAsync({ prompt: content });
      setContent(result.content);
      toast({ title: "Content enhanced!", description: "AI has improved your content." });
    } catch (err) {
      toast({ title: "AI generation failed", description: "Please try again.", variant: "destructive" });
    }
    setIsGenerating(false);
  };

  const handleSubmit = (publishNow: boolean) => {
    if (!content || selectedChannels.length === 0) {
      toast({
        title: "Missing required fields",
        description: "Please add content and select at least one channel.",
        variant: "destructive",
      });
      return;
    }
    createPost.mutate({
      content,
      channelIds: selectedChannels,
      scheduledAt: publishNow ? new Date().toISOString() : scheduledAt || undefined,
    });
  };

  const charCount = content.length;
  const maxChars = 280; // Twitter limit as default guide

  // Derive selected platform names from channels for the preview switcher
  const selectedPlatforms: string[] = channels
    ? channels
        .filter((ch: any) => selectedChannels.includes(ch.id))
        .map((ch: any) => (ch.platform as string).toLowerCase())
        .filter((p: string, i: number, arr: string[]) => arr.indexOf(p) === i)
    : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Create New Post</h1>
        <p className="text-muted-foreground">
          Compose and schedule your post across multiple platforms
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr,400px]">
        {/* Left column - Editor */}
        <div className="space-y-6">
          {/* Content Editor */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Content</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAIGenerate}
                  disabled={isGenerating || !content}
                  className="gap-1.5"
                >
                  {isGenerating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 text-purple-500" />
                  )}
                  {isGenerating ? "Generating..." : "Enhance with AI"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="What do you want to share? Type a topic and click 'Enhance with AI' to generate content..."
                className="min-h-[200px] resize-none"
              />
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  {charCount > 0 && charCount <= maxChars && (
                    <Badge variant="secondary" className="gap-1">
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                      Twitter OK
                    </Badge>
                  )}
                  {charCount > maxChars && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Over Twitter limit
                    </Badge>
                  )}
                </div>
                <span className={`tabular-nums ${charCount > maxChars ? "text-destructive" : "text-muted-foreground"}`}>
                  {charCount} / {maxChars}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* AI Image Generation */}
          <Card>
            <CardHeader className="pb-3">
              <button
                type="button"
                onClick={() => setAiImageOpen(!aiImageOpen)}
                className="flex w-full items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <ImagePlus className="h-4 w-4 text-purple-500" />
                  <CardTitle className="text-base">AI Image Generation</CardTitle>
                </div>
                {aiImageOpen ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </CardHeader>
            {aiImageOpen && (
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={aiImagePrompt}
                    onChange={(e) => setAiImagePrompt(e.target.value)}
                    placeholder="Describe the image you want..."
                    className="flex-1"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleGenerateImage}
                    disabled={!aiImagePrompt.trim() || generateImage.isPending}
                    className="gap-1.5 whitespace-nowrap"
                  >
                    {generateImage.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    Generate
                  </Button>
                </div>

                {generateImage.isPending && (
                  <div className="flex items-center justify-center rounded-lg border border-dashed p-6">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                )}

                {aiGeneratedImage && !generateImage.isPending && (
                  <div className="space-y-2">
                    <div className="relative overflow-hidden rounded-lg border">
                      <img
                        src={aiGeneratedImage}
                        alt="AI generated"
                        className="w-full object-contain"
                        style={{ maxHeight: "200px" }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setAiGeneratedImage(null);
                          setAiImagePrompt("");
                        }}
                        className="absolute right-2 top-2 rounded-full bg-black/50 p-1 text-white transition-colors hover:bg-black/70"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAddImageToPost}
                      className="w-full gap-1.5"
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      Add to Post
                    </Button>
                  </div>
                )}

                {postMedia.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      Attached Images ({postMedia.length})
                    </p>
                    <div className="flex gap-2 overflow-x-auto">
                      {postMedia.map((url, idx) => (
                        <div key={idx} className="group relative flex-shrink-0">
                          <img
                            src={url}
                            alt={`Attached ${idx + 1}`}
                            className="h-16 w-16 rounded-md border object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => setPostMedia((prev) => prev.filter((_, i) => i !== idx))}
                            className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Channel Selection */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Select Channels</CardTitle>
              <CardDescription>Choose which platforms to publish to</CardDescription>
            </CardHeader>
            <CardContent>
              {channelsLoading ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-lg border bg-muted" />
                  ))}
                </div>
              ) : channels?.length === 0 ? (
                <div className="flex flex-col items-center rounded-lg border border-dashed p-8 text-center">
                  <AlertCircle className="mb-2 h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">No channels connected</p>
                  <p className="mb-4 text-xs text-muted-foreground">
                    Connect a social media account to start posting
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a href="/dashboard/channels">Connect Channel</a>
                  </Button>
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {channels?.map((channel: any) => {
                    const isSelected = selectedChannels.includes(channel.id);
                    return (
                      <label
                        key={channel.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-all ${
                          isSelected
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : "hover:border-muted-foreground/50 hover:bg-muted/50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedChannels([...selectedChannels, channel.id]);
                            } else {
                              setSelectedChannels(selectedChannels.filter((id) => id !== channel.id));
                            }
                          }}
                          className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{channel.name}</p>
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
                      </label>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

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
                  <Input
                    id="schedule-date"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
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

          {/* Actions */}
          <Separator />
          <div className="flex justify-end gap-3 pb-8">
            <Button
              variant="outline"
              onClick={() => createPost.mutate({ content, channelIds: selectedChannels })}
              disabled={!content || createPost.isPending}
            >
              <Save className="mr-2 h-4 w-4" />
              Save as Draft
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleSubmit(false)}
              disabled={!content || selectedChannels.length === 0 || !scheduledAt || createPost.isPending}
            >
              <Clock className="mr-2 h-4 w-4" />
              Schedule
            </Button>
            <Button
              onClick={() => handleSubmit(true)}
              disabled={!content || selectedChannels.length === 0 || createPost.isPending}
            >
              {createPost.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Publish Now
            </Button>
          </div>
        </div>

        {/* Right column - Preview Panel */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Post Preview</h2>
          </div>
          <PostPreviewSwitcher
            content={content}
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
    </div>
  );
}
