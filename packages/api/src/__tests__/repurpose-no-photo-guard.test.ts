/**
 * Regression guard for the T3 "no hero photo" block (2026-06-15).
 *
 * A STATIC post and a CAROUSEL COVER both require a usable background photo. When
 * AI image generation is OFF (or unavailable) AND there is no user image AND no
 * article photo, the prior behaviour rendered a blank branded gradient with a
 * floating headline. The locked decision is to BLOCK instead, surfacing an
 * actionable error the UI shows as a toast:
 *   "Add a hero photo — paste or upload one — or turn on AI image generation. …"
 *
 * Guards live in repurpose.router.ts:
 *   - STATIC:        inside `if (mediaUrls.length === 0)`, throws when bgSlot.source === "branded".
 *   - CAROUSEL COVER: `if (format === "carousel" && !effectiveAiImages)` → throws when
 *                     no user image for slide:0 AND no article cover photo.
 *
 * These cases are NOT covered by repurpose-image-engines.test.ts (which exercises
 * the engine-chip path with AI on / real photos present). The mock harness below
 * is replicated from that file so the caller resolves a real membership + org and
 * the slot resolver faithfully mirrors the production resolveImageSlot ladder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── @postautomation/ai mock (dynamically imported by the router). ── */
let imageCall = 0;
const generateImageSafe = vi.fn(async (..._a: any[]) => {
  imageCall += 1;
  return {
    imageBase64: "BG_BYTES",
    mimeType: "image/png",
    source: imageCall === 1 ? "gemini" : "dalle",
  };
});
const generateStyledCreativeImage = vi.fn(async (..._a: any[]) => ({
  imageBase64: "RENDERED_BYTES",
  mimeType: "image/png",
}));
const extractDominantColor = vi.fn(async (..._a: any[]) => "#123456");
const isPublicImageUrl = vi.fn((...a: any[]) => /^https:\/\//.test(String(a[0] ?? "")));
const launchCreativeBrowser = vi.fn(async (..._a: any[]) => ({ close: vi.fn(async () => {}) }));

const extractUrlContent = vi.fn(async (..._a: any[]) => ({
  title: "Big news today",
  description: "A short description",
  siteName: "Example",
  type: "article",
  images: [] as string[],
  url: "https://example.com/article",
  body: "First sentence with plenty of detail for slides. Second sentence with more detail. Third sentence rounding out the article body for fallbacks.",
}));
const repurposeContent = vi.fn(async (..._a: any[]) => ({
  INSTAGRAM: { content: "caption for IG", hashtags: [] as string[] },
}));
// Slide-outline calls ask for a JSON array; every other text call (headline
// synthesis, hook line) gets a plain string.
const generateContent = vi.fn(async (...args: any[]) => {
  const opts = args[0];
  if (String(opts?.userPrompt ?? "").includes("JSON array")) {
    return JSON.stringify([
      { title: "Point one", body: "First key takeaway from the article." },
      { title: "Point two", body: "Second key takeaway from the article." },
    ]);
  }
  return "Synthesized headline";
});

vi.mock("@postautomation/ai", () => ({
  generateStyledCreativeImage: (...a: any[]) => generateStyledCreativeImage(...a),
  generateImageSafe: (...a: any[]) => generateImageSafe(...a),
  extractDominantColor: (...a: any[]) => extractDominantColor(...a),
  isPublicImageUrl: (...a: any[]) => isPublicImageUrl(...a),
  launchCreativeBrowser: (...a: any[]) => launchCreativeBrowser(...a),
  extractUrlContent: (...a: any[]) => extractUrlContent(...a),
  repurposeContent: (...a: any[]) => repurposeContent(...a),
  generateContent: (...a: any[]) => generateContent(...a),
  // unused-by-these-paths exports — present so the dynamic import doesn't crash
  generateReelVideo: vi.fn(),
  generateSpeech: vi.fn(),
  generateVoiceOverScript: vi.fn(),
  generateImage: vi.fn(),
  enforceNoHashtags: (s: string) => s,
  generateVideo: vi.fn(),
  buildVideoPrompt: vi.fn(),
  overlayLogoOnImage: vi.fn(),
  safeFetchPublicImage: vi.fn(async () => null),
  resolveImageFromPageUrl: vi.fn(async () => null),
  isPublicPageUrl: vi.fn(() => false),
  describeImageStyle: vi.fn(async () => null),
  // Faithful replica of the real resolveImageSlot ladder so the no-photo guard is
  // exercised through the SAME slot resolution the router relies on: with the AI
  // toggle off and no user/article image, the slot resolves to "branded".
  resolveImageSlot: async (slot: any, ctx: any) => {
    if (slot.userImageId && ctx.userImages?.[slot.userImageId]) {
      return { url: ctx.userImages[slot.userImageId].url, source: "user" };
    }
    if (ctx.aiToggle) {
      try {
        const url = await ctx.generateAi(slot.aiPrompt);
        if (url) return { url, source: "ai" };
      } catch {
        /* fall through to article/branded */
      }
    }
    const article = slot.articleImageUrl || ctx.articleImages?.[0];
    if (article) return { url: article, source: "article" };
    return { url: ctx.brandGradient, source: "branded" };
  },
  classifyCard: vi.fn(async () => null),
  extractCardLayout: vi.fn(async () => null),
  cardLayoutToSpec: vi.fn(() => ({})),
  generateCardImage: vi.fn(async () => ({ imageBase64: "base64img", mimeType: "image/png", width: 1080, height: 1350 })),
}));

/* ── S3 mock — never hit the network. ── */
const s3Send = vi.fn(async (..._a: any[]) => ({}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: (...a: any[]) => s3Send(...a) })),
  PutObjectCommand: vi.fn((args: any) => args),
}));

/* ── Plan-limit middleware mock. ── */
vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

/* ── Queue mock (imported at module top). ── */
vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
}));

/* ── Prisma mock — same shape as repurpose-image-engines.test.ts. ── */
const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const mediaFindMany = vi.fn();
const mediaCreate = vi.fn();
const mediaFindFirst = vi.fn();
const channelFindFirst = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    media: {
      findMany: (...a: any[]) => mediaFindMany(...a),
      create: (...a: any[]) => mediaCreate(...a),
      findFirst: (...a: any[]) => mediaFindFirst(...a),
    },
    channel: { findFirst: (...a: any[]) => channelFindFirst(...a) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { repurposeRouter } from "../routers/repurpose.router";
import { prisma as prismaMock } from "@postautomation/db";

const ORG_ID = "org-1";

function makeCaller() {
  const createCaller = createCallerFactory(repurposeRouter);
  return createCaller({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: {
      user: { id: "user-1", email: "boss@example.com", isSuperAdmin: true },
      expires: "2099-01-01",
    } as any,
  });
}

function input(extra: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/article",
    format: "static" as const,
    targetPlatforms: ["INSTAGRAM"],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  imageCall = 0;
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  mediaFindFirst.mockResolvedValue(null);
  mediaFindMany.mockResolvedValue([]);
  channelFindFirst.mockResolvedValue(null);
  mediaCreate.mockResolvedValue({ id: "media-ai-1" });
  // Reset to the photoless default for each test; cases that need a photo set it explicitly.
  extractUrlContent.mockResolvedValue({
    title: "Big news today",
    description: "A short description",
    siteName: "Example",
    type: "article",
    images: [] as string[],
    url: "https://example.com/article",
    body: "First sentence with plenty of detail for slides. Second sentence with more detail. Third sentence rounding out the article body for fallbacks.",
  });
});

describe("repurpose.repurposeFromUrl — T3 no-photo guard", () => {
  it("STATIC + AI off + no photo → REJECTS with an actionable error", async () => {
    // photoless extract (default), AI off, no user media → bgSlot.source === "branded".
    const caller = makeCaller();
    await expect(caller.repurposeFromUrl(input({ aiImages: false }))).rejects.toThrow(/Add a hero photo/);
  });

  it("STATIC + AI off + article photo present → does NOT reject (falls back to the photo)", async () => {
    extractUrlContent.mockResolvedValue({
      title: "Big news today",
      description: "A short description",
      siteName: "Example",
      type: "article",
      images: ["https://example.com/p.jpg"],
      url: "https://example.com/article",
      body: "First sentence with plenty of detail for slides. Second sentence with more detail. Third sentence rounding out the article body for fallbacks.",
    });
    const caller = makeCaller();
    const res: any = await caller.repurposeFromUrl(input({ aiImages: false }));

    expect(res.mediaUrls).toHaveLength(1);
    expect(res.bgSource).toBe("real");
    // AI was off, so no AI background call was made.
    expect(generateImageSafe).not.toHaveBeenCalled();
  });

  it("STATIC + AI on + AI succeeds → does NOT reject", async () => {
    // aiImages defaults to true; the default generateImageSafe mock resolves.
    const caller = makeCaller();
    const res: any = await caller.repurposeFromUrl(input());

    expect(res.mediaUrls).toHaveLength(1);
    expect(res.bgSource).toBe("ai");
    expect(generateImageSafe).toHaveBeenCalled();
  });

  it("CAROUSEL + AI off + no cover photo → REJECTS with an actionable error", async () => {
    // photoless extract (default), AI off, no slide:0 user image → cover is branded.
    const caller = makeCaller();
    await expect(
      caller.repurposeFromUrl(input({ format: "carousel", aiImages: false })),
    ).rejects.toThrow(/Add a hero photo/);
  });

  it("CAROUSEL + AI off + cover article photo present → does NOT reject", async () => {
    extractUrlContent.mockResolvedValue({
      title: "Big news today",
      description: "A short description",
      siteName: "Example",
      type: "article",
      images: ["https://example.com/p.jpg"],
      url: "https://example.com/article",
      body: "First sentence with plenty of detail for slides. Second sentence with more detail. Third sentence rounding out the article body for fallbacks.",
    });
    const caller = makeCaller();
    const res: any = await caller.repurposeFromUrl(input({ format: "carousel", aiImages: false }));

    expect(Array.isArray(res.mediaUrls)).toBe(true);
    expect(res.mediaUrls.length).toBeGreaterThan(0);
    // This case renders a full carousel and runs ~4.9s — the 5s default made
    // it flake under parallel suite load. Not a slow-code signal.
  }, 15_000);
});
