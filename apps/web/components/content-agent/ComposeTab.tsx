"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useActiveTask } from "~/lib/active-task";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
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
  Users,
  Check,
  Video,
  Film,
  LayoutGrid,
} from "lucide-react";
import dynamic from "next/dynamic";
import { PostPreviewSwitcher } from "~/components/previews";
import { MediaPickerDialog } from "~/components/media-picker-dialog";
import { ImageGenerationPanel } from "~/components/content-agent/ImageGenerationPanel";

const MediaEditor = dynamic(
  () => import("~/components/media-editor/MediaEditor").then((m) => ({ default: m.MediaEditor })),
  { ssr: false }
);

interface ComposeTabProps {
  initialContent?: string;
  initialImage?: string;
  initialImageMediaId?: string;
  onPostCreated?: () => void;
  externalMediaToAdd?: { dataUrl: string } | null;
  onExternalMediaConsumed?: () => void;
}

export function ComposeTab({ initialContent, initialImage, initialImageMediaId, onPostCreated, externalMediaToAdd, onExternalMediaConsumed }: ComposeTabProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [content, setContent] = useState(initialContent || "");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [postMedia, setPostMedia] = useState<{ url: string; mediaId?: string; file?: File; uploading?: boolean }[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingImageIndex, setEditingImageIndex] = useState<number | null>(null);
  const [editorPreview, setEditorPreview] = useState<string | null>(null);
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [channelSearch, setChannelSearch] = useState("");
  const [activeGroupTab, setActiveGroupTab] = useState<string>("all");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const { addTask, removeTask, getTask } = useActiveTask();
  const TASK_ID = "compose-draft";

  // Restore draft from active task on mount
  useEffect(() => {
    const saved = getTask(TASK_ID);
    if (saved?.draft && !initialContent) {
      if (saved.draft.content) setContent(saved.draft.content);
      if (saved.draft.channels?.length) setSelectedChannels(saved.draft.channels);
    }
  }, []);

  // Track compose as active task when content is being written
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
        },
        createdAt: getTask(TASK_ID)?.createdAt || Date.now(),
      });
    } else {
      removeTask(TASK_ID);
    }
  }, [content, selectedChannels, postMedia]);

  useEffect(() => {
    if (initialContent) setContent(initialContent);
    if (initialImage) setPostMedia((prev) => (prev.length === 0 ? [{ url: initialImage, mediaId: initialImageMediaId }] : prev));
  }, [initialContent, initialImage]);

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
  const { data: channelGroups } = trpc.channelGroup.list.useQuery();
  const createPost = trpc.post.create.useMutation({
    onSuccess: () => {
      toast({ title: "Post created!", description: "Your post has been saved successfully." });
      setContent("");
      setSelectedChannels([]);
      setScheduledAt("");
      setPostMedia([]);
      removeTask(TASK_ID);
      onPostCreated?.();
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });
  const getUploadUrl = trpc.media.getUploadUrl.useMutation();
  const saveGeneratedImage = trpc.image.saveGenerated.useMutation();
  const generateAI = trpc.ai.generateContent.useMutation();
  const generateCarousel = trpc.post.generateCarousel.useMutation();
  const [isGeneratingCarousel, setIsGeneratingCarousel] = useState(false);
  const [carouselSlideCount, setCarouselSlideCount] = useState(5);

  const handleAIGenerate = async () => {
    if (!content) return;
    setIsGenerating(true);
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
      const result = await generateAI.mutateAsync({ prompt: enhancePrompt, provider: "anthropic" });
      setContent(result.content);
      toast({ title: "Content enhanced!", description: "AI verified and improved your content." });
    } catch {
      toast({ title: "AI generation failed", description: "Please try again.", variant: "destructive" });
    }
    setIsGenerating(false);
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
    } catch (err: any) {
      toast({
        title: "Carousel generation failed",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
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
    uploadFileToS3(file)
      .then((mediaId) => {
        setPostMedia((prev) =>
          prev.map((item) => (item.url === objectUrl ? { ...item, mediaId, uploading: false } : item))
        );
      })
      .catch((err) => {
        toast({ title: "Upload failed", description: err.message, variant: "destructive" });
        setPostMedia((prev) =>
          prev.map((item) => (item.url === objectUrl ? { ...item, uploading: false } : item))
        );
      });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const url = URL.createObjectURL(file);
      setPostMedia((prev) => [...prev, { url, file, uploading: true }]);
      startAutoUpload(file, url);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("video/")) return;
      if (file.size > 500 * 1024 * 1024) {
        toast({ title: "Video too large", description: "Videos must be under 500MB.", variant: "destructive" });
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

  const uploadFileToS3 = async (file: File): Promise<string> => {
    // Upload through the Next.js server proxy to avoid browser→MinIO CORS issues
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error || "Upload failed");
    }
    const data = await res.json();
    return data.id;
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

    try {
      setIsUploading(true);
      // Upload any files that don't have a mediaId yet
      const mediaIds: string[] = [];
      for (const item of postMedia) {
        if (item.mediaId) {
          mediaIds.push(item.mediaId);
        } else if (item.file) {
          const mediaId = await uploadFileToS3(item.file);
          mediaIds.push(mediaId);
        } else if (item.url && !item.url.startsWith("blob:")) {
          // External URL (e.g. from repurpose AI image) — download and upload
          try {
            const resp = await fetch(item.url);
            const blob = await resp.blob();
            const ext = item.url.match(/\.(png|jpg|jpeg|webp|mp4)(?:\?|$)/i)?.[1] || "jpg";
            const file = new File([blob], `repurpose-${Date.now()}.${ext}`, { type: blob.type || "image/jpeg" });
            const mediaId = await uploadFileToS3(file);
            mediaIds.push(mediaId);
          } catch (dlErr) {
            console.warn("Failed to download external image:", dlErr);
          }
        }
      }

      createPost.mutate({
        content,
        channelIds: selectedChannels,
        scheduledAt: publishNow ? new Date().toISOString() : scheduledAt || undefined,
        ...(mediaIds.length > 0 && { mediaIds }),
      });
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err.message || "Failed to upload images. Please try again.",
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

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1fr,400px]">
        {/* Left column - Editor */}
        <div className="space-y-6">
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
              <CardDescription>Attach images or videos to your post</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
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
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  Image
                </Button>
                <Button
                  variant="outline"
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
              {/* Generate Carousel */}
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
              {postMedia.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {postMedia.map((item, idx) => {
                    const isVideo = item.file?.type.startsWith("video/") || item.url.includes("video") || /\.(mp4|webm|mov)/.test(item.url);
                    return (
                      <div key={idx} className="group relative flex-shrink-0">
                        {isVideo ? (
                          <div className="relative h-16 w-24 overflow-hidden rounded-md border bg-muted">
                            <video
                              src={item.url}
                              className="h-full w-full object-cover"
                              muted
                              preload="metadata"
                            />
                            <div className="absolute inset-0 flex items-center justify-center">
                              {item.uploading ? (
                                <Loader2 className="h-6 w-6 animate-spin text-white drop-shadow" />
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
                          onClick={() => setPostMedia((prev) => prev.filter((_, i) => i !== idx))}
                          className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                        {!isVideo && (
                          <button
                            type="button"
                            onClick={() => handleOpenEditor(idx)}
                            className="absolute bottom-0 left-0 right-0 bg-black/50 py-0.5 text-center text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
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

          {/* Channel Selection */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Select Channels</CardTitle>
                  <CardDescription>Choose which platforms to publish to</CardDescription>
                </div>
                {selectedChannels.length > 0 && (
                  <Badge variant="secondary">{selectedChannels.length} selected</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
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
                <>
                  {/* Search */}
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={channelSearch}
                      onChange={(e) => setChannelSearch(e.target.value)}
                      placeholder="Search channels..."
                      className="h-8 pl-8 text-sm"
                    />
                  </div>

                  {/* Group tabs */}
                  {channelGroups && channelGroups.length > 0 && (
                    <div className="flex gap-1 overflow-x-auto pb-1">
                      <button
                        type="button"
                        onClick={() => setActiveGroupTab("all")}
                        className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                          activeGroupTab === "all"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        All
                      </button>
                      {channelGroups.map((group: any) => {
                        const groupSelected = group.channels.every((c: any) =>
                          selectedChannels.includes(c.id)
                        );
                        return (
                          <button
                            key={group.id}
                            type="button"
                            onClick={() => setActiveGroupTab(group.id)}
                            className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                              activeGroupTab === group.id
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ background: group.color }}
                            />
                            {group.name}
                            {groupSelected && group.channels.length > 0 && (
                              <Check className="h-3 w-3" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Select all in group */}
                  {activeGroupTab !== "all" && channelGroups && (
                    (() => {
                      const group = channelGroups.find((g: any) => g.id === activeGroupTab);
                      if (!group || group.channels.length === 0) return null;
                      const groupIds = group.channels.map((c: any) => c.id);
                      const allSelected = groupIds.every((id: string) => selectedChannels.includes(id));
                      return (
                        <button
                          type="button"
                          onClick={() => {
                            if (allSelected) {
                              setSelectedChannels(prev => prev.filter(id => !groupIds.includes(id)));
                            } else {
                              setSelectedChannels(prev => [...new Set([...prev, ...groupIds])]);
                            }
                          }}
                          className="text-xs text-primary hover:underline"
                        >
                          {allSelected ? "Deselect all in group" : `Select all in "${group.name}"`}
                        </button>
                      );
                    })()
                  )}

                  {/* Channel list */}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {channels
                      ?.filter((channel: any) => {
                        const matchesSearch =
                          !channelSearch ||
                          channel.name.toLowerCase().includes(channelSearch.toLowerCase()) ||
                          channel.platform.toLowerCase().includes(channelSearch.toLowerCase()) ||
                          (channel.username || "").toLowerCase().includes(channelSearch.toLowerCase());
                        const matchesGroup =
                          activeGroupTab === "all" ||
                          channelGroups?.find((g: any) => g.id === activeGroupTab)
                            ?.channels.some((c: any) => c.id === channel.id);
                        return matchesSearch && matchesGroup;
                      })
                      .map((channel: any) => {
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
                            {channel.avatar ? (
                              <img src={channel.avatar} alt={channel.name} className="h-7 w-7 rounded-full object-cover" />
                            ) : (
                              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-bold uppercase">
                                {channel.platform.slice(0, 2)}
                              </div>
                            )}
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

                  {/* No results */}
                  {channels?.filter((channel: any) => {
                    const matchesSearch =
                      !channelSearch ||
                      channel.name.toLowerCase().includes(channelSearch.toLowerCase()) ||
                      channel.platform.toLowerCase().includes(channelSearch.toLowerCase()) ||
                      (channel.username || "").toLowerCase().includes(channelSearch.toLowerCase());
                    const matchesGroup =
                      activeGroupTab === "all" ||
                      channelGroups?.find((g: any) => g.id === activeGroupTab)
                        ?.channels.some((c: any) => c.id === channel.id);
                    return matchesSearch && matchesGroup;
                  }).length === 0 && (
                    <p className="py-4 text-center text-sm text-muted-foreground">No channels found</p>
                  )}

                  {/* Manage groups link */}
                  <div className="flex items-center justify-end pt-1">
                    <a
                      href="/dashboard/channels"
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Users className="h-3 w-3" />
                      Manage channel groups
                    </a>
                  </div>
                </>
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
              onClick={async () => {
                try {
                  setIsUploading(true);
                  const mediaIds: string[] = [];
                  for (const item of postMedia) {
                    if (item.mediaId) mediaIds.push(item.mediaId);
                    else if (item.file) mediaIds.push(await uploadFileToS3(item.file));
                  }
                  createPost.mutate({
                    content,
                    channelIds: selectedChannels.length > 0 ? selectedChannels : [],
                    ...(mediaIds.length > 0 && { mediaIds }),
                  });
                } catch {
                  toast({ title: "Upload failed", variant: "destructive" });
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
              onClick={() => handleSubmit(false)}
              disabled={
                !content || selectedChannels.length === 0 || !scheduledAt || createPost.isPending || isUploading
              }
            >
              <Clock className="mr-2 h-4 w-4" />
              Schedule
            </Button>
            <Button
              onClick={() => handleSubmit(true)}
              disabled={!content || selectedChannels.length === 0 || createPost.isPending || isUploading}
            >
              {(createPost.isPending || isUploading) ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {isUploading ? "Uploading..." : "Publish Now"}
            </Button>
          </div>
          </>
          )}
        </div>

        {/* Right column - Preview Panel */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Post Preview</h2>
          </div>
          <PostPreviewSwitcher
            content={content}
            mediaUrls={editorOpen && editorPreview ? [editorPreview] : postMedia.length > 0 ? postMedia.map(m => m.url) : undefined}
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
