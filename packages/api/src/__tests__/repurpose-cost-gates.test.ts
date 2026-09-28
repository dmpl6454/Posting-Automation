/**
 * repurpose.repurpose / extractUrl / classifyStyleReference had NO org
 * membership check and NO rate limit — unlike every other AI/network call in
 * this same router (security audit 2026-09-28).
 *
 * `repurposeFromUrl` and `regenerateImage` in this file are already built on
 * `aiRateLimited` (orgProcedure + the shared 20/min aiRateLimiter — see the
 * "Stability guard" comment at the top of repurpose.router.ts). These three
 * sibling mutations were left on bare `protectedProcedure`: any signed-in
 * user, regardless of org membership or plan, could call them as fast as
 * they wanted.
 *
 *   - `repurpose` runs a real LLM text-generation call (repurposeContent) —
 *     an uncapped cost/DoS vector against the shared provider keys.
 *   - `extractUrl` makes the server fetch an ARBITRARY caller-supplied URL
 *     with no rate limit — an abuse/DoS vector even though the URL is
 *     eventually fetched by a library, not raw fetch here.
 *   - `classifyStyleReference` fetches an image and runs a vision-model
 *     classification call (classifyCard) — same uncapped cost.
 *
 * Fixed by switching all three to the SAME `aiRateLimited` procedure their
 * siblings already use, closing both gaps (org membership + shared 20/min
 * limiter) in one change, consistent with the rest of this router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const repurposeContent = vi.fn(async (..._a: any[]) => ({ instagram: "caption" }) as any);
const extractUrlContent = vi.fn(async (..._a: any[]) => ({ title: "t", content: "c" }) as any);
const safeFetchPublicImage = vi.fn(async (..._a: any[]) => null as { base64: string; mimeType: string } | null);
const classifyCard = vi.fn(async (..._a: any[]) => null as any);
const isPublicImageUrl = vi.fn((..._a: any[]) => true);
const isPublicPageUrl = vi.fn((..._a: any[]) => false);
const resolveImageFromPageUrl = vi.fn(async (..._a: any[]) => null as string | null);

vi.mock("@postautomation/ai", () => ({
  repurposeContent: (...a: any[]) => repurposeContent(...a),
  extractUrlContent: (...a: any[]) => extractUrlContent(...a),
  safeFetchPublicImage: (...a: any[]) => safeFetchPublicImage(...a),
  classifyCard: (...a: any[]) => classifyCard(...a),
  isPublicImageUrl: (...a: any[]) => isPublicImageUrl(...a),
  isPublicPageUrl: (...a: any[]) => isPublicPageUrl(...a),
  resolveImageFromPageUrl: (...a: any[]) => resolveImageFromPageUrl(...a),
}));

vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
}));

vi.mock("../middleware/plan-limit.middleware", () => ({
  isBillingDisabled: () => false,
  requirePlan: vi.fn(async () => undefined),
  enforcePlanLimit: vi.fn(async () => undefined),
}));

let rateLimitResult = { success: true, remaining: 19, resetAt: new Date("2099-01-01") };
vi.mock("../middleware/rate-limit", () => ({
  aiRateLimiter: (..._a: any[]) => rateLimitResult,
}));

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async (args: any) =>
        args.where.userId_organizationId.organizationId === "org-mine"
          ? { userId: "user-1", organizationId: "org-mine", role: "OWNER" }
          : null
      ),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "PROFESSIONAL", planExpiresAt: null })) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { repurposeRouter } from "../routers/repurpose.router";
import { prisma as prismaMock } from "@postautomation/db";

const caller = (organizationId: string) =>
  createCallerFactory(repurposeRouter)({
    prisma: prismaMock as any,
    organizationId,
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitResult = { success: true, remaining: 19, resetAt: new Date("2099-01-01") };
});

for (const [name, call] of [
  ["repurpose", (c: ReturnType<typeof caller>) => c.repurpose({ originalContent: "hello", targetPlatforms: ["instagram"] })],
  ["extractUrl", (c: ReturnType<typeof caller>) => c.extractUrl({ url: "https://example.com/a" })],
  ["classifyStyleReference", (c: ReturnType<typeof caller>) => c.classifyStyleReference({ aestheticRefUrl: "https://example.com/a.png" })],
] as const) {
  describe(`repurpose.${name}`, () => {
    it("refuses a caller who is not a member of the org in the request header", async () => {
      await expect(call(caller("org-foreign"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("is rate-limited by the shared aiRateLimiter, like its siblings", async () => {
      rateLimitResult = { success: false, remaining: 0, resetAt: new Date("2099-01-01") };
      await expect(call(caller("org-mine"))).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    });

    it("still works for a real member under the rate limit", async () => {
      await expect(call(caller("org-mine"))).resolves.toBeDefined();
    });
  });
}
