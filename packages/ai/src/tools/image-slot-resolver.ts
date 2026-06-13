/**
 * Per-slot real-first image resolution ladder (Component 4 / D10).
 * Every image-consuming block (background, circularInset, splitPhotos/photoGrid
 * tile, carousel slide photo) is an ImageSlot resolved INDEPENDENTLY:
 *   1. user-assigned image (upload OR Media Library pick) for THIS slot
 *   2. AI toggle ON → generate (Gemini → OpenAI, via injected generateAi)
 *   3. article og:image / next article image[]
 *   4. clean branded gradient (never blank/broken)
 * Pure (all I/O injected) + exported for unit testing.
 */

export interface ImageSlot {
  /** Caller fills ONE of these (or neither → ladder decides). */
  userImageId?: string;       // org-owned Media id
  articleImageUrl?: string;   // article og:image or images[i]
  /** Optional per-slot AI prompt; resolver passes it to generateAi. */
  aiPrompt?: string;
}

export type ImageSource = "user" | "ai" | "article" | "branded";

export interface ResolveImageSlotCtx {
  aiToggle: boolean;
  userImages: Record<string, { url: string }>;
  articleImages: string[];
  brandGradient: string;
  /** Returns a data: URL (or https) for an AI image, or throws on failure. */
  generateAi: (prompt?: string) => Promise<string>;
}

export async function resolveImageSlot(
  slot: ImageSlot,
  ctx: ResolveImageSlotCtx,
): Promise<{ url: string; source: ImageSource }> {
  // 1) user-assigned image for this slot
  if (slot.userImageId && ctx.userImages[slot.userImageId]) {
    return { url: ctx.userImages[slot.userImageId]!.url, source: "user" };
  }

  // 2) AI generation when the toggle is on
  if (ctx.aiToggle) {
    try {
      const url = await ctx.generateAi(slot.aiPrompt);
      if (url) return { url, source: "ai" };
    } catch (e) {
      // Fall through to real-photo / branded — never throw on a slot.
      console.warn(`[resolveImageSlot] AI failed, falling through:`, (e as Error).message);
    }
  }

  // 3) article photo — the slot's explicit url, else the first article image
  const article = slot.articleImageUrl || ctx.articleImages[0];
  if (article) return { url: article, source: "article" };

  // 4) branded gradient — always renders, never blank
  return { url: ctx.brandGradient, source: "branded" };
}
