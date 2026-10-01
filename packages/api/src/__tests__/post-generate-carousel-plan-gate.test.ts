/**
 * post.generateCarousel plan quota (security audit 2026-09-28, idor-posts cluster;
 * review follow-up 2026-10-01).
 *
 * generateCarousel creates up to 10 AI images per call (slideCount 3-10). Two
 * defects made the first fix (enforcePlanLimit) a no-op:
 *   1. checkUsageLimit counts aiImagesPerMonth as Media rows whose fileName
 *      starts with "ai-", but carousel slides were saved as "carousel-slide-…",
 *      so the carousel's own output was never counted;
 *   2. enforcePlanLimit checks `current < limit` — one image of headroom let a
 *      10-slide batch through.
 * Now: a batch check (current + slideCount > limit ⇒ FORBIDDEN) and AI-generated
 * slides are named "ai-carousel-slide-…". Puppeteer/HTML template slides are not
 * AI images and stay un-prefixed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const generateContent = vi.fn(async (..._a: any[]) => "[]");
const generateImage = vi.fn(async (..._a: any[]): Promise<{ imageBase64: string; mimeType: string }> => ({
  imageBase64: Buffer.from("img").toString("base64"),
  mimeType: "image/png",
}));
const generateCarouselImages = vi.fn(async (..._a: any[]): Promise<{ slides: Array<{ imageBase64: string; mimeType: string }> }> => ({
  slides: [],
}));
const withTextProviderFallback = vi.fn(async (..._a: any[]) => '[{"title":"One","body":"First point"}]');

vi.mock("@postautomation/ai", () => ({
  generateContent: (...a: any[]) => generateContent(...a),
  generateImage: (...a: any[]) => generateImage(...a),
  generateCarouselImages: (...a: any[]) => generateCarouselImages(...a),
  withTextProviderFallback: (...a: any[]) => withTextProviderFallback(...a),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = vi.fn(async (..._a: any[]) => ({}));
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

const checkUsageLimit = vi.fn(async (..._a: any[]) => ({ allowed: true, current: 0, limit: -1, planName: "Free" }));
const enforcePlanLimit = vi.fn(async (..._a: any[]) => undefined);
vi.mock("../middleware/plan-limit.middleware", () => ({
  checkUsageLimit: (...a: any[]) => checkUsageLimit(...a),
  enforcePlanLimit: (...a: any[]) => enforcePlanLimit(...a),
  isBillingDisabled: () => false,
}));

const mediaCreate = vi.fn(async (args: any) => ({ id: `media-${mediaCreate.mock.calls.length}`, ...args.data }));
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: "user-1", organizationId: "org-1", role: "OWNER" })),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })) },
    media: { create: (args: any) => mediaCreate(args) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { postRouter } from "../routers/post.router";
import { prisma as prismaMock } from "@postautomation/db";

const caller = (isSuperAdmin = false) =>
  createCallerFactory(postRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin }, expires: "2099-01-01" } as any,
  });

/** Runs the mutation to completion, fast-forwarding its inter-slide delays. */
async function generate(input: { content: string; slideCount: number }) {
  const settled = caller()
    .generateCarousel(input)
    .then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e })
    );
  await vi.runAllTimersAsync();
  const r = await settled;
  if (!r.ok) throw r.e;
  return r.v;
}

const createdFileNames = () => mediaCreate.mock.calls.map(([a]: any[]) => a.data.fileName as string);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("post.generateCarousel plan gate", () => {
  it("refuses when the WHOLE batch would exceed the quota — even with headroom for one image", async () => {
    checkUsageLimit.mockResolvedValueOnce({ allowed: true, current: 5, limit: 10, planName: "Free" });

    await expect(caller().generateCarousel({ content: "A".repeat(20), slideCount: 6 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("this carousel would add 6"),
    });

    expect(checkUsageLimit).toHaveBeenCalledWith("org-1", "aiImagesPerMonth", false);
    expect(withTextProviderFallback).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
    expect(generateCarouselImages).not.toHaveBeenCalled();
    expect(mediaCreate).not.toHaveBeenCalled();
  });

  it("allows a batch that exactly fits the remaining quota", async () => {
    checkUsageLimit.mockResolvedValueOnce({ allowed: true, current: 7, limit: 10, planName: "Free" });
    const res = await generate({ content: "A".repeat(20), slideCount: 3 });
    expect(res.slideCount).toBe(3);
  });

  it("unlimited (-1) is never refused", async () => {
    checkUsageLimit.mockResolvedValueOnce({ allowed: true, current: 0, limit: -1, planName: "Enterprise" });
    const res = await generate({ content: "A".repeat(20), slideCount: 3 });
    expect(res.slideCount).toBe(3);
  });

  it("passes isSuperAdmin through so a super-admin's bypass is real, not hardcoded false", async () => {
    checkUsageLimit.mockRejectedValueOnce(new Error("stop here"));
    await expect(caller(true).generateCarousel({ content: "A".repeat(20), slideCount: 6 })).rejects.toThrow("stop here");
    expect(checkUsageLimit).toHaveBeenCalledWith("org-1", "aiImagesPerMonth", true);
  });
});

describe("post.generateCarousel slide Media rows are visible to the AI-image counter", () => {
  // The counter's predicate, read from the middleware itself so the two ends
  // cannot drift apart silently.
  const middlewareSrc = readFileSync(join(__dirname, "../middleware/plan-limit.middleware.ts"), "utf8");
  const counterCase = middlewareSrc.slice(
    middlewareSrc.indexOf('case "aiImagesPerMonth"'),
    middlewareSrc.indexOf('case "aiVideosPerMonth"')
  );
  const prefix = counterCase.match(/fileName: \{ startsWith: "([^"]+)" \}/)?.[1];

  it("the counter still keys on a fileName prefix", () => {
    expect(prefix).toBe("ai-");
  });

  it("AI-generated slides are named so the counter counts them", async () => {
    const res = await generate({ content: "A".repeat(20), slideCount: 3 });

    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(res.slideCount).toBe(3);
    const names = createdFileNames();
    expect(names).toHaveLength(3);
    for (const name of names) expect(name.startsWith(prefix!)).toBe(true);
  });

  it("Puppeteer template slides are NOT AI images and stay un-prefixed", async () => {
    generateImage.mockRejectedValue(new Error("gemini down"));
    generateCarouselImages.mockResolvedValueOnce({
      slides: [1, 2, 3].map(() => ({ imageBase64: Buffer.from("tpl").toString("base64"), mimeType: "image/png" })),
    });

    const res = await generate({ content: "A".repeat(20), slideCount: 3 });

    expect(generateCarouselImages).toHaveBeenCalledTimes(1);
    expect(res.slideCount).toBe(3);
    const names = createdFileNames();
    expect(names).toHaveLength(3);
    for (const name of names) expect(name.startsWith(prefix!)).toBe(false);
  });

  it("never generates more AI images than the slideCount the quota was checked against", async () => {
    // The model is asked for slideCount-2 points but may return more.
    withTextProviderFallback.mockResolvedValueOnce(
      JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, body: `Body ${i}` })))
    );
    const res = await generate({ content: "A".repeat(20), slideCount: 4 });
    expect(generateImage).toHaveBeenCalledTimes(4);
    expect(res.slideCount).toBe(4);
  });
});
