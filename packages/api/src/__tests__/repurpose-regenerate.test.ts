/**
 * Regression guard for the per-image "Regenerate" mutation (E3b, Content Studio
 * Phase 3 Task 4).
 *
 * `regenerateImage` re-rolls JUST the static / carousel-cover image without
 * re-running the whole repurpose flow. Because it is a NEW write endpoint that
 * renders an AI image, it MUST:
 *   - be plan-gated via enforcePlanLimit(aiImagesPerMonth) BEFORE any render,
 *     so it can't become a free unlimited image faucet; and
 *   - SSRF-guard the user-supplied logoUrl + aestheticRefUrl via isPublicImageUrl,
 *     silently dropping any private/internal host.
 *
 * Built via createCallerFactory(repurposeRouter) against a mocked prisma + a
 * mocked @postautomation/ai (the router imports it dynamically) + mocked S3,
 * following the conventions in chat-action-idempotency / image-router tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

/* ── @postautomation/ai mock (dynamically imported by the router). The render
 *    helper resolves `generateStyledCreativeImage` (template→PNG) and optionally
 *    `generateImageSafe` (AI background). We spy on both to assert the SSRF +
 *    plan-gate wiring without touching real providers. ── */
const generateStyledCreativeImage = vi.fn(async (..._a: any[]) => ({
  imageBase64: "RENDERED_BYTES",
  mimeType: "image/png",
}));
const generateImageSafe = vi.fn(async (..._a: any[]) => ({
  imageBase64: "BG_BYTES",
  mimeType: "image/png",
}));
const extractDominantColor = vi.fn(async (..._a: any[]) => "#123456");
// Real-enough SSRF guard: block the link-local metadata host + private hosts,
// allow ordinary https. Mirrors isPublicImageUrl's intent for the test.
const isPublicImageUrl = vi.fn((...a: any[]) => {
  const url = String(a[0] ?? "");
  return /^https:\/\//.test(url) && !/169\.254\.|127\.0\.0\.1|localhost|10\.|192\.168\./.test(url);
});
const launchCreativeBrowser = vi.fn(async (..._a: any[]) => ({ close: vi.fn(async () => {}) }));

vi.mock("@postautomation/ai", () => ({
  generateStyledCreativeImage: (...a: any[]) => generateStyledCreativeImage(...a),
  generateImageSafe: (...a: any[]) => generateImageSafe(...a),
  extractDominantColor: (...a: any[]) => extractDominantColor(...a),
  isPublicImageUrl: (...a: any[]) => isPublicImageUrl(...a),
  launchCreativeBrowser: (...a: any[]) => launchCreativeBrowser(...a),
  // unused-by-regenerate exports — present so other code paths don't crash on import
  extractUrlContent: vi.fn(),
  repurposeContent: vi.fn(),
  generateContent: vi.fn(),
  generateReelVideo: vi.fn(),
  generateSpeech: vi.fn(),
  generateVoiceOverScript: vi.fn(),
  generateImage: vi.fn(),
  enforceNoHashtags: (s: string) => s,
  generateVideo: vi.fn(),
  buildVideoPrompt: vi.fn(),
  overlayLogoOnImage: vi.fn(),
}));

/* ── S3 mock — never hit the network. ── */
const s3Send = vi.fn(async (..._a: any[]) => ({}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: (...a: any[]) => s3Send(...a) })),
  PutObjectCommand: vi.fn((args: any) => args),
}));

/* ── Plan-limit middleware mock — controls whether the gate throws. ── */
const enforcePlanLimit = vi.fn(async (..._a: any[]) => undefined);
vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: (...a: any[]) => enforcePlanLimit(...a),
  requirePlan: vi.fn(async () => undefined),
}));

/* ── Queue mock (imported at module top). ── */
vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
}));

/* ── Prisma mock. orgProcedure requires a real membership; superadmin actor
 *    skips the plan-expiry revert DB read. media.create returns a known row. ── */
const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const mediaCreate = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    // orgProcedure reads this in its plan-expiry guard for non-superadmin actors.
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    media: { create: (...a: any[]) => mediaCreate(...a) },
    channel: { findFirst: vi.fn() },
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
    headline: "Big news today",
    creativeStyle: "premium_editorial" as const,
    theme: "light" as const,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset queued `*Once` implementations so a one-time rejection from one test
  // can't leak into the next (clearAllMocks clears call history, not the queue).
  enforcePlanLimit.mockReset();
  // Default render/upload mocks
  generateStyledCreativeImage.mockResolvedValue({ imageBase64: "RENDERED_BYTES", mimeType: "image/png" });
  generateImageSafe.mockResolvedValue({ imageBase64: "BG_BYTES", mimeType: "image/png" });
  enforcePlanLimit.mockResolvedValue(undefined);
  // Membership gate passes for a real member.
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  // FREE org, not expired → plan-expiry guard is a no-op (the gate under test is
  // enforcePlanLimit inside the mutation body, not the expiry revert).
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  mediaCreate.mockResolvedValue({ id: "media-regen-1" });
});

describe("repurpose.regenerateImage", () => {
  it("is plan-gated: when over quota it rejects FORBIDDEN and does NOT render or upload", async () => {
    // A real TRPCError so tRPC propagates the FORBIDDEN code (a plain Error
    // would be re-wrapped to INTERNAL_SERVER_ERROR by the caller).
    enforcePlanLimit.mockRejectedValueOnce(
      new TRPCError({ code: "FORBIDDEN", message: "quota exceeded" }),
    );
    const caller = makeCaller(false);

    await expect(caller.regenerateImage(input())).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The gate must fire BEFORE any render/upload work.
    expect(enforcePlanLimit).toHaveBeenCalledWith(ORG_ID, "aiImagesPerMonth", false);
    expect(generateStyledCreativeImage).not.toHaveBeenCalled();
    expect(generateImageSafe).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
    expect(mediaCreate).not.toHaveBeenCalled();
  });

  it("SSRF: a private logoUrl is dropped — render gets NO logo reference and the url is never fetched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any);
    const caller = makeCaller();

    const res = await caller.regenerateImage(
      input({ logoUrl: "http://169.254.169.254/x", aestheticRefUrl: "http://10.0.0.1/y" }),
    );

    // Mutation still succeeds (degrades to no-logo / no-reference path).
    expect(res).toMatchObject({ url: expect.any(String), mediaId: "media-regen-1" });
    // The disallowed urls were rejected by the SSRF guard...
    expect(isPublicImageUrl).toHaveBeenCalledWith("http://169.254.169.254/x");
    expect(isPublicImageUrl).toHaveBeenCalledWith("http://10.0.0.1/y");
    // ...so the render receives a null/undefined logoUrl (logo dropped) and the
    // private hosts are never fetched.
    const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
    expect(renderArgs.logoUrl ?? null).toBeNull();
    if (fetchSpy.mock.calls.length) {
      for (const [u] of fetchSpy.mock.calls) {
        expect(String(u)).not.toContain("169.254.169.254");
        expect(String(u)).not.toContain("10.0.0.1");
      }
    }
    fetchSpy.mockRestore();
  });

  it("happy path: allowed input returns { url, mediaId }", async () => {
    const caller = makeCaller();
    const res = await caller.regenerateImage(input());
    expect(res).toMatchObject({ url: expect.any(String), mediaId: "media-regen-1" });
    // The gate ran, the template render ran, the media row was created.
    expect(enforcePlanLimit).toHaveBeenCalledWith(ORG_ID, "aiImagesPerMonth", true);
    expect(generateStyledCreativeImage).toHaveBeenCalledTimes(1);
    expect(mediaCreate).toHaveBeenCalledTimes(1);
  });

  it("honors styleNeedsAiBackground: hook_bars skips the AI background render", async () => {
    const caller = makeCaller();
    await caller.regenerateImage(input({ creativeStyle: "hook_bars" }));
    // hook_bars is text-first → no AI background generated.
    expect(generateImageSafe).not.toHaveBeenCalled();
    // but the template still renders.
    expect(generateStyledCreativeImage).toHaveBeenCalledTimes(1);
  });
});
