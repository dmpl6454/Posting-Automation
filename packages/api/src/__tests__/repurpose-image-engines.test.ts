/**
 * Regression guard for the "Image created by X" engine chip (WS1, 2026-06-12).
 *
 * The repurpose mutation surfaces WHICH AI image engine produced each visual:
 *   - static  → singular `imageEngine` + uniform `imageEngines` (one entry)
 *   - carousel/reel → `imageEngines` = the UNIQUE set across all slides, which
 *     can MIX ("gemini" + "openai") when a slide falls back mid-batch; the CTA
 *     slide renders a branded gradient and contributes NO engine
 *   - every-image-failed → `imageEngines: []` (the UI hides the chip and the
 *     card description explains the article-photo/gradient fallback)
 *
 * Built via createCallerFactory(repurposeRouter) against a mocked prisma + a
 * mocked @postautomation/ai + mocked S3, following the conventions in
 * repurpose-user-media.test.ts / repurpose-regenerate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── @postautomation/ai mock (dynamically imported by the router). The engine
 *    chip derives from `generateImageSafe().source`: the FIRST call reports
 *    "gemini", every later call "dalle" (→ "openai"). Slides render in parallel
 *    batches, so assertions are on the aggregated unique SET, never on which
 *    slide got which engine. ── */
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
  // D10: faithful replica of the real resolveImageSlot ladder so the engine
  // aggregation (which now flows through the slot resolver → ctx.generateAi →
  // generateImageSafe) is genuinely exercised by these tests.
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

/* ── Prisma mock — same shape as repurpose-user-media.test.ts. ── */
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
});

describe("repurpose.repurposeFromUrl — imageEngines surfacing", () => {
  it("static: reports the single engine in BOTH the singular and plural fields", async () => {
    const caller = makeCaller();
    const res: any = await caller.repurposeFromUrl(input());

    // One render → one AI background call → first-call mock = gemini.
    expect(generateImageSafe).toHaveBeenCalledTimes(1);
    expect(res.bgSource).toBe("ai");
    expect(res.imageEngine).toBe("gemini");
    expect(res.imageEngines).toEqual(["gemini"]);
  });

  it("carousel: aggregates the UNIQUE engine set across slides; CTA contributes none", async () => {
    const caller = makeCaller();
    // slideCount=4 total → cover + 2 content + CTA. CTA skips the AI background,
    // so exactly 3 generateImageSafe calls: 1× "gemini" + 2× "dalle" → mixed set.
    const res: any = await caller.repurposeFromUrl(input({ format: "carousel", slideCount: 4 }));

    expect(generateImageSafe).toHaveBeenCalledTimes(3);
    expect(res.mediaUrls).toHaveLength(4);
    // Order within the set depends on parallel batch completion — sort it.
    expect([...res.imageEngines].sort()).toEqual(["gemini", "openai"]);
  });

  it("carousel: all slides on one engine → a single-entry set (no false 'mixed')", async () => {
    generateImageSafe.mockImplementation(async () => ({
      imageBase64: "BG_BYTES",
      mimeType: "image/png",
      source: "dalle",
    }));
    const caller = makeCaller();
    const res: any = await caller.repurposeFromUrl(input({ format: "carousel", slideCount: 4 }));

    expect(res.imageEngines).toEqual(["openai"]);
  });

  it("static AI failure: stock fallback, NO engine reported (chip hides)", async () => {
    generateImageSafe.mockRejectedValueOnce(new Error("billing hold"));
    const caller = makeCaller();
    const res: any = await caller.repurposeFromUrl(input());

    // The render itself still succeeds (gradient/article-photo fallback)…
    expect(res.mediaUrls).toHaveLength(1);
    expect(res.mediaFailed).toBe(false);
    // …but no AI engine is claimed.
    expect(res.bgSource).toBe("stock");
    expect(res.imageEngine).toBeNull();
    expect(res.imageEngines).toEqual([]);
  });
});
