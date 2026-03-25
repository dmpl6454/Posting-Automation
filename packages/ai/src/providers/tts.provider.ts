/**
 * Text-to-Speech Provider
 * Uses OpenAI's TTS API to generate voice-over audio.
 * Supports multiple voices and speeds.
 */

export type TTSVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

export interface TTSOptions {
  text: string;
  /** Voice selection (default: "nova" — female voice) */
  voice?: TTSVoice;
  /** Speech speed 0.25-4.0 (default: 1.0) */
  speed?: number;
  /** Model: tts-1 (fast) or tts-1-hd (quality) */
  model?: "tts-1" | "tts-1-hd";
}

export interface TTSResult {
  audioBase64: string;
  mimeType: string;
  durationEstimate: number; // rough estimate in seconds
}

/**
 * Generate speech audio from text using OpenAI TTS API.
 * Returns base64-encoded MP3 audio.
 */
export async function generateSpeech(options: TTSOptions): Promise<TTSResult> {
  const {
    text,
    voice = "nova", // nova = female voice, natural sounding
    speed = 1.0,
    model = "tts-1-hd",
  } = options;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for text-to-speech");
  }

  // Trim text to TTS limit (4096 chars)
  const trimmedText = text.slice(0, 4096);

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: trimmedText,
      voice,
      speed,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI TTS failed (HTTP ${res.status}): ${errorText}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());
  const audioBase64 = audioBuffer.toString("base64");

  // Rough duration estimate: ~150 words/minute at speed 1.0
  const wordCount = trimmedText.split(/\s+/).length;
  const durationEstimate = (wordCount / 150) * 60 / speed;

  return {
    audioBase64,
    mimeType: "audio/mpeg",
    durationEstimate,
  };
}

/**
 * Generate voice-over script from article content.
 * Summarizes the content into a concise narration suitable for a short reel.
 */
export function generateVoiceOverScript(
  title: string,
  body: string,
  maxDurationSeconds: number = 30
): string {
  // ~2.5 words per second for natural speech
  const maxWords = Math.floor(maxDurationSeconds * 2.5);

  // Build a concise script
  const sentences = body
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  let script = title + ". ";
  let wordCount = title.split(/\s+/).length;

  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).length;
    if (wordCount + sentenceWords > maxWords) break;
    script += sentence + ". ";
    wordCount += sentenceWords;
  }

  return script.trim();
}
