/**
 * post.generateCarousel had no plan-quota check at all (security audit
 * 2026-09-28, idor-posts cluster).
 *
 * image.router.ts's `generate` — which creates exactly ONE AI image per call
 * — already calls enforcePlanLimit(organizationId, "aiImagesPerMonth", ...)
 * before generating. generateCarousel creates up to 10 AI images in a single
 * call (slideCount 3-10) and had NO such check, so any org — regardless of
 * plan or usage — could generate unlimited carousel images. Fixed by adding
 * the same enforcePlanLimit call other AI-image paths already have, BEFORE
 * any AI/S3 work begins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const generateContent = vi.fn();
const generateImage = vi.fn();
const generateCarouselImages = vi.fn();
const withTextProviderFallback = vi.fn();

vi.mock("@postautomation/ai", () => ({
  generateContent: (...a: any[]) => generateContent(...a),
  generateImage: (...a: any[]) => generateImage(...a),
  generateCarouselImages: (...a: any[]) => generateCarouselImages(...a),
  withTextProviderFallback: (...a: any[]) => withTextProviderFallback(...a),
}));

const enforcePlanLimit = vi.fn(async (..._a: any[]) => undefined);
vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: (...a: any[]) => enforcePlanLimit(...a),
  isBillingDisabled: () => false,
}));

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: "user-1", organizationId: "org-1", role: "OWNER" })),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })) },
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

beforeEach(() => vi.clearAllMocks());

describe("post.generateCarousel plan gate", () => {
  it("checks the aiImagesPerMonth quota before doing any AI/S3 work", async () => {
    enforcePlanLimit.mockRejectedValueOnce(
      new TRPCError({ code: "FORBIDDEN", message: "Plan limit reached: Free plan allows 5 AI images this month" })
    );

    await expect(
      caller().generateCarousel({ content: "A".repeat(20), slideCount: 6 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(enforcePlanLimit).toHaveBeenCalledWith("org-1", "aiImagesPerMonth", false);
    // Nothing AI/S3-related should ever run once the quota check throws.
    expect(withTextProviderFallback).not.toHaveBeenCalled();
    expect(generateCarouselImages).not.toHaveBeenCalled();
  });

  it("passes isSuperAdmin through so a super-admin's bypass is real, not hardcoded false", async () => {
    // Same "throw from the gate" shape as the first test — only the flag
    // differs — so this never touches the retry/backoff AI pipeline at all.
    enforcePlanLimit.mockRejectedValueOnce(new TRPCError({ code: "FORBIDDEN", message: "stop here" }));
    await expect(caller(true).generateCarousel({ content: "A".repeat(20), slideCount: 6 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(enforcePlanLimit).toHaveBeenCalledWith("org-1", "aiImagesPerMonth", true);
  });
});
