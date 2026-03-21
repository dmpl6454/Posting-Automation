"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  Wand2, Pencil, Loader2, Download, Save, ArrowRight, Upload, ImagePlus,
  Trash2, Square, RectangleHorizontal, RectangleVertical, Monitor, Smartphone,
  X, Clock, Sparkles, FolderOpen, Image,
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
  description?: string;
}

const PROMPT_MAX_LENGTH = 2000;

interface ImageTabProps {
  onImageGenerated?: (dataUrl: string) => void;
}

export function ImageTab({ onImageGenerated }: ImageTabProps = {}) {
  const router = useRouter();
  const { toast } = useToast();

  // Generate Mode State
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

  // Base image for generation (user's own photo)
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [baseImageFileName, setBaseImageFileName] = useState("");
  const baseImageInputRef = useRef<HTMLInputElement>(null);

  // Media Picker State
  const [showBaseImagePicker, setShowBaseImagePicker] = useState(false);
  const [showReferencePicker, setShowReferencePicker] = useState(false);
  const [showLogoPicker, setShowLogoPicker] = useState(false);
  const [showEditImagePicker, setShowEditImagePicker] = useState(false);

  // Edit Mode State
  const [editPrompt, setEditPrompt] = useState("");
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Result State
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [resultDescription, setResultDescription] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("generate");

  // History
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // tRPC mutations
  const generateMutation = trpc.image.generate.useMutation({
    onError: (err: any) => {
      toast({ title: "Generation failed", description: err.message || "Something went wrong.", variant: "destructive" });
    },
  });

  const editMutation = trpc.image.edit.useMutation({
    onError: (err: any) => {
      toast({ title: "Edit failed", description: err.message || "Something went wrong.", variant: "destructive" });
    },
  });

  const saveMutation = trpc.image.saveGenerated.useMutation({
    onError: (err: any) => { toast({ title: "Save failed", description: err.message || "Could not save image.", variant: "destructive" }); },
  });

  // Helpers
  const addToHistory = (imageUrl: string, prompt: string, description?: string | null) => {
    setHistory((prev) => [{ id: crypto.randomUUID(), imageUrl, prompt, timestamp: new Date(), description: description || undefined }, ...prev]);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const extractBase64 = (dataUrl: string) => {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    return match ? { base64: match[2]!, mimeType: match[1]! } : null;
  };

  const handleGenerate = async () => {
    if (!generatePrompt.trim()) return;
    const refs: Array<{ base64: string; mimeType?: string }> = [];
    // Base image is the primary reference (user's own photo)
    if (baseImage) { const ref = extractBase64(baseImage); if (ref) refs.push(ref); }
    if (referenceImage) { const ref = extractBase64(referenceImage); if (ref) refs.push(ref); }
    if (logoImage) { const logo = extractBase64(logoImage); if (logo) refs.push(logo); }

    let fullPrompt = generatePrompt;
    if (baseImage) {
      const extras = [];
      if (referenceImage) extras.push("a reference design for style/layout inspiration");
      if (logoImage) extras.push("a logo to incorporate");
      const extrasNote = extras.length > 0 ? ` I've also attached ${extras.join(" and ")}.` : "";
      fullPrompt = `${generatePrompt}\n\nI've attached my own image as the base. Please use it as the primary visual reference and transform/generate based on it.${extrasNote}`;
    } else if (referenceImage && logoImage) {
      fullPrompt = `${generatePrompt}\n\nI've attached a reference design image and a logo. Please use the reference as style/layout inspiration and incorporate the logo into the generated image.`;
    } else if (referenceImage) {
      fullPrompt = `${generatePrompt}\n\nI've attached a reference design image. Please use it as style/layout inspiration for the generated image.`;
    } else if (logoImage) {
      fullPrompt = `${generatePrompt}\n\nI've attached a logo image. Please incorporate this logo into the generated image.`;
    }

    try {
      const data = await generateMutation.mutateAsync({
        prompt: fullPrompt,
        provider: imageProvider,
        ...(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro"
          ? { model: model as any, aspectRatio, imageSize, ...(refs.length > 0 ? { referenceImages: refs } : {}) }
          : imageProvider === "dall-e"
          ? { aspectRatio }
          : { aspectRatio }), // meta-ai
      });
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      setResultImage(imageUrl);
      setResultDescription(data.description || null);
      addToHistory(imageUrl, generatePrompt, data.description);
      toast({ title: "Image generated!", description: "Your image is ready." });

      if (onImageGenerated) {
        onImageGenerated(imageUrl);
        toast({ title: "Image added to post!" });
      }
    } catch {
      // onError handles toast
    }
  };

  const handleBaseImageSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) { toast({ title: "Invalid file", description: "Please upload an image file.", variant: "destructive" }); return; }
    const dataUrl = await fileToBase64(file);
    setBaseImage(dataUrl);
    setBaseImageFileName(file.name);
  };

  const handleBaseImageFromLibrary = async (url: string, fileName: string) => {
    try {
      const dataUrl = await urlToBase64(url);
      setBaseImage(dataUrl);
      setBaseImageFileName(fileName);
    } catch {
      toast({ title: "Failed to load image", description: "Could not load the selected image.", variant: "destructive" });
    }
  };

  const handleEditImageFromLibrary = async (url: string, fileName: string) => {
    try {
      const dataUrl = await urlToBase64(url);
      setUploadedImage(dataUrl);
      setUploadedFileName(fileName);
    } catch {
      toast({ title: "Failed to load image", description: "Could not load the selected image.", variant: "destructive" });
    }
  };

  const handleReferenceSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) { toast({ title: "Invalid file", description: "Please upload an image file.", variant: "destructive" }); return; }
    const dataUrl = await fileToBase64(file);
    setReferenceImage(dataUrl);
    setReferenceFileName(file.name);
  };

  const handleLogoSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) { toast({ title: "Invalid file", description: "Please upload an image file.", variant: "destructive" }); return; }
    const dataUrl = await fileToBase64(file);
    setLogoImage(dataUrl);
    setLogoFileName(file.name);
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

  const handleReferenceFromLibrary = async (url: string, fileName: string) => {
    try {
      const dataUrl = await urlToBase64(url);
      setReferenceImage(dataUrl);
      setReferenceFileName(fileName);
    } catch {
      toast({ title: "Failed to load image", description: "Could not load the selected image.", variant: "destructive" });
    }
  };

  const handleLogoFromLibrary = async (url: string, fileName: string) => {
    try {
      const dataUrl = await urlToBase64(url);
      setLogoImage(dataUrl);
      setLogoFileName(fileName);
    } catch {
      toast({ title: "Failed to load image", description: "Could not load the selected image.", variant: "destructive" });
    }
  };

  const handleEdit = async () => {
    if (!editPrompt.trim() || !uploadedImage) return;
    let imageBase64 = uploadedImage;
    let imageMimeType = "image/jpeg";
    if (uploadedImage.startsWith("data:")) {
      const match = uploadedImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) { imageMimeType = match[1] ?? "image/jpeg"; imageBase64 = match[2] ?? ""; }
    }
    try {
      const data = await editMutation.mutateAsync({ prompt: editPrompt, imageBase64, imageMimeType });
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      setResultImage(imageUrl);
      setResultDescription(data.description || null);
      addToHistory(imageUrl, editPrompt, data.description);
      toast({ title: "Image edited!", description: "Your edited image is ready." });

      if (onImageGenerated) {
        onImageGenerated(imageUrl);
        toast({ title: "Image added to post!" });
      }
    } catch {
      // onError handles toast
    }
  };

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) { toast({ title: "Invalid file", description: "Please select an image file.", variant: "destructive" }); return; }
    const base64 = await fileToBase64(file);
    setUploadedImage(base64);
    setUploadedFileName(file.name);
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (file) handleFileSelect(file); };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    const file = e.dataTransfer.files?.[0]; if (file) handleFileSelect(file);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); }, []);
  const onDragLeave = useCallback(() => { setIsDragOver(false); }, []);

  const handleDownload = () => {
    if (!resultImage) return;
    const a = document.createElement("a"); a.href = resultImage; a.download = `image-studio-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleSaveToLibrary = async () => {
    if (!resultImage) return;
    let imageBase64 = resultImage; let mimeType = "image/png";
    if (resultImage.startsWith("data:")) {
      const match = resultImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) { mimeType = match[1] ?? "image/png"; imageBase64 = match[2] ?? ""; }
    }
    try {
      await saveMutation.mutateAsync({ imageBase64, mimeType, fileName: `ai-image-${Date.now()}.png` });
      toast({ title: "Saved!", description: "Image saved to your media library." });
    } catch {
      // onError handles toast
    }
  };

  const handleUseInPost = async () => {
    if (!resultImage) return;
    let imageBase64 = resultImage; let mimeType = "image/png";
    if (resultImage.startsWith("data:")) {
      const match = resultImage.match(/^data:([^;]+);base64,(.+)$/);
      if (match) { mimeType = match[1] ?? "image/png"; imageBase64 = match[2] ?? ""; }
    }
    try {
      toast({ title: "Saving image..." });
      const saved = await saveMutation.mutateAsync({ imageBase64, mimeType, fileName: `ai-image-${Date.now()}.png` });
      if (saved?.url) {
        router.push(`/dashboard/content-agent?tab=compose&aiImage=${encodeURIComponent(saved.url)}&aiMediaId=${encodeURIComponent(saved.id)}`);
      } else {
        toast({ title: "Save succeeded but no URL returned", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Could not save image", description: err?.message || "Please try again.", variant: "destructive" });
    }
  };

  const handleEditThisImage = () => {
    if (!resultImage) return;
    setUploadedImage(resultImage); setUploadedFileName("generated-image.png"); setEditPrompt(""); setActiveTab("edit");
  };

  const handleHistorySelect = (item: HistoryItem) => {
    setResultImage(item.imageUrl); setResultDescription(item.description || null);
  };

  const isGenerating = generateMutation.isPending;
  const isEditing = editMutation.isPending;
  const isSaving = saveMutation.isPending;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left Column - Controls */}
        <div className="space-y-6">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="generate" className="gap-2"><Wand2 className="h-4 w-4" />Generate</TabsTrigger>
              <TabsTrigger value="edit" className="gap-2"><Pencil className="h-4 w-4" />Edit</TabsTrigger>
            </TabsList>

            {/* GENERATE TAB */}
            <TabsContent value="generate" className="space-y-4">

              {/* ── Your Image (base for generation) ── */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Image className="h-4 w-4 text-primary" />
                    <CardTitle className="text-base">Your Image</CardTitle>
                    <span className="text-xs text-muted-foreground">(optional)</span>
                  </div>
                  <CardDescription>Upload your own photo or pick from your library — AI will generate based on it</CardDescription>
                </CardHeader>
                <CardContent>
                  <input
                    ref={baseImageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBaseImageSelect(f); e.target.value = ""; }}
                  />
                  {baseImage ? (
                    <div className="space-y-2">
                      <div className="relative overflow-hidden rounded-lg border">
                        <img src={baseImage} alt="Base" className="w-full object-contain" style={{ maxHeight: 220 }} />
                        <button
                          onClick={() => { setBaseImage(null); setBaseImageFileName(""); }}
                          className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{baseImageFileName}</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => baseImageInputRef.current?.click()}
                        className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/30"
                      >
                        <Upload className="h-6 w-6" />
                        <span className="font-medium">Upload Photo</span>
                        <span className="text-xs opacity-70">JPG, PNG, WebP</span>
                      </button>
                      <button
                        onClick={() => setShowBaseImagePicker(true)}
                        className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/30"
                      >
                        <FolderOpen className="h-6 w-6" />
                        <span className="font-medium">From Library</span>
                        <span className="text-xs opacity-70">Your saved media</span>
                      </button>
                    </div>
                  )}
                  {(imageProvider === "dall-e" || imageProvider === "meta-ai") && baseImage && (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                      Image input works best with Nano Banana. DALL-E and Meta AI are text-only.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Prompt</CardTitle><CardDescription>Describe the image you want to create</CardDescription></CardHeader>
                <CardContent className="space-y-3">
                  <Textarea value={generatePrompt} onChange={(e) => { if (e.target.value.length <= PROMPT_MAX_LENGTH) setGeneratePrompt(e.target.value); }} placeholder="Describe the image you want to create..." className="min-h-[140px] resize-none" />
                  <div className="flex justify-end"><span className={`text-xs tabular-nums ${generatePrompt.length >= PROMPT_MAX_LENGTH ? "text-destructive" : "text-muted-foreground"}`}>{generatePrompt.length} / {PROMPT_MAX_LENGTH}</span></div>
                </CardContent>
              </Card>

              {/* Provider selector */}
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">AI Provider</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { value: "nano-banana", label: "Nano Banana", sub: "Gemini" },
                      { value: "nano-banana-pro", label: "Nano Banana Pro", sub: "Gemini Pro" },
                      { value: "dall-e", label: "DALL-E 3", sub: "OpenAI" },
                      { value: "meta-ai", label: "Meta AI", sub: "FLUX.1" },
                    ].map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setImageProvider(p.value as typeof imageProvider)}
                        className={`flex flex-col items-center rounded-lg border px-3 py-2.5 text-xs transition-all ${
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
                </CardContent>
              </Card>

              {/* Nano Banana model selector */}
              {(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro") && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">Model</CardTitle></CardHeader>
                  <CardContent>
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
                      <SelectContent>
                        {MODELS.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            <span className="flex items-center gap-2">{m.label}{m.badge && <Badge variant="secondary" className="text-[10px]">{m.badge}</Badge>}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Aspect Ratio</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-5 gap-2">
                    {ASPECT_RATIOS.map((ar) => {
                      const Icon = ar.icon;
                      return (
                        <button key={ar.value} onClick={() => setAspectRatio(ar.value)} className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs transition-all ${aspectRatio === ar.value ? "border-primary bg-primary/5 text-primary ring-1 ring-primary" : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50"}`}>
                          <Icon className="h-5 w-5" /><span className="font-medium">{ar.value}</span><span className="text-[10px]">{ar.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Image size — only for Nano Banana */}
              {(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro") && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">Image Size</CardTitle></CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-4 gap-2">
                      {IMAGE_SIZES.map((size) => (
                        <button key={size.value} onClick={() => setImageSize(size.value)} className={`rounded-lg border px-3 py-2 text-sm font-medium transition-all ${imageSize === size.value ? "border-primary bg-primary/5 text-primary ring-1 ring-primary" : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50"}`}>{size.label}</button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Attachments</CardTitle><CardDescription>Add a reference design or logo (optional)</CardDescription></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <input ref={referenceInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleReferenceSelect(f); e.target.value = ""; }} />
                      {referenceImage ? (
                        <div className="relative group rounded-lg border overflow-hidden">
                          <img src={referenceImage} alt="Reference" className="w-full h-24 object-cover" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button onClick={() => { setReferenceImage(null); setReferenceFileName(""); }} className="rounded-full bg-white/90 p-1.5"><X className="h-3.5 w-3.5 text-black" /></button>
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate px-2 py-1">{referenceFileName}</p>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <button onClick={() => referenceInputRef.current?.click()} className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed p-3 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors"><Upload className="h-4 w-4" /><span className="font-medium">Upload Reference</span></button>
                          <button onClick={() => setShowReferencePicker(true)} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed p-2 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors"><FolderOpen className="h-3.5 w-3.5" /><span className="font-medium">From Library</span></button>
                        </div>
                      )}
                    </div>
                    <div>
                      <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLogoSelect(f); e.target.value = ""; }} />
                      {logoImage ? (
                        <div className="relative group rounded-lg border overflow-hidden">
                          <img src={logoImage} alt="Logo" className="w-full h-24 object-contain bg-muted/30 p-2" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button onClick={() => { setLogoImage(null); setLogoFileName(""); }} className="rounded-full bg-white/90 p-1.5"><X className="h-3.5 w-3.5 text-black" /></button>
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate px-2 py-1">{logoFileName}</p>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <button onClick={() => logoInputRef.current?.click()} className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed p-3 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors"><ImagePlus className="h-4 w-4" /><span className="font-medium">Upload Logo</span></button>
                          <button onClick={() => setShowLogoPicker(true)} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed p-2 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors"><FolderOpen className="h-3.5 w-3.5" /><span className="font-medium">From Library</span></button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Button onClick={handleGenerate} disabled={!generatePrompt.trim() || isGenerating} className="w-full gap-2" size="lg">
                {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {isGenerating ? "Generating..." : "Generate Image"}
              </Button>
            </TabsContent>

            {/* EDIT TAB */}
            <TabsContent value="edit" className="space-y-4">
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Source Image</CardTitle><CardDescription>Upload or drag an image to edit</CardDescription></CardHeader>
                <CardContent>
                  {uploadedImage ? (
                    <div className="relative">
                      <img src={uploadedImage} alt="Uploaded for editing" className="w-full rounded-lg border object-contain" style={{ maxHeight: "300px" }} />
                      <div className="mt-2 flex items-center justify-between">
                        <span className="truncate text-xs text-muted-foreground">{uploadedFileName}</span>
                        <Button variant="ghost" size="sm" onClick={() => { setUploadedImage(null); setUploadedFileName(""); if (fileInputRef.current) fileInputRef.current.value = ""; }} className="gap-1 text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" />Remove</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave} onClick={() => fileInputRef.current?.click()} className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors ${isDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50"}`}>
                        <Upload className="h-8 w-8 text-muted-foreground" />
                        <div className="text-center"><p className="text-sm font-medium">Drop an image here or click to upload</p><p className="text-xs text-muted-foreground">PNG, JPG, WebP up to 10MB</p></div>
                      </div>
                      <button
                        onClick={() => setShowEditImagePicker(true)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed p-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/30"
                      >
                        <FolderOpen className="h-4 w-4" />
                        Pick from Media Library
                      </button>
                    </div>
                  )}
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileInputChange} className="hidden" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Edit Instructions</CardTitle><CardDescription>Describe the changes you want</CardDescription></CardHeader>
                <CardContent className="space-y-3">
                  <Textarea value={editPrompt} onChange={(e) => { if (e.target.value.length <= PROMPT_MAX_LENGTH) setEditPrompt(e.target.value); }} placeholder="Describe the changes you want..." className="min-h-[120px] resize-none" />
                  <div className="flex justify-end"><span className={`text-xs tabular-nums ${editPrompt.length >= PROMPT_MAX_LENGTH ? "text-destructive" : "text-muted-foreground"}`}>{editPrompt.length} / {PROMPT_MAX_LENGTH}</span></div>
                </CardContent>
              </Card>

              <Button onClick={handleEdit} disabled={!editPrompt.trim() || !uploadedImage || isEditing} className="w-full gap-2" size="lg">
                {isEditing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
                {isEditing ? "Editing..." : "Edit Image"}
              </Button>
            </TabsContent>
          </Tabs>
        </div>

        {/* Right Column - Preview & Results */}
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader className="pb-3"><CardTitle className="text-base">Preview</CardTitle></CardHeader>
            <CardContent>
              {isGenerating || isEditing ? (
                <div className="space-y-4"><Skeleton className="aspect-square w-full rounded-lg" /><div className="flex gap-2"><Skeleton className="h-9 flex-1 rounded-md" /><Skeleton className="h-9 flex-1 rounded-md" /></div></div>
              ) : resultImage ? (
                <div className="space-y-4">
                  <div className="overflow-hidden rounded-lg border bg-muted/30 dark:bg-muted/10"><img src={resultImage} alt="Generated result" className="w-full object-contain" style={{ maxHeight: "500px" }} /></div>
                  {resultDescription && (<div className="rounded-lg border bg-muted/30 p-3 dark:bg-muted/10"><p className="text-xs font-medium text-muted-foreground">AI Description</p><p className="mt-1 text-sm">{resultDescription}</p></div>)}
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" onClick={handleSaveToLibrary} disabled={isSaving} className="gap-2">{isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save to Media Library</Button>
                    <Button variant="outline" onClick={handleDownload} className="gap-2"><Download className="h-4 w-4" />Download</Button>
                    <Button variant="secondary" onClick={handleUseInPost} className="gap-2"><ArrowRight className="h-4 w-4" />Use in Post</Button>
                    <Button variant="secondary" onClick={handleEditThisImage} className="gap-2"><Pencil className="h-4 w-4" />Edit This Image</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
                  <ImagePlus className="mb-3 h-12 w-12 text-muted-foreground/50" /><p className="text-sm font-medium text-muted-foreground">No image generated yet</p><p className="mt-1 text-xs text-muted-foreground/70">Write a prompt and click Generate to create an image</p>
                </div>
              )}
            </CardContent>
          </Card>

          {history.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between"><CardTitle className="text-base">Session History</CardTitle><Button variant="ghost" size="sm" onClick={() => setHistory([])} className="gap-1 text-xs text-muted-foreground"><Trash2 className="h-3 w-3" />Clear</Button></div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2">
                  {history.map((item) => (
                    <button key={item.id} onClick={() => handleHistorySelect(item)} className={`group relative overflow-hidden rounded-lg border transition-all hover:ring-2 hover:ring-primary/50 ${resultImage === item.imageUrl ? "ring-2 ring-primary" : ""}`}>
                      <img src={item.imageUrl} alt={item.prompt} className="aspect-square w-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100"><p className="truncate text-[10px] text-white">{item.prompt}</p></div>
                      <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100"><Badge variant="secondary" className="text-[9px]"><Clock className="mr-0.5 h-2.5 w-2.5" />{item.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Badge></div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <MediaPickerDialog
        open={showBaseImagePicker}
        onOpenChange={setShowBaseImagePicker}
        onSelect={handleBaseImageFromLibrary}
        title="Choose Your Image"
      />
      <MediaPickerDialog
        open={showReferencePicker}
        onOpenChange={setShowReferencePicker}
        onSelect={handleReferenceFromLibrary}
        title="Choose Reference Design"
      />
      <MediaPickerDialog
        open={showLogoPicker}
        onOpenChange={setShowLogoPicker}
        onSelect={handleLogoFromLibrary}
        title="Choose Logo"
      />
      <MediaPickerDialog
        open={showEditImagePicker}
        onOpenChange={setShowEditImagePicker}
        onSelect={handleEditImageFromLibrary}
        title="Choose Image to Edit"
      />
    </div>
  );
}
