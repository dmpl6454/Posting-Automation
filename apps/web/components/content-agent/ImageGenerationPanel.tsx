"use client";

import { useState, useRef, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
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
  Wand2, Pencil, Loader2, Download, Save, Upload, ImagePlus,
  Trash2, Square, RectangleHorizontal, RectangleVertical, Monitor, Smartphone,
  X, Sparkles, FolderOpen, ChevronDown, ChevronUp, Plus, Newspaper, Merge,
} from "lucide-react";
import { MediaPickerDialog } from "~/components/media-picker-dialog";

const MODELS = [
  { label: "Nano Banana 2 (Fast)", value: "gemini-3.1-flash-image-preview", badge: "Fast" },
  { label: "Nano Banana Pro (Quality)", value: "gemini-3-pro-image-preview", badge: "Quality" },
  { label: "Nano Banana Classic", value: "gemini-2.5-flash-image", badge: null },
];

const ASPECT_RATIOS = [
  { label: "Square", value: "1:1", icon: Square },
  { label: "Landscape", value: "16:9", icon: RectangleHorizontal },
  { label: "Portrait", value: "9:16", icon: RectangleVertical },
  { label: "Standard", value: "4:3", icon: Monitor },
  { label: "Tall", value: "3:4", icon: Smartphone },
  { label: "Feed", value: "4:5", icon: RectangleVertical },
];

const NEWS_STYLES = [
  { label: "Breaking News", value: "breaking", prompt: "Create a professional breaking news graphic with bold red and white colors, urgent typography, a news ticker style banner, and a dramatic photorealistic background scene." },
  { label: "Editorial", value: "editorial", prompt: "Create a clean editorial news image with a professional journalistic style, neutral tones, sharp photography aesthetic, and a credible newspaper layout feel." },
  { label: "Feature Story", value: "feature", prompt: "Create a compelling feature story image with rich colors, documentary-style photography aesthetic, engaging composition, and a magazine editorial look." },
  { label: "Infographic", value: "infographic", prompt: "Create a clean data-driven news infographic style image with modern flat design, clear typography areas, professional color palette, and a structured layout." },
  { label: "Social News", value: "social", prompt: "Create a bold social media news graphic with high contrast colors, large impactful typography space, modern design, and eye-catching visual elements suitable for social platforms." },
  { label: "Sports News", value: "sports", prompt: "Create a dynamic sports news image with high energy, bold typography areas, action-oriented composition, vibrant colors, and a modern sports broadcast aesthetic." },
];

const IMAGE_SIZES = [
  { label: "512px", value: "512" },
  { label: "1K", value: "1K" },
  { label: "2K", value: "2K" },
  { label: "4K", value: "4K" },
];

interface HistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  timestamp: Date;
}

const PROMPT_MAX_LENGTH = 2000;

interface ImageGenerationPanelProps {
  onAddToPost: (imageDataUrl: string) => void;
  postContent?: string;
}

export function ImageGenerationPanel({ onAddToPost, postContent }: ImageGenerationPanelProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("generate");
  const [mergeContent, setMergeContent] = useState(false);
  const [selectedNewsStyle, setSelectedNewsStyle] = useState<string | null>(null);

  // Generate state
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [imageProvider, setImageProvider] = useState<"nano-banana" | "nano-banana-pro" | "dall-e" | "meta-ai">("nano-banana");
  const [model, setModel] = useState(MODELS[0]?.value ?? "gemini-3.1-flash-image-preview");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [imageSize, setImageSize] = useState("1K");
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [referenceFileName, setReferenceFileName] = useState("");
  const [logoImage, setLogoImage] = useState<string | null>(null);
  const [logoFileName, setLogoFileName] = useState("");
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Edit state
  const [editPrompt, setEditPrompt] = useState("");
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Result & history
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Media pickers
  const [showReferencePicker, setShowReferencePicker] = useState(false);
  const [showLogoPicker, setShowLogoPicker] = useState(false);

  const addToHistory = (imageUrl: string, prompt: string) => {
    setHistory((prev) => [{ id: crypto.randomUUID(), imageUrl, prompt, timestamp: new Date() }, ...prev]);
  };

  const generateMutation = trpc.image.generate.useMutation({
    onSuccess: (data: any) => {
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      setResultImage(imageUrl);
      addToHistory(imageUrl, generatePrompt);
      toast({ title: "Image generated!", description: "Your image is ready." });
    },
    onError: (err: any) => {
      toast({ title: "Generation failed", description: err.message || "Something went wrong.", variant: "destructive" });
    },
  });

  const editMutation = trpc.image.edit.useMutation({
    onSuccess: (data: any) => {
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      setResultImage(imageUrl);
      addToHistory(imageUrl, editPrompt);
      toast({ title: "Image edited!", description: "Your edited image is ready." });
    },
    onError: (err: any) => {
      toast({ title: "Edit failed", description: err.message || "Something went wrong.", variant: "destructive" });
    },
  });

  const saveMutation = trpc.image.saveGenerated.useMutation({
    onSuccess: () => toast({ title: "Saved to media library!" }),
    onError: (err: any) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const extractBase64 = (dataUrl: string) => {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    return match ? { base64: match[2]!, mimeType: match[1]! } : null;
  };

  const urlToBase64 = async (url: string): Promise<string> => {
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const handleGenerate = () => {
    if (!generatePrompt.trim()) return;
    const refs: Array<{ base64: string; mimeType?: string }> = [];
    if (referenceImage) { const ref = extractBase64(referenceImage); if (ref) refs.push(ref); }
    if (logoImage) { const logo = extractBase64(logoImage); if (logo) refs.push(logo); }

    let fullPrompt = generatePrompt;

    // Merge post content into prompt
    if (mergeContent && postContent?.trim()) {
      fullPrompt = `${fullPrompt}\n\nBased on this post content:\n"${postContent.trim()}"`;
    }

    // Apply news style preset
    if (selectedNewsStyle) {
      const style = NEWS_STYLES.find((s) => s.value === selectedNewsStyle);
      if (style) fullPrompt = `${style.prompt}\n\nImage topic: ${fullPrompt}`;
    }

    if (referenceImage && logoImage) fullPrompt += `\n\nI've attached a reference design image and a logo. Please use the reference as style/layout inspiration and incorporate the logo into the generated image.`;
    else if (referenceImage) fullPrompt += `\n\nI've attached a reference design image. Please use it as style/layout inspiration for the generated image.`;
    else if (logoImage) fullPrompt += `\n\nI've attached a logo image. Please incorporate this logo into the generated image.`;

    generateMutation.mutate({
      prompt: fullPrompt,
      provider: imageProvider,
      ...(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro"
        ? { model: model as any, aspectRatio, imageSize, ...(refs.length > 0 ? { referenceImages: refs } : {}) }
        : { aspectRatio }),
    });
  };

  const handleEdit = () => {
    if (!editPrompt.trim() || !uploadedImage) return;
    let imageBase64 = uploadedImage;
    let imageMimeType = "image/jpeg";
    if (uploadedImage.startsWith("data:")) {
      const match = uploadedImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) { imageMimeType = match[1] ?? "image/jpeg"; imageBase64 = match[2] ?? ""; }
    }
    editMutation.mutate({ prompt: editPrompt, imageBase64, imageMimeType });
  };

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) { toast({ title: "Invalid file", variant: "destructive" }); return; }
    const base64 = await fileToBase64(file);
    setUploadedImage(base64);
    setUploadedFileName(file.name);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    const file = e.dataTransfer.files?.[0]; if (file) handleFileSelect(file);
  }, []);

  const handleDownload = () => {
    if (!resultImage) return;
    const a = document.createElement("a"); a.href = resultImage; a.download = `ai-image-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleSaveToLibrary = () => {
    if (!resultImage) return;
    let imageBase64 = resultImage; let mimeType = "image/png";
    if (resultImage.startsWith("data:")) {
      const match = resultImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) { mimeType = match[1] ?? "image/png"; imageBase64 = match[2] ?? ""; }
    }
    saveMutation.mutate({ imageBase64, mimeType, fileName: `ai-image-${Date.now()}.png` });
  };

  const handleAddToPost = () => {
    if (!resultImage) return;
    onAddToPost(resultImage);
    toast({ title: "Image added to post!" });
  };

  const isGenerating = generateMutation.isPending;
  const isEditing = editMutation.isPending;
  const isSaving = saveMutation.isPending;

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex w-full items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-purple-500" />
              <CardTitle className="text-base">AI Image Generation</CardTitle>
            </div>
            {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardHeader>

        {open && (
          <CardContent className="space-y-4 pt-0">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="generate" className="gap-2"><Wand2 className="h-3.5 w-3.5" />Generate</TabsTrigger>
                <TabsTrigger value="edit" className="gap-2"><Pencil className="h-3.5 w-3.5" />Edit</TabsTrigger>
              </TabsList>

              {/* GENERATE TAB */}
              <TabsContent value="generate" className="space-y-3 mt-3">

                {/* Merge content toggle */}
                {postContent?.trim() && (
                  <button
                    type="button"
                    onClick={() => setMergeContent(!mergeContent)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all ${mergeContent ? "border-primary bg-primary/5 text-primary" : "border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary/50 hover:bg-muted/30"}`}
                  >
                    <Merge className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-medium">Merge post content into prompt</span>
                    {mergeContent && <span className="ml-auto text-[10px] text-primary">ON</span>}
                  </button>
                )}

                {/* News style presets */}
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <Newspaper className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs font-medium text-muted-foreground">News Style</p>
                    {selectedNewsStyle && (
                      <button type="button" onClick={() => setSelectedNewsStyle(null)} className="ml-auto text-[10px] text-muted-foreground hover:text-destructive">Clear</button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {NEWS_STYLES.map((style) => (
                      <button
                        key={style.value}
                        type="button"
                        onClick={() => setSelectedNewsStyle(selectedNewsStyle === style.value ? null : style.value)}
                        className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-all text-left ${selectedNewsStyle === style.value ? "border-primary bg-primary/5 text-primary ring-1 ring-primary" : "border-border text-muted-foreground hover:bg-muted/50"}`}
                      >
                        {style.label}
                      </button>
                    ))}
                  </div>
                </div>

                <Textarea
                  value={generatePrompt}
                  onChange={(e) => { if (e.target.value.length <= PROMPT_MAX_LENGTH) setGeneratePrompt(e.target.value); }}
                  placeholder="Describe the image you want to create..."
                  className="min-h-[100px] resize-none"
                />
                <div className="flex justify-end">
                  <span className={`text-xs tabular-nums ${generatePrompt.length >= PROMPT_MAX_LENGTH ? "text-destructive" : "text-muted-foreground"}`}>
                    {generatePrompt.length} / {PROMPT_MAX_LENGTH}
                  </span>
                </div>

                {/* Provider */}
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">AI Provider</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { value: "nano-banana", label: "Nano Banana", sub: "Gemini" },
                      { value: "nano-banana-pro", label: "NB Pro", sub: "Gemini Pro" },
                      { value: "dall-e", label: "DALL-E 3", sub: "OpenAI" },
                      { value: "meta-ai", label: "Meta AI", sub: "FLUX.1" },
                    ].map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setImageProvider(p.value as typeof imageProvider)}
                        className={`flex flex-col items-center rounded-lg border px-2 py-2 text-xs transition-all ${
                          imageProvider === p.value
                            ? "border-primary bg-primary/5 text-primary ring-1 ring-primary"
                            : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50"
                        }`}
                      >
                        <span className="font-semibold">{p.label}</span>
                        <span className="text-[10px] opacity-70">{p.sub}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Model */}
                {(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro") && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">Model</p>
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {MODELS.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            <span className="flex items-center gap-2 text-xs">
                              {m.label}
                              {m.badge && <Badge variant="secondary" className="text-[10px]">{m.badge}</Badge>}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Aspect Ratio */}
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Aspect Ratio</p>
                  <div className="grid grid-cols-5 gap-1.5">
                    {ASPECT_RATIOS.map((ar) => {
                      const Icon = ar.icon;
                      return (
                        <button
                          key={ar.value}
                          type="button"
                          onClick={() => setAspectRatio(ar.value)}
                          className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-xs transition-all ${aspectRatio === ar.value ? "border-primary bg-primary/5 text-primary ring-1 ring-primary" : "border-border text-muted-foreground hover:bg-muted/50"}`}
                        >
                          <Icon className="h-4 w-4" />
                          <span className="text-[10px] font-medium">{ar.value}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Size */}
                {(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro") && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">Image Size</p>
                    <div className="grid grid-cols-4 gap-1.5">
                      {IMAGE_SIZES.map((s) => (
                        <button
                          key={s.value}
                          type="button"
                          onClick={() => setImageSize(s.value)}
                          className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-all ${imageSize === s.value ? "border-primary bg-primary/5 text-primary ring-1 ring-primary" : "border-border text-muted-foreground hover:bg-muted/50"}`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Attachments */}
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Attachments (optional)</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <input ref={referenceInputRef} type="file" accept="image/*" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) { fileToBase64(f).then(d => { setReferenceImage(d); setReferenceFileName(f.name); }); } e.target.value = ""; }} />
                      {referenceImage ? (
                        <div className="relative group rounded-lg border overflow-hidden">
                          <img src={referenceImage} alt="Reference" className="w-full h-16 object-cover" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button type="button" onClick={() => { setReferenceImage(null); setReferenceFileName(""); }} className="rounded-full bg-white/90 p-1"><X className="h-3 w-3 text-black" /></button>
                          </div>
                          <p className="text-[9px] text-muted-foreground truncate px-1 py-0.5">{referenceFileName}</p>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <button type="button" onClick={() => referenceInputRef.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors">
                            <Upload className="h-3.5 w-3.5" /><span className="font-medium">Reference</span>
                          </button>
                          <button type="button" onClick={() => setShowReferencePicker(true)} className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed p-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors">
                            <FolderOpen className="h-3 w-3" /><span>Library</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <div>
                      <input ref={logoInputRef} type="file" accept="image/*" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) { fileToBase64(f).then(d => { setLogoImage(d); setLogoFileName(f.name); }); } e.target.value = ""; }} />
                      {logoImage ? (
                        <div className="relative group rounded-lg border overflow-hidden">
                          <img src={logoImage} alt="Logo" className="w-full h-16 object-contain bg-muted/30 p-1" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button type="button" onClick={() => { setLogoImage(null); setLogoFileName(""); }} className="rounded-full bg-white/90 p-1"><X className="h-3 w-3 text-black" /></button>
                          </div>
                          <p className="text-[9px] text-muted-foreground truncate px-1 py-0.5">{logoFileName}</p>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <button type="button" onClick={() => logoInputRef.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors">
                            <ImagePlus className="h-3.5 w-3.5" /><span className="font-medium">Logo</span>
                          </button>
                          <button type="button" onClick={() => setShowLogoPicker(true)} className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed p-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors">
                            <FolderOpen className="h-3 w-3" /><span>Library</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <Button onClick={handleGenerate} disabled={!generatePrompt.trim() || isGenerating} className="w-full gap-2">
                  {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {isGenerating ? "Generating..." : "Generate Image"}
                </Button>
              </TabsContent>

              {/* EDIT TAB */}
              <TabsContent value="edit" className="space-y-3 mt-3">
                {uploadedImage ? (
                  <div className="relative">
                    <img src={uploadedImage} alt="Upload" className="w-full rounded-lg border object-contain" style={{ maxHeight: "200px" }} />
                    <div className="mt-1 flex items-center justify-between">
                      <span className="truncate text-xs text-muted-foreground">{uploadedFileName}</span>
                      <Button variant="ghost" size="sm" onClick={() => { setUploadedImage(null); setUploadedFileName(""); }} className="gap-1 text-xs text-muted-foreground hover:text-destructive">
                        <X className="h-3 w-3" />Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    onDrop={onDrop}
                    onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                    onDragLeave={() => setIsDragOver(false)}
                    onClick={() => fileInputRef.current?.click()}
                    className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors ${isDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50"}`}
                  >
                    <Upload className="h-8 w-8 text-muted-foreground" />
                    <p className="text-xs text-center text-muted-foreground">Drop image or click to upload</p>
                  </div>
                )}
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />

                <Textarea
                  value={editPrompt}
                  onChange={(e) => { if (e.target.value.length <= PROMPT_MAX_LENGTH) setEditPrompt(e.target.value); }}
                  placeholder="Describe the changes you want..."
                  className="min-h-[80px] resize-none"
                />

                <Button onClick={handleEdit} disabled={!editPrompt.trim() || !uploadedImage || isEditing} className="w-full gap-2">
                  {isEditing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
                  {isEditing ? "Editing..." : "Edit Image"}
                </Button>
              </TabsContent>
            </Tabs>

            {/* Result */}
            {(isGenerating || isEditing || resultImage) && (
              <div className="space-y-3 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">Result</p>
                {isGenerating || isEditing ? (
                  <Skeleton className="aspect-square w-full rounded-lg" />
                ) : resultImage ? (
                  <div className="space-y-2">
                    <div className="overflow-hidden rounded-lg border bg-muted/30">
                      <img src={resultImage} alt="Result" className="w-full object-contain" style={{ maxHeight: "300px" }} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button size="sm" className="gap-1.5" onClick={handleAddToPost}>
                        <Plus className="h-3.5 w-3.5" />Add to Post
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleSaveToLibrary} disabled={isSaving} className="gap-1.5">
                        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Save to Library
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleDownload} className="gap-1.5">
                        <Download className="h-3.5 w-3.5" />Download
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setUploadedImage(resultImage); setUploadedFileName("generated.png"); setEditPrompt(""); setActiveTab("edit"); }} className="gap-1.5">
                        <Pencil className="h-3.5 w-3.5" />Edit This
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {/* History */}
            {history.length > 0 && (
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">Session History</p>
                  <button type="button" onClick={() => setHistory([])} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3 w-3" />Clear
                  </button>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {history.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setResultImage(item.imageUrl)}
                      className={`group relative overflow-hidden rounded-lg border transition-all hover:ring-2 hover:ring-primary/50 ${resultImage === item.imageUrl ? "ring-2 ring-primary" : ""}`}
                    >
                      <img src={item.imageUrl} alt={item.prompt} className="aspect-square w-full object-cover" />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-1">
                        <p className="truncate text-[9px] text-white leading-tight">{item.prompt}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <MediaPickerDialog
        open={showReferencePicker}
        onOpenChange={setShowReferencePicker}
        onSelect={(url, fileName) => { urlToBase64(url).then(d => { setReferenceImage(d); setReferenceFileName(fileName); }).catch(() => toast({ title: "Failed to load image", variant: "destructive" })); setShowReferencePicker(false); }}
        title="Choose Reference Design"
      />
      <MediaPickerDialog
        open={showLogoPicker}
        onOpenChange={setShowLogoPicker}
        onSelect={(url, fileName) => { urlToBase64(url).then(d => { setLogoImage(d); setLogoFileName(fileName); }).catch(() => toast({ title: "Failed to load image", variant: "destructive" })); setShowLogoPicker(false); }}
        title="Choose Logo"
      />
    </>
  );
}
