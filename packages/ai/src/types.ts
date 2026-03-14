export type AIProvider = "openai" | "anthropic" | "gemini" | "grok" | "deepseek";

export interface ContentGenerationParams {
  provider: AIProvider;
  platform: string;
  userPrompt: string;
  tone?: string;
  charLimit?: number;
}

export interface HashtagParams {
  content: string;
  platform: string;
  provider?: AIProvider;
}

export interface OptimizeParams {
  content: string;
  platform: string;
  goal: string;
  provider?: AIProvider;
}

export type AIImageProvider = "nano-banana" | "nano-banana-pro" | "dall-e";

export interface ImageGenerationParams {
  prompt: string;
  provider?: AIImageProvider;
  aspectRatio?: string;
  imageSize?: string;
  size?: "1024x1024" | "1024x1792" | "1792x1024";
  quality?: "standard" | "hd";
}

export interface ImageEditParams {
  prompt: string;
  imageBase64: string;
  imageMimeType?: string;
  provider?: AIImageProvider;
}
