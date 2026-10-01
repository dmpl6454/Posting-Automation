/**
 * post.generateCarousel had no rate limit (pre-PR review, 2026-10-01). Its quota
 * check reads the AI-image count once, but the Media rows it counts are written
 * only after every slide is generated (minutes, with retries), so parallel calls
 * from one org all see the same `current` and all pass — 10 images each. A
 * per-user limiter bounds that without touching the shared AI budget other
 * features draw from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let limiterResult = { success: true, remaining: 4, resetAt: new Date("2099-01-01") };
const carouselLimiter = vi.fn((..._a: any[]) => limiterResult);

vi.mock("../middleware/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/rate-limit")>();
  return { ...actual, carouselRateLimiter: (...a: any[]) => carouselLimiter(...a) };
});

const checkUsageLimit = vi.fn(async (..._a: any[]) => ({ allowed: true, current: 0, limit: -1, planName: "Free" }));
vi.mock("../middleware/plan-limit.middleware", () => ({
  checkUsageLimit: (...a: any[]) => checkUsageLimit(...a),
  enforcePlanLimit: vi.fn(async () => undefined),
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

const caller = () =>
  createCallerFactory(postRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

beforeEach(() => {
  vi.clearAllMocks();
  limiterResult = { success: true, remaining: 4, resetAt: new Date("2099-01-01") };
});

describe("post.generateCarousel rate limit", () => {
  it("refuses with TOO_MANY_REQUESTS once the per-user carousel budget is spent, before any quota or AI work", async () => {
    limiterResult = { success: false, remaining: 0, resetAt: new Date("2099-01-01") };
    await expect(caller().generateCarousel({ content: "A".repeat(20), slideCount: 3 })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(carouselLimiter).toHaveBeenCalledWith("user-1");
    expect(checkUsageLimit).not.toHaveBeenCalled();
  });

  it("runs the quota check when the limiter allows the call", async () => {
    checkUsageLimit.mockRejectedValueOnce(new Error("reached the quota check"));
    await expect(caller().generateCarousel({ content: "A".repeat(20), slideCount: 3 })).rejects.toThrow(
      "reached the quota check",
    );
    expect(carouselLimiter).toHaveBeenCalledWith("user-1");
  });
});
