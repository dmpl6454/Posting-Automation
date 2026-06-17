/**
 * R4 regression guard — a FAILED static-image render must THROW a hard, friendly
 * error, NOT silently return `mediaFailed:true` with an empty `mediaUrls`.
 *
 * The bug (livelihood-critical): the static-image path's render/upload catch
 * blocks swallowed the error (log + progress("...","error") + continue). The
 * mutation then returned 200 with mediaFailed:true (a SOFT signal), so the UI
 * still let the user click "Create Drafts" → a media-less draft → Instagram
 * publish failed with "Instagram requires an image; none attached."
 *
 * This file mirrors the proven harness in repurpose-image-engines.test.ts:
 * createCallerFactory(repurposeRouter) against a mocked prisma + mocked
 * @postautomation/ai + mocked S3. The render itself SUCCEEDS (mocked
 * generateStyledCreativeImage), then the S3-upload Media-row creation
 * (ctx.prisma.media.create) THROWS — landing in the static catch. We provide an
 * article image so the T3 no-photo guard does NOT pre-empt the render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── @postautomation/ai mock (dynamically imported by the router). ── */
const generateImageSafe = vi.fn(async (..._a: any[]) => ({
  imageBase64: "BG_BYTES",
  mimeType: "image/png",
  source: "gemini",
}));
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
  // An article photo so the T3 no-photo guard does NOT fire — the render is
  // reached, and it's the render/upload that fails (below), not the pre-guard.
  images: ["https://example.com/photo.jpg"],
  url: "https://example.com/article",
  body: "First sentence with plenty of detail for slides. Second sentence with more detail. Third sentence rounding out the article body for fallbacks.",
}));
const repurposeContent = vi.fn(async (..._a: any[]) => ({
  INSTAGRAM: { content: "caption for IG", hashtags: [] as string[] },
}));
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
  // Faithful replica of the real resolveImageSlot ladder (user → AI → article →
  // branded). With an article image present and no user image, the static path
  // resolves to source:"ai" (aiToggle default true) — a real bg url to render.
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

/* ── Queue mock. ── */
vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
}));

/* ── Prisma mock. ── */
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
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  mediaFindFirst.mockResolvedValue(null);
  mediaFindMany.mockResolvedValue([]);
  channelFindFirst.mockResolvedValue(null);
  // Default: media row creation succeeds (used implicitly only if a test overrides it).
  mediaCreate.mockResolvedValue({ id: "media-ai-1" });
});

describe("repurpose.repurposeFromUrl — static render failure THROWS (R4)", () => {
  it("single-bg static: an upload/render failure THROWS, NOT a silent mediaFailed:true", async () => {
    // The render succeeds (mocked generateStyledCreativeImage), but persisting the
    // Media row throws — uploadAndCreateMedia has no internal try/catch, so the
    // error propagates into the single-bg static catch (repurpose.router ~2253).
    mediaCreate.mockRejectedValue(new Error("DB write failed during upload"));
    const caller = makeCaller();

    await expect(caller.repurposeFromUrl(input())).rejects.toThrow();
  });

  it("postcard_grid static: an upload/render failure THROWS, NOT a silent mediaFailed:true", async () => {
    mediaCreate.mockRejectedValue(new Error("DB write failed during upload"));
    const caller = makeCaller();

    await expect(
      caller.repurposeFromUrl(
        input({ creativeStyle: "postcard_grid", gridPreset: "two_up" }),
      ),
    ).rejects.toThrow();
  });
});
