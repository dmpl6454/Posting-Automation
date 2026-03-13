"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/hooks/use-toast";
import {
  Wand2,
  Pencil,
  Loader2,
  Download,
  Save,
  ArrowRight,
  Upload,
  ImagePlus,
  Trash2,
  Square,
  RectangleHorizontal,
  RectangleVertical,
  Monitor,
  Smartphone,
  X,
  Clock,
  Sparkles,
} from "lucide-react";

// -- Models --
const MODELS = [
  {
    label: "Nano Banana 2 (Fast)",
    value: "gemini-3.1-flash-image-preview",
    badge: "Fast",
  },
  {
    label: "Nano Banana Pro (Quality)",
    value: "gemini-3-pro-image-preview",
    badge: "Quality",
  },
  {
    label: "Nano Banana Classic",
    value: "gemini-2.5-flash-image",
    badge: null,
  },
];

// -- Aspect Ratios --
const ASPECT_RATIOS = [
  { label: "Square", value: "1:1", icon: Square },
  { label: "Landscape", value: "16:9", icon: RectangleHorizontal },
  { label: "Portrait", value: "9:16", icon: RectangleVertical },
  { label: "Standard", value: "4:3", icon: Monitor },
  { label: "Tall", value: "3:4", icon: Smartphone },
];

// -- Image Sizes --
const IMAGE_SIZES = [
  { label: "512px", value: "512" },
  { label: "1K", value: "1K" },
  { label: "2K", value: "2K" },
  { label: "4K", value: "4K" },
];

// -- History Item Type --
interface HistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  timestamp: Date;
  description?: string;
}

const PROMPT_MAX_LENGTH = 2000;

export default function ImageStudioPage() {
  const router = useRouter();
  const { toast } = useToast();

  // -- Generate Mode State --
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [model, setModel] = useState(MODELS[0]?.value ?? "gemini-3.1-flash-image-preview");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [imageSize, setImageSize] = useState("1K");

  // -- Edit Mode State --
  const [editPrompt, setEditPrompt] = useState("");
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // -- Result State --
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [resultDescription, setResultDescription] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("generate");

  // -- History --
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // -- tRPC mutations --
  const generateMutation = trpc.image.generate.useMutation({
    onSuccess: (data: any) => {
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      const description = data.description || null;
      setResultImage(imageUrl);
      setResultDescription(description);
      addToHistory(imageUrl, generatePrompt, description);
      toast({ title: "Image generated!", description: "Your image is ready." });
    },
    onError: (err: any) => {
      toast({
        title: "Generation failed",
        description: err.message || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    },
  });

  const editMutation = trpc.image.edit.useMutation({
    onSuccess: (data: any) => {
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      const description = data.description || null;
      setResultImage(imageUrl);
      setResultDescription(description);
      addToHistory(imageUrl, editPrompt, description);
      toast({ title: "Image edited!", description: "Your edited image is ready." });
    },
    onError: (err: any) => {
      toast({
        title: "Edit failed",
        description: err.message || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    },
  });

  const saveMutation = trpc.image.saveGenerated.useMutation({
    onSuccess: () => {
      toast({ title: "Saved!", description: "Image saved to your media library." });
    },
    onError: (err: any) => {
      toast({
        title: "Save failed",
        description: err.message || "Could not save image.",
        variant: "destructive",
      });
    },
  });

  // -- Helpers --
  const addToHistory = (imageUrl: string, prompt: string, description?: string | null) => {
    setHistory((prev) => [
      {
        id: crypto.randomUUID(),
        imageUrl,
        prompt,
        timestamp: new Date(),
        description: description || undefined,
      },
      ...prev,
    ]);
  };

  const handleGenerate = () => {
    if (!generatePrompt.trim()) return;
    generateMutation.mutate({
      prompt: generatePrompt,
      model: model as any,
      aspectRatio,
      imageSize,
    });
  };

  const handleEdit = () => {
    if (!editPrompt.trim() || !uploadedImage) return;
    // Extract base64 data from data URL if present
    let imageBase64 = uploadedImage;
    let imageMimeType = "image/jpeg";
    if (uploadedImage.startsWith("data:")) {
      const match = uploadedImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        imageMimeType = match[1] ?? "image/jpeg";
        imageBase64 = match[2] ?? "";
      }
    }
    editMutation.mutate({
      prompt: editPrompt,
      imageBase64,
      imageMimeType,
    });
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({
        title: "Invalid file",
        description: "Please select an image file.",
        variant: "destructive",
      });
      return;
    }
    const base64 = await fileToBase64(file);
    setUploadedImage(base64);
    setUploadedFileName(file.name);
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDownload = () => {
    if (!resultImage) return;
    const a = document.createElement("a");
    a.href = resultImage;
    a.download = `image-studio-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleSaveToLibrary = () => {
    if (!resultImage) return;
    // Extract base64 and mimeType from the data URL
    let imageBase64 = resultImage;
    let mimeType = "image/png";
    if (resultImage.startsWith("data:")) {
      const match = resultImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1] ?? "image/png";
        imageBase64 = match[2] ?? "";
      }
    }
    saveMutation.mutate({
      imageBase64,
      mimeType,
      fileName: `ai-image-${Date.now()}.png`,
    });
  };

  const handleUseInPost = async () => {
    if (!resultImage) return;
    // Save to media library first to get a URL (base64 is too large for query params)
    let imageBase64 = resultImage;
    let mimeType = "image/png";
    if (resultImage.startsWith("data:")) {
      const match = resultImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1] ?? "image/png";
        imageBase64 = match[2] ?? "";
      }
    }
    try {
      const saved = await saveMutation.mutateAsync({
        imageBase64,
        mimeType,
        fileName: `ai-image-${Date.now()}.png`,
      });
      router.push(`/dashboard/posts/new?aiImage=${encodeURIComponent(saved.url)}`);
    } catch {
      toast({ title: "Could not save image", description: "Please try again.", variant: "destructive" });
    }
  };

  const handleEditThisImage = () => {
    if (!resultImage) return;
    setUploadedImage(resultImage);
    setUploadedFileName("generated-image.png");
    setEditPrompt("");
    setActiveTab("edit");
  };

  const handleHistorySelect = (item: HistoryItem) => {
    setResultImage(item.imageUrl);
    setResultDescription(item.description || null);
  };

  const isGenerating = generateMutation.isPending;
  const isEditing = editMutation.isPending;
  const isSaving = saveMutation.isPending;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Image Studio</h1>
        <p className="text-muted-foreground">
          Generate and edit images with AI for your social media posts
        </p>
      </div>

      {/* Main Layout */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left Column - Controls */}
        <div className="space-y-6">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="generate" className="gap-2">
                <Wand2 className="h-4 w-4" />
                Generate
              </TabsTrigger>
              <TabsTrigger value="edit" className="gap-2">
                <Pencil className="h-4 w-4" />
                Edit
              </TabsTrigger>
            </TabsList>

            {/* ===== GENERATE TAB ===== */}
            <TabsContent value="generate" className="space-y-4">
              {/* Prompt */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Prompt</CardTitle>
                  <CardDescription>Describe the image you want to create</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea
                    value={generatePrompt}
                    onChange={(e) => {
                      if (e.target.value.length <= PROMPT_MAX_LENGTH) {
                        setGeneratePrompt(e.target.value);
                      }
                    }}
                    placeholder="Describe the image you want to create..."
                    className="min-h-[140px] resize-none"
                  />
                  <div className="flex justify-end">
                    <span
                      className={`text-xs tabular-nums ${
                        generatePrompt.length >= PROMPT_MAX_LENGTH
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {generatePrompt.length} / {PROMPT_MAX_LENGTH}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Model Selector */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Model</CardTitle>
                </CardHeader>
                <CardContent>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODELS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          <span className="flex items-center gap-2">
                            {m.label}
                            {m.badge && (
                              <Badge variant="secondary" className="text-[10px]">
                                {m.badge}
                              </Badge>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>

              {/* Aspect Ratio */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Aspect Ratio</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-5 gap-2">
                    {ASPECT_RATIOS.map((ar) => {
                      const Icon = ar.icon;
                      const isSelected = aspectRatio === ar.value;
                      return (
                        <button
                          key={ar.value}
                          onClick={() => setAspectRatio(ar.value)}
                          className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs transition-all ${
                            isSelected
                              ? "border-primary bg-primary/5 text-primary ring-1 ring-primary"
                              : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50 dark:hover:border-muted-foreground/30"
                          }`}
                        >
                          <Icon className="h-5 w-5" />
                          <span className="font-medium">{ar.value}</span>
                          <span className="text-[10px]">{ar.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Image Size */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Image Size</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-4 gap-2">
                    {IMAGE_SIZES.map((size) => {
                      const isSelected = imageSize === size.value;
                      return (
                        <button
                          key={size.value}
                          onClick={() => setImageSize(size.value)}
                          className={`rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                            isSelected
                              ? "border-primary bg-primary/5 text-primary ring-1 ring-primary"
                              : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50 dark:hover:border-muted-foreground/30"
                          }`}
                        >
                          {size.label}
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Generate Button */}
              <Button
                onClick={handleGenerate}
                disabled={!generatePrompt.trim() || isGenerating}
                className="w-full gap-2"
                size="lg"
              >
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {isGenerating ? "Generating..." : "Generate Image"}
              </Button>
            </TabsContent>

            {/* ===== EDIT TAB ===== */}
            <TabsContent value="edit" className="space-y-4">
              {/* Image Upload */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Source Image</CardTitle>
                  <CardDescription>Upload or drag an image to edit</CardDescription>
                </CardHeader>
                <CardContent>
                  {uploadedImage ? (
                    <div className="relative">
                      <img
                        src={uploadedImage}
                        alt="Uploaded for editing"
                        className="w-full rounded-lg border object-contain"
                        style={{ maxHeight: "300px" }}
                      />
                      <div className="mt-2 flex items-center justify-between">
                        <span className="truncate text-xs text-muted-foreground">
                          {uploadedFileName}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setUploadedImage(null);
                            setUploadedFileName("");
                            if (fileInputRef.current) fileInputRef.current.value = "";
                          }}
                          className="gap-1 text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3.5 w-3.5" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div
                      onDrop={onDrop}
                      onDragOver={onDragOver}
                      onDragLeave={onDragLeave}
                      onClick={() => fileInputRef.current?.click()}
                      className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 transition-colors ${
                        isDragOver
                          ? "border-primary bg-primary/5"
                          : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50 dark:hover:border-muted-foreground/30"
                      }`}
                    >
                      <Upload className="h-10 w-10 text-muted-foreground" />
                      <div className="text-center">
                        <p className="text-sm font-medium">
                          Drop an image here or click to upload
                        </p>
                        <p className="text-xs text-muted-foreground">
                          PNG, JPG, WebP up to 10MB
                        </p>
                      </div>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={onFileInputChange}
                    className="hidden"
                  />
                </CardContent>
              </Card>

              {/* Edit Prompt */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Edit Instructions</CardTitle>
                  <CardDescription>Describe the changes you want</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea
                    value={editPrompt}
                    onChange={(e) => {
                      if (e.target.value.length <= PROMPT_MAX_LENGTH) {
                        setEditPrompt(e.target.value);
                      }
                    }}
                    placeholder="Describe the changes you want..."
                    className="min-h-[120px] resize-none"
                  />
                  <div className="flex justify-end">
                    <span
                      className={`text-xs tabular-nums ${
                        editPrompt.length >= PROMPT_MAX_LENGTH
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {editPrompt.length} / {PROMPT_MAX_LENGTH}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Edit Button */}
              <Button
                onClick={handleEdit}
                disabled={!editPrompt.trim() || !uploadedImage || isEditing}
                className="w-full gap-2"
                size="lg"
              >
                {isEditing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pencil className="h-4 w-4" />
                )}
                {isEditing ? "Editing..." : "Edit Image"}
              </Button>
            </TabsContent>
          </Tabs>
        </div>

        {/* Right Column - Preview & Results */}
        <div className="space-y-6">
          {/* Result Preview */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Preview</CardTitle>
            </CardHeader>
            <CardContent>
              {isGenerating || isEditing ? (
                <div className="space-y-4">
                  <Skeleton className="aspect-square w-full rounded-lg" />
                  <div className="flex gap-2">
                    <Skeleton className="h-9 flex-1 rounded-md" />
                    <Skeleton className="h-9 flex-1 rounded-md" />
                  </div>
                </div>
              ) : resultImage ? (
                <div className="space-y-4">
                  <div className="overflow-hidden rounded-lg border bg-muted/30 dark:bg-muted/10">
                    <img
                      src={resultImage}
                      alt="Generated result"
                      className="w-full object-contain"
                      style={{ maxHeight: "500px" }}
                    />
                  </div>

                  {/* AI Description */}
                  {resultDescription && (
                    <div className="rounded-lg border bg-muted/30 p-3 dark:bg-muted/10">
                      <p className="text-xs font-medium text-muted-foreground">
                        AI Description
                      </p>
                      <p className="mt-1 text-sm">{resultDescription}</p>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={handleSaveToLibrary}
                      disabled={isSaving}
                      className="gap-2"
                    >
                      {isSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      Save to Media Library
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleDownload}
                      className="gap-2"
                    >
                      <Download className="h-4 w-4" />
                      Download
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleUseInPost}
                      className="gap-2"
                    >
                      <ArrowRight className="h-4 w-4" />
                      Use in Post
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleEditThisImage}
                      className="gap-2"
                    >
                      <Pencil className="h-4 w-4" />
                      Edit This Image
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
                  <ImagePlus className="mb-3 h-12 w-12 text-muted-foreground/50" />
                  <p className="text-sm font-medium text-muted-foreground">
                    No image generated yet
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    Write a prompt and click Generate to create an image
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Session History */}
          {history.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Session History</CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setHistory([])}
                    className="gap-1 text-xs text-muted-foreground"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2">
                  {history.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handleHistorySelect(item)}
                      className={`group relative overflow-hidden rounded-lg border transition-all hover:ring-2 hover:ring-primary/50 ${
                        resultImage === item.imageUrl
                          ? "ring-2 ring-primary"
                          : ""
                      }`}
                    >
                      <img
                        src={item.imageUrl}
                        alt={item.prompt}
                        className="aspect-square w-full object-cover"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <p className="truncate text-[10px] text-white">
                          {item.prompt}
                        </p>
                      </div>
                      <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Badge variant="secondary" className="text-[9px]">
                          <Clock className="mr-0.5 h-2.5 w-2.5" />
                          {item.timestamp.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
