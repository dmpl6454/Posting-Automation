"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "~/lib/trpc/client";
import { useActiveTask } from "~/lib/active-task";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
  Zap, LayoutGrid, Palette, Image,
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

const CAROUSEL_COUNTS = [3, 4, 5, 6, 7, 10];

const CAROUSEL_TEMPLATES = [
  {
    id: "instagram-engagement",
    name: "Instagram Engagement",
    description: "6-slide hook → CTA carousel",
    slides: [
      `COVER SLIDE — Hook: Bold cinematic headline, editorial magazine look, premium typography, dramatic high-contrast background. Emotion: curiosity + urgency. 4:5 vertical format. Subtle page branding at bottom.`,
      `CONTEXT SLIDE: Clean editorial layout, left-aligned text block, short impactful paragraph. Highlight 2–3 bold keywords visually. Readable social-media-optimized typography. 4:5 vertical format.`,
      `KEY DETAILS SLIDE: 2–3 bullet point insights, one highlighted keyword per bullet. Bold typography, clean light background, editorial infographic style. 4:5 vertical format.`,
      `REACTION / QUOTE SLIDE: Bold large pull-quote centered on slide, subtle dark textured background, emphasis on key words. Premium editorial feel. 4:5 vertical format.`,
      `IMPACT SLIDE — What's Next: Forward-looking excitement, bold headline, timeline hint visual. Speculative exciting tone. Clean cinematic layout. 4:5 vertical format.`,
      `CLOSING CTA SLIDE: Minimal clean design. Bold headline "What do YOU think?" with comment, follow, and save/share call-to-actions as visual elements. Community-focused, page branding. 4:5 vertical format.`,
    ],
  },
];

interface HistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  timestamp: Date;
}

const PROMPT_MAX_LENGTH = 2000;

interface ImageGenerationPanelProps {
  onAddToPost: (imageDataUrl: string) => void | Promise<void>;
  postContent?: string;
}

// Extract dominant colors from an image data URL using Canvas API (browser only)
async function extractBrandColors(imageDataUrl: string): Promise<string[]> {
  if (typeof window === "undefined" || typeof document === "undefined") return [];
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const size = 80; // Downscale for speed
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve([]); return; }
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const colorMap: Record<string, number> = {};
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          const a = data[i + 3]!;
          if (a < 128) continue; // skip transparent
          // Skip near-white and near-black
          if (r > 230 && g > 230 && b > 230) continue;
          if (r < 25 && g < 25 && b < 25) continue;
          // Quantize to 32-step buckets
          const rq = Math.round(r / 32) * 32;
          const gq = Math.round(g / 32) * 32;
          const bq = Math.round(b / 32) * 32;
          const hex = `#${rq.toString(16).padStart(2, "0")}${gq.toString(16).padStart(2, "0")}${bq.toString(16).padStart(2, "0")}`;
          colorMap[hex] = (colorMap[hex] ?? 0) + 1;
        }
        const top = Object.entries(colorMap)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([hex]) => hex);
        resolve(top);
      } catch {
        resolve([]);
      }
    };
    img.onerror = () => resolve([]);
    img.src = imageDataUrl;
  });
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
  const [aspectRatio, setAspectRatio] = useState("4:5");
  const [imageSize, setImageSize] = useState("1K");
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [referenceFileName, setReferenceFileName] = useState("");
  const [logoImage, setLogoImage] = useState<string | null>(null);
  const [logoFileName, setLogoFileName] = useState("");
  const [brandColors, setBrandColors] = useState<string[]>([]);
  const [useBrandColors, setUseBrandColors] = useState(true);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Auto-add & Carousel
  const [autoAddToPost, setAutoAddToPost] = useState(false);
  const [carouselMode, setCarouselMode] = useState(false);
  const [carouselCount, setCarouselCount] = useState(3);
  const [carouselImages, setCarouselImages] = useState<string[]>([]);
  const [carouselProgress, setCarouselProgress] = useState(0);
  const [isGeneratingCarousel, setIsGeneratingCarousel] = useState(false);
  const [perSlidePrompts, setPerSlidePrompts] = useState<string[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);

  // Edit state
  const [editPrompt, setEditPrompt] = useState("");
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Upload-own-image state
  const [ownImage, setOwnImage] = useState<string | null>(null);
  const [ownImageFileName, setOwnImageFileName] = useState("");
  const ownImageInputRef = useRef<HTMLInputElement>(null);
  const [isOwnDragOver, setIsOwnDragOver] = useState(false);

  // Result & history
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Media pickers
  const [showReferencePicker, setShowReferencePicker] = useState(false);
  const [showLogoPicker, setShowLogoPicker] = useState(false);

  // Extract brand colors when logo is set
  useEffect(() => {
    if (logoImage) {
      extractBrandColors(logoImage).then((colors) => {
        setBrandColors(colors);
      });
    } else {
      setBrandColors([]);
    }
  }, [logoImage]);

  const addToHistory = (imageUrl: string, prompt: string) => {
    setHistory((prev) => [{ id: crypto.randomUUID(), imageUrl, prompt, timestamp: new Date() }, ...prev]);
  };

  const parseContentSections = (content: string): string[] => {
    // Numbered items: 1. item\n2. item
    const numbered = content.split(/\n(?=\d+[\.\)]\s)/);
    if (numbered.length > 1) return numbered.map((s) => s.trim()).filter(Boolean);
    // Bullet points: - or * or •
    const bulleted = content.split(/\n(?=[-•*]\s)/);
    if (bulleted.length > 1) return bulleted.map((s) => s.trim()).filter(Boolean);
    // Double-newline paragraphs
    const paragraphs = content.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
    if (paragraphs.length > 1) return paragraphs;
    // Single newlines (lines with at least 10 chars)
    const lines = content.split(/\n/).map((s) => s.trim()).filter((s) => s.length >= 10);
    if (lines.length > 1) return lines;
    return [content.trim()];
  };

  const buildFullPrompt = (base: string, slideIndex?: number, totalSlides?: number, slideContent?: string) => {
    let fullPrompt = base;

    // Merge post content — use slide-specific section if provided, or full postContent if mergeContent is on
    if (slideContent) {
      fullPrompt = `${fullPrompt}\n\nThis slide is about:\n"${slideContent}"`;
    } else if (mergeContent && postContent?.trim()) {
      fullPrompt = `${fullPrompt}\n\nBased on this post content:\n"${postContent.trim()}"`;
    }

    // Apply news style preset
    if (selectedNewsStyle) {
      const style = NEWS_STYLES.find((s) => s.value === selectedNewsStyle);
      if (style) fullPrompt = `${style.prompt}\n\nImage topic: ${fullPrompt}`;
    }

    // Add brand colors from logo
    if (useBrandColors && brandColors.length > 0) {
      fullPrompt += `\n\nBrand color palette (use these as primary colors throughout the image): ${brandColors.join(", ")}.`;
    }

    // Attachment instructions
    if (referenceImage && logoImage) {
      fullPrompt += `\n\nI've attached a reference design image and a logo. Please use the reference as style/layout inspiration and incorporate the logo into the generated image.`;
    } else if (referenceImage) {
      fullPrompt += `\n\nI've attached a reference design image. Please use it as style/layout inspiration for the generated image.`;
    } else if (logoImage) {
      fullPrompt += `\n\nI've attached a logo image. Please incorporate this logo into the generated image.`;
    }

    // Carousel slide instruction
    if (slideIndex !== undefined && totalSlides !== undefined) {
      fullPrompt += `\n\nThis is slide ${slideIndex + 1} of ${totalSlides} in a carousel series. Keep a consistent visual style across all slides. ${slideIndex === 0 ? "This is the cover/intro slide." : slideIndex === totalSlides - 1 ? "This is the final/closing slide." : `This is slide ${slideIndex + 1}, continuing the story.`}`;
    }

    return fullPrompt;
  };

  const generateMutation = trpc.image.generate.useMutation({
    onSuccess: (data: any) => {
      const imageUrl = `data:${data.mimeType || "image/png"};base64,${data.imageBase64}`;
      setResultImage(imageUrl);
      addToHistory(imageUrl, generatePrompt);
      toast({ title: "Image generated!", description: "Your image is ready." });
      if (autoAddToPost) {
        onAddToPost(imageUrl);
        toast({ title: "Added to post automatically!" });
      }
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

  const generateSingle = (prompt: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const refs: Array<{ base64: string; mimeType?: string }> = [];
      if (referenceImage) { const ref = extractBase64(referenceImage); if (ref) refs.push(ref); }
      if (logoImage) { const logo = extractBase64(logoImage); if (logo) refs.push(logo); }

      const params = {
        prompt,
        provider: imageProvider,
        ...(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro"
          ? { model: model as any, aspectRatio, imageSize, ...(refs.length > 0 ? { referenceImages: refs } : {}) }
          : { aspectRatio }),
      };

      // Use fetch directly to avoid mutation state conflicts during carousel
      fetch("/api/trpc/image.generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: params }),
      })
        .then((r) => r.json())
        .then((json) => {
          const data = json?.result?.data?.json ?? json?.result?.data;
          if (data?.imageBase64) {
            resolve(`data:${data.mimeType || "image/png"};base64,${data.imageBase64}`);
          } else {
            reject(new Error(json?.error?.message || "Generation failed"));
          }
        })
        .catch(reject);
    });
  };

  const handleGenerate = () => {
    if (!generatePrompt.trim()) return;

    if (carouselMode) {
      handleGenerateCarousel();
      return;
    }

    const refs: Array<{ base64: string; mimeType?: string }> = [];
    if (referenceImage) { const ref = extractBase64(referenceImage); if (ref) refs.push(ref); }
    if (logoImage) { const logo = extractBase64(logoImage); if (logo) refs.push(logo); }

    generateMutation.mutate({
      prompt: buildFullPrompt(generatePrompt),
      provider: imageProvider,
      ...(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro"
        ? { model: model as any, aspectRatio, imageSize, ...(refs.length > 0 ? { referenceImages: refs } : {}) }
        : { aspectRatio }),
    });
  };

  const handleGenerateCarousel = async () => {
    if (!generatePrompt.trim()) return;

    let slidePrompts: string[] | undefined; // per-slide base prompts (from generatePrompt bullets)
    let slideContents: string[] | undefined; // per-slide post content sections
    let count = carouselCount;

    // Template per-slide prompts take priority
    if (perSlidePrompts.length > 0) {
      slidePrompts = perSlidePrompts;
      count = perSlidePrompts.length;
    // If the prompt itself has multiple bullet/numbered items, use each as its own slide prompt
    } else if (parseContentSections(generatePrompt).length > 1) {
      const promptSections = parseContentSections(generatePrompt);
      slidePrompts = promptSections;
      count = promptSections.length;
      setCarouselCount(count);
    } else if (postContent?.trim()) {
      // Always check postContent for sections when in carousel mode (regardless of mergeContent toggle)
      const sections = parseContentSections(postContent);
      if (sections.length > 1) {
        slideContents = sections;
        count = sections.length;
        setCarouselCount(count);
        // Auto-enable mergeContent so buildFullPrompt uses the per-slide content
        setMergeContent(true);
      }
    }

    setIsGeneratingCarousel(true);
    setCarouselImages([]);
    setCarouselProgress(0);

    const images: string[] = [];
    for (let i = 0; i < count; i++) {
      try {
        setCarouselProgress(i);
        const slideBase = slidePrompts?.[i] ?? generatePrompt;
        // If using template, append generatePrompt as extra style/topic notes
        const basePrompt = (perSlidePrompts.length > 0 && generatePrompt.trim())
          ? `${slideBase}\n\nExtra style/topic context: ${generatePrompt.trim()}`
          : slideBase;
        const prompt = buildFullPrompt(basePrompt, i, count, slideContents?.[i]);
        const imageUrl = await generateSingle(prompt);
        images.push(imageUrl);
        setCarouselImages([...images]);
        addToHistory(imageUrl, `Slide ${i + 1}: ${slidePrompts?.[i] ?? generatePrompt}`);
      } catch (err: any) {
        toast({ title: `Slide ${i + 1} failed`, description: err.message, variant: "destructive" });
      }
    }

    setIsGeneratingCarousel(false);
    setCarouselProgress(count);
    toast({ title: `Carousel ready!`, description: `${images.length} of ${count} slides generated.` });

    if (autoAddToPost && images.length > 0) {
      for (const img of images) {
        await onAddToPost(img);
      }
      toast({ title: "All carousel slides added to post!" });
    }
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

  const handleDownload = (src?: string) => {
    const url = src || resultImage;
    if (!url) return;
    const a = document.createElement("a"); a.href = url; a.download = `ai-image-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleSaveToLibrary = (src?: string) => {
    const url = src || resultImage;
    if (!url) return;
    let imageBase64 = url; let mimeType = "image/png";
    if (url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) { mimeType = match[1] ?? "image/png"; imageBase64 = match[2] ?? ""; }
    }
    saveMutation.mutate({ imageBase64, mimeType, fileName: `ai-image-${Date.now()}.png` });
  };

  const handleAddToPost = (src?: string) => {
    const url = src || resultImage;
    if (!url) return;
    onAddToPost(url);
  };

  const handleAddAllCarouselToPost = async () => {
    for (const img of carouselImages) {
      await onAddToPost(img);
    }
    toast({ title: `${carouselImages.length} slides added to post!` });
  };

  const isGenerating = generateMutation.isPending || isGeneratingCarousel;
  const isEditing = editMutation.isPending;
  const isSaving = saveMutation.isPending;
  const { addTask, removeTask, updateTask } = useActiveTask();

  // Track image generation as active task
  useEffect(() => {
    if (generateMutation.isPending) {
      addTask({
        id: "panel-image-gen",
        type: "image",
        label: "Generating image",
        description: generatePrompt.slice(0, 50) || "AI image",
        href: "/dashboard/content-agent",
        createdAt: Date.now(),
      });
    } else {
      removeTask("panel-image-gen");
    }
  }, [generateMutation.isPending]);

  // Track carousel generation with progress
  useEffect(() => {
    if (isGeneratingCarousel) {
      addTask({
        id: "panel-carousel-gen",
        type: "image",
        label: `Generating carousel (${carouselProgress}/${carouselCount})`,
        description: generatePrompt.slice(0, 40) || "Carousel slides",
        href: "/dashboard/content-agent",
        createdAt: Date.now(),
      });
    } else {
      removeTask("panel-carousel-gen");
    }
  }, [isGeneratingCarousel, carouselProgress]);

  // Track image editing
  useEffect(() => {
    if (isEditing) {
      addTask({
        id: "panel-image-edit",
        type: "image",
        label: "Editing image",
        description: editPrompt.slice(0, 50) || "AI edit",
        href: "/dashboard/content-agent",
        createdAt: Date.now(),
      });
    } else {
      removeTask("panel-image-edit");
    }
  }, [isEditing]);

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
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="generate" className="gap-2"><Wand2 className="h-3.5 w-3.5" />Generate</TabsTrigger>
                <TabsTrigger value="edit" className="gap-2"><Pencil className="h-3.5 w-3.5" />Edit</TabsTrigger>
                <TabsTrigger value="upload" className="gap-2"><Image className="h-3.5 w-3.5" />Upload</TabsTrigger>
              </TabsList>

              {/* GENERATE TAB */}
              <TabsContent value="generate" className="space-y-3 mt-3">

                {/* Auto-add & Carousel toggles */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setAutoAddToPost(!autoAddToPost)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all ${autoAddToPost ? "border-green-500 bg-green-500/10 text-green-600 dark:text-green-400" : "border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary/50 hover:bg-muted/30"}`}
                  >
                    <Zap className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-medium">Auto-add to Post</span>
                    {autoAddToPost && <span className="ml-auto text-[10px]">ON</span>}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCarouselMode(!carouselMode)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all ${carouselMode ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400" : "border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary/50 hover:bg-muted/30"}`}
                  >
                    <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-medium">Carousel</span>
                    {carouselMode && <span className="ml-auto text-[10px]">ON</span>}
                  </button>
                </div>

                {/* Carousel count */}
                {carouselMode && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">Number of Slides</p>
                    <div className="flex gap-1.5">
                      {CAROUSEL_COUNTS.map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setCarouselCount(n)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${carouselCount === n ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400" : "border-border text-muted-foreground hover:bg-muted/50"}`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Carousel templates */}
                {carouselMode && (
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground">Templates</p>
                      {activeTemplateId && (
                        <button
                          type="button"
                          onClick={() => { setActiveTemplateId(null); setPerSlidePrompts([]); }}
                          className="text-[10px] text-muted-foreground hover:text-destructive"
                        >
                          Clear template
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {CAROUSEL_TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => {
                            if (activeTemplateId === tpl.id) {
                              setActiveTemplateId(null);
                              setPerSlidePrompts([]);
                            } else {
                              setActiveTemplateId(tpl.id);
                              setPerSlidePrompts([...tpl.slides]);
                              setCarouselCount(tpl.slides.length);
                            }
                          }}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${activeTemplateId === tpl.id ? "border-purple-500 bg-purple-500/10 text-purple-600 dark:text-purple-400" : "border-border text-muted-foreground hover:bg-muted/50"}`}
                        >
                          {tpl.name}
                          <span className="ml-1.5 text-[10px] opacity-60">{tpl.description}</span>
                        </button>
                      ))}
                    </div>

                    {/* Per-slide editable prompts */}
                    {perSlidePrompts.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {perSlidePrompts.map((p, i) => (
                          <div key={i} className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-2">
                            <p className="mb-1 text-[10px] font-semibold text-purple-600 dark:text-purple-400">
                              Slide {i + 1}
                            </p>
                            <textarea
                              value={p}
                              onChange={(e) => {
                                const updated = [...perSlidePrompts];
                                updated[i] = e.target.value;
                                setPerSlidePrompts(updated);
                              }}
                              rows={3}
                              className="w-full resize-none rounded border-0 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

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
                  <div className="grid grid-cols-6 gap-1.5">
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
                    {/* Reference image */}
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

                    {/* Logo */}
                    <div>
                      <input ref={logoInputRef} type="file" accept="image/*" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) { fileToBase64(f).then(d => { setLogoImage(d); setLogoFileName(f.name); }); } e.target.value = ""; }} />
                      {logoImage ? (
                        <div className="space-y-1">
                          <div className="relative group rounded-lg border overflow-hidden">
                            <img src={logoImage} alt="Logo" className="w-full h-16 object-contain bg-muted/30 p-1" />
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <button type="button" onClick={() => { setLogoImage(null); setLogoFileName(""); setBrandColors([]); }} className="rounded-full bg-white/90 p-1"><X className="h-3 w-3 text-black" /></button>
                            </div>
                            <p className="text-[9px] text-muted-foreground truncate px-1 py-0.5">{logoFileName}</p>
                          </div>
                          {/* Brand colors preview */}
                          {brandColors.length > 0 && (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1">
                                <Palette className="h-3 w-3 text-muted-foreground" />
                                <span className="text-[10px] text-muted-foreground">Brand Colors</span>
                                <button
                                  type="button"
                                  onClick={() => setUseBrandColors(!useBrandColors)}
                                  className={`ml-auto text-[10px] px-1.5 py-0.5 rounded transition-colors ${useBrandColors ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
                                >
                                  {useBrandColors ? "Applied" : "Apply"}
                                </button>
                              </div>
                              <div className="flex gap-1">
                                {brandColors.map((color) => (
                                  <div
                                    key={color}
                                    className={`h-5 flex-1 rounded border transition-all ${useBrandColors ? "ring-1 ring-primary/50" : "opacity-50"}`}
                                    style={{ backgroundColor: color }}
                                    title={color}
                                  />
                                ))}
                              </div>
                            </div>
                          )}
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

                {/* Generate from content — no prompt needed */}
                {postContent && !generatePrompt.trim() && (
                  <Button
                    variant="secondary"
                    className="w-full gap-2"
                    disabled={isGenerating}
                    onClick={() => {
                      const autoPrompt = `Create a visually striking social media image for this post:\n\n${postContent.slice(0, 500)}`;
                      setGeneratePrompt(autoPrompt);
                      // Trigger generate after state updates
                      setTimeout(() => {
                        const refs: Array<{ base64: string; mimeType?: string }> = [];
                        if (referenceImage) { const ref = extractBase64(referenceImage); if (ref) refs.push(ref); }
                        if (logoImage) { const logo = extractBase64(logoImage); if (logo) refs.push(logo); }
                        generateMutation.mutate({
                          prompt: buildFullPrompt(autoPrompt),
                          provider: imageProvider,
                          ...(imageProvider === "nano-banana" || imageProvider === "nano-banana-pro"
                            ? { model: model as any, aspectRatio, imageSize, ...(refs.length > 0 ? { referenceImages: refs } : {}) }
                            : { aspectRatio }),
                        });
                      }, 50);
                    }}
                  >
                    <Zap className="h-4 w-4" />
                    Generate from Content
                  </Button>
                )}

                <Button onClick={handleGenerate} disabled={!generatePrompt.trim() || isGenerating} className="w-full gap-2">
                  {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : carouselMode ? <LayoutGrid className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                  {isGeneratingCarousel
                    ? `Generating slide ${carouselProgress + 1} of ${carouselCount}...`
                    : generateMutation.isPending
                    ? "Generating..."
                    : carouselMode
                    ? `Generate ${carouselCount} Slides`
                    : "Generate Image"}
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

              {/* UPLOAD TAB */}
              <TabsContent value="upload" className="space-y-3 mt-3">
                <input
                  ref={ownImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      fileToBase64(f).then((d) => { setOwnImage(d); setOwnImageFileName(f.name); });
                    }
                    e.target.value = "";
                  }}
                />

                {ownImage ? (
                  <div className="space-y-3">
                    <div className="overflow-hidden rounded-lg border bg-muted/30">
                      <img src={ownImage} alt="Your image" className="w-full object-contain" style={{ maxHeight: "300px" }} />
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{ownImageFileName}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => { onAddToPost(ownImage); toast({ title: "Image added to post!" }); }}
                      >
                        <Plus className="h-3.5 w-3.5" />Add to Post
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSaveToLibrary(ownImage)}
                        disabled={isSaving}
                        className="gap-1.5"
                      >
                        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Save to Library
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setUploadedImage(ownImage); setUploadedFileName(ownImageFileName); setEditPrompt(""); setActiveTab("edit"); }}
                        className="gap-1.5"
                      >
                        <Pencil className="h-3.5 w-3.5" />Edit with AI
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setOwnImage(null); setOwnImageFileName(""); }}
                        className="gap-1.5 text-destructive hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    onDrop={(e) => {
                      e.preventDefault(); setIsOwnDragOver(false);
                      const f = e.dataTransfer.files?.[0];
                      if (f && f.type.startsWith("image/")) {
                        fileToBase64(f).then((d) => { setOwnImage(d); setOwnImageFileName(f.name); });
                      }
                    }}
                    onDragOver={(e) => { e.preventDefault(); setIsOwnDragOver(true); }}
                    onDragLeave={() => setIsOwnDragOver(false)}
                    onClick={() => ownImageInputRef.current?.click()}
                    className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 transition-colors ${isOwnDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50"}`}
                  >
                    <Image className="h-10 w-10 text-muted-foreground/50" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-muted-foreground">Upload your own image</p>
                      <p className="mt-1 text-xs text-muted-foreground/70">Drop an image or click to browse</p>
                    </div>
                  </div>
                )}

                {/* Library picker for own images */}
                <button
                  type="button"
                  onClick={() => setShowReferencePicker(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground hover:border-primary/50 hover:bg-muted/30 transition-colors"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>Choose from Media Library</span>
                </button>
              </TabsContent>
            </Tabs>

            {/* Carousel Result */}
            {carouselMode && (isGeneratingCarousel || carouselImages.length > 0) && (
              <div className="space-y-3 border-t pt-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    Carousel Slides {carouselImages.length > 0 ? `(${carouselImages.length}/${carouselCount})` : ""}
                  </p>
                  {carouselImages.length > 0 && !isGeneratingCarousel && (
                    <Button size="sm" variant="outline" onClick={handleAddAllCarouselToPost} className="h-7 gap-1.5 text-xs">
                      <Plus className="h-3 w-3" />Add All to Post
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: carouselCount }).map((_, i) => (
                    <div key={i} className="relative aspect-[4/5] overflow-hidden rounded-lg border bg-muted/30">
                      {carouselImages[i] ? (
                        <>
                          <img src={carouselImages[i]} alt={`Slide ${i + 1}`} className="h-full w-full object-cover" />
                          <div className="absolute inset-0 bg-black/50 opacity-0 hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1">
                            <button type="button" onClick={() => handleAddToPost(carouselImages[i])} className="rounded-md bg-white/90 px-2 py-1 text-[10px] font-medium text-black">Add</button>
                            <button type="button" onClick={() => handleDownload(carouselImages[i])} className="rounded-md bg-white/70 px-2 py-1 text-[10px] font-medium text-black">Save</button>
                          </div>
                          <div className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[9px] text-white">{i + 1}</div>
                        </>
                      ) : isGeneratingCarousel && i === carouselProgress ? (
                        <div className="flex h-full flex-col items-center justify-center gap-1">
                          <Loader2 className="h-5 w-5 animate-spin text-primary" />
                          <span className="text-[10px] text-muted-foreground">Generating...</span>
                        </div>
                      ) : (
                        <div className="flex h-full items-center justify-center">
                          <span className="text-[10px] text-muted-foreground/50">{i + 1}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Single Result */}
            {!carouselMode && (generateMutation.isPending || isEditing || resultImage) && (
              <div className="space-y-3 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">Result</p>
                {generateMutation.isPending || isEditing ? (
                  <Skeleton className="aspect-[4/5] w-full rounded-lg" />
                ) : resultImage ? (
                  <div className="space-y-2">
                    <div className="overflow-hidden rounded-lg border bg-muted/30">
                      <img src={resultImage} alt="Result" className="w-full object-contain aspect-[4/5]" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button size="sm" className="gap-1.5" onClick={() => handleAddToPost()}>
                        <Plus className="h-3.5 w-3.5" />Add to Post
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleSaveToLibrary()} disabled={isSaving} className="gap-1.5">
                        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Save to Library
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleDownload()} className="gap-1.5">
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
                      onClick={() => { setResultImage(item.imageUrl); if (carouselMode) setCarouselMode(false); }}
                      className={`group relative overflow-hidden rounded-lg border transition-all hover:ring-2 hover:ring-primary/50 ${resultImage === item.imageUrl ? "ring-2 ring-primary" : ""}`}
                    >
                      <img src={item.imageUrl} alt={item.prompt} className="aspect-[4/5] w-full object-cover" />
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
        onSelect={(url, fileName) => {
          if (activeTab === "upload") {
            urlToBase64(url).then(d => { setOwnImage(d); setOwnImageFileName(fileName); }).catch(() => toast({ title: "Failed to load image", variant: "destructive" }));
          } else {
            urlToBase64(url).then(d => { setReferenceImage(d); setReferenceFileName(fileName); }).catch(() => toast({ title: "Failed to load image", variant: "destructive" }));
          }
          setShowReferencePicker(false);
        }}
        title={activeTab === "upload" ? "Choose Image" : "Choose Reference Design"}
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
