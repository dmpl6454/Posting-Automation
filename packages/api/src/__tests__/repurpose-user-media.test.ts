/**
 * Regression guard for "attach your own image" on a repurpose (E4, Content
 * Studio Phase 3 Task 5).
 *
 * When the user supplies `userMediaIds` on a STATIC repurpose, the uploaded
 * image becomes the post media and the AI image generation is SKIPPED — but
 * captions are STILL generated. The user-supplied media ids are IDOR-sensitive
 * and MUST be org-scoped BEFORE they are used:
 *   - userMediaIds that don't all resolve org-scoped → FORBIDDEN, and the AI
 *     render (`generateImageSafe` / `generateStyledCreativeImage`) is NOT called.
 *   - owned userMediaIds on a static job → result.carouselMediaIds === those ids
 *     (in order), the AI render is NOT called, and captions still generate.
 *
 * Built via createCallerFactory(repurposeRouter) against a mocked prisma + a
 * mocked @postautomation/ai (the router imports it dynamically) + mocked S3,
 * following the conventions in repurpose-regenerate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── @postautomation/ai mock (dynamically imported by the router). For the
 *    user-media path the AI render MUST NOT be called — we make both render
 *    helpers THROW if invoked so a regression (AI path firing despite an
 *    attached image) fails the test loudly. ── */
const generateStyledCreativeImage = vi.fn(async (..._a: any[]) => {
  throw new Error("generateStyledCreativeImage must NOT be called when userMediaIds is set");
});
const generateImageSafe = vi.fn(async (..._a: any[]) => {
  throw new Error("generateImageSafe must NOT be called when userMediaIds is set");
});
const extractDominantColor = vi.fn(async (..._a: any[]) => "#123456");
const isPublicImageUrl = vi.fn((...a: any[]) => /^https:\/\//.test(String(a[0] ?? "")));
const launchCreativeBrowser = vi.fn(async (..._a: any[]) => ({ close: vi.fn(async () => {}) }));

// Extraction + caption generation: these STILL run on the user-media path.
const extractUrlContent = vi.fn(async (..._a: any[]) => ({
  title: "Big news today",
  description: "A short description",
  siteName: "Example",
  type: "article",
  images: [] as string[],
  url: "https://example.com/article",
  body: "Some article body text that is long enough to be meaningful for captions.",
}));
const repurposeContent = vi.fn(async (..._a: any[]) => ({
  INSTAGRAM: { content: "caption for IG", hashtags: [] as string[] },
}));
const generateContent = vi.fn(async (..._a: any[]) => "Synthesized headline");

vi.mock("@postautomation/ai", () => ({
  generateStyledCreativeImage: (...a: any[]) => generateStyledCreativeImage(...a),
  generateImageSafe: (...a: any[]) => generateImageSafe(...a),
  extractDominantColor: (...a: any[]) => extractDominantColor(...a),
  isPublicImageUrl: (...a: any[]) => isPublicImageUrl(...a),
  launchCreativeBrowser: (...a: any[]) => launchCreativeBrowser(...a),
  extractUrlContent: (...a: any[]) => extractUrlContent(...a),
  repurposeContent: (...a: any[]) => repurposeContent(...a),
  generateContent: (...a: any[]) => generateContent(...a),
  // unused-by-this-path exports — present so the dynamic import doesn't crash
  generateReelVideo: vi.fn(),
  generateSpeech: vi.fn(),
  generateVoiceOverScript: vi.fn(),
  generateImage: vi.fn(),
  enforceNoHashtags: (s: string) => s,
  generateVideo: vi.fn(),
  buildVideoPrompt: vi.fn(),
  overlayLogoOnImage: vi.fn(),
  // aesthetic-reference helpers (provider-agnostic describe path) — null/no-op
  // here since the user-media path doesn't exercise a reference image.
  safeFetchPublicImage: vi.fn(async () => null),
  resolveImageFromPageUrl: vi.fn(async () => null),
  isPublicPageUrl: vi.fn(() => false),
  describeImageStyle: vi.fn(async () => null),
  // D10: present so the router's destructure resolves. These legacy-userMediaIds
  // tests pass no imageAssignments, so the legacy branch runs and the resolver is
  // never invoked — but the export must exist. (Faithful replica of the ladder.)
  resolveImageSlot: async (slot: any, ctx: any) => {
    if (slot.userImageId && ctx.userImages?.[slot.userImageId]) {
      return { url: ctx.userImages[slot.userImageId].url, source: "user" };
    }
    if (ctx.aiToggle) {
      try {
        const url = await ctx.generateAi(slot.aiPrompt);
        if (url) return { url, source: "ai" };
      } catch {
        /* fall through */
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

/* ── Prisma mock. orgProcedure requires a real membership; superadmin actor
 *    skips the plan-expiry revert DB read. media.findMany backs the IDOR guard;
 *    media.create returns a known row (only used on the AI path, which should
 *    NOT run here). ── */
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

function makeCaller(isSuperAdmin = true) {
  const createCaller = createCallerFactory(repurposeRouter);
  return createCaller({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: {
      user: { id: "user-1", email: "boss@example.com", isSuperAdmin },
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
  channelFindFirst.mockResolvedValue(null);
  mediaCreate.mockResolvedValue({ id: "media-ai-1" });
});

describe("repurpose.repurposeFromUrl — attach your own image (E4)", () => {
  it("IDOR: userMediaIds not all org-scoped → FORBIDDEN and the AI render is NOT called", async () => {
    // The org-scoped findMany returns FEWER rows than requested (cross-org / missing id).
    mediaFindMany.mockResolvedValue([]);
    const caller = makeCaller();

    await expect(
      caller.repurposeFromUrl(input({ userMediaIds: ["m-other"] })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The IDOR guard fired against the org-scoped media table...
    expect(mediaFindMany).toHaveBeenCalled();
    const findManyArg = mediaFindMany.mock.calls[0]![0] as any;
    expect(findManyArg.where.organizationId).toBe(ORG_ID);
    // ...and the AI render never ran.
    expect(generateImageSafe).not.toHaveBeenCalled();
    expect(generateStyledCreativeImage).not.toHaveBeenCalled();
  });

  it("owned userMediaIds on a static job: skips AI render, uses the user's media (ordered), still generates captions", async () => {
    mediaFindMany.mockResolvedValue([{ id: "m1", url: "https://s3/m1.png" }]);
    const caller = makeCaller();

    const res = await caller.repurposeFromUrl(input({ userMediaIds: ["m1"] }));

    // The user's media is the post media, in order.
    expect(res.carouselMediaIds).toEqual(["m1"]);
    expect(res.mediaUrls).toEqual(["https://s3/m1.png"]);
    expect(res.mediaMap.INSTAGRAM).toMatchObject({ url: "https://s3/m1.png", mediaId: "m1" });
    expect(res.mediaFailed).toBe(false);

    // The AI render was NOT invoked.
    expect(generateImageSafe).not.toHaveBeenCalled();
    expect(generateStyledCreativeImage).not.toHaveBeenCalled();

    // Captions still generated (the static caption path ran).
    expect(repurposeContent).toHaveBeenCalled();
    expect(res.platformContent).toMatchObject({ INSTAGRAM: expect.anything() });
  });
});
