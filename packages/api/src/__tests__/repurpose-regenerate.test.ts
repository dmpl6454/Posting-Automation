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
// Round 9: hoisted so the accent-precedence tests can drive the style-reference
// path (reference fetch + vision classify). Default: no image / no hint, so the
// existing tests behave exactly as before (color falls through to picker/logo).
const safeFetchPublicImage = vi.fn(async (..._a: any[]) => null as { base64: string; mimeType: string } | null);
const classifyCard = vi.fn(async (..._a: any[]) => null as { accentColor: string } | null);

vi.mock("@postautomation/ai", () => ({
  generateStyledCreativeImage: (...a: any[]) => generateStyledCreativeImage(...a),
  generateImageSafe: (...a: any[]) => generateImageSafe(...a),
  extractDominantColor: (...a: any[]) => extractDominantColor(...a),
  isPublicImageUrl: (...a: any[]) => isPublicImageUrl(...a),
  launchCreativeBrowser: (...a: any[]) => launchCreativeBrowser(...a),
  // reference fetch + vision classify on the regenerate path. Defaults to
  // null/no-hint so refs aren't asserted unless a precedence test opts in.
  safeFetchPublicImage: (...a: any[]) => safeFetchPublicImage(...a),
  classifyCard: (...a: any[]) => classifyCard(...a),
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
  // billing enforced in this suite — it exercises the enforcePlanLimit gate path
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
 *    skips the plan-expiry revert DB read. media.create returns a known row. ── */
const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const mediaCreate = vi.fn();
const mediaFindFirst = vi.fn();
const channelFindFirst = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    // orgProcedure reads this in its plan-expiry guard for non-superadmin actors.
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    media: {
      create: (...a: any[]) => mediaCreate(...a),
      findFirst: (...a: any[]) => mediaFindFirst(...a),
    },
    channel: { findFirst: (...a: any[]) => channelFindFirst(...a) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { repurposeRouter, resolveLogoForOrg, capHeadline } from "../routers/repurpose.router";
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
  // Logo-resolver fallthrough: by default no channel / no DB logo media, so
  // resolveLogoForOrg returns input.logoUrl (or undefined) untouched.
  channelFindFirst.mockResolvedValue(null);
  mediaFindFirst.mockResolvedValue(null);
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

  it("returns bgSource + imageEngine so the UI engine chip refreshes after a regenerate", async () => {
    // A dalle-sourced background maps to the "openai" engine label.
    generateImageSafe.mockResolvedValueOnce({
      imageBase64: "BG_BYTES",
      mimeType: "image/png",
      source: "dalle",
    } as any);
    const caller = makeCaller();
    const res = await caller.regenerateImage(input());
    expect(res.bgSource).toBe("ai");
    expect(res.imageEngine).toBe("openai");
  });

  it("AI-failure regenerate reports a real background and NO engine (chip hides)", async () => {
    generateImageSafe.mockRejectedValueOnce(new Error("ai down"));
    const caller = makeCaller();
    const res = await caller.regenerateImage(input());
    expect(res.bgSource).toBe("real");
    expect(res.imageEngine).toBeNull();
  });

  it("hook_bars now generates an AI background like every other style", async () => {
    const caller = makeCaller();
    await caller.regenerateImage(input({ creativeStyle: "hook_bars" }));
    // 2026-06-11: ALL styles get an AI background (was: hook_bars skipped it).
    expect(generateImageSafe).toHaveBeenCalledTimes(1);
    expect(generateStyledCreativeImage).toHaveBeenCalledTimes(1);
    // The AI background (a data: URI) reaches the template render as bgImageUrl.
    const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
    expect(renderArgs.bgImageUrl).toMatch(/^data:image\//);
  });

  it("parity: hook_bars + a hookLine reaches the creative template render", async () => {
    const caller = makeCaller();
    await caller.regenerateImage(
      input({ creativeStyle: "hook_bars", hookLine: "This **changes** everything" }),
    );
    const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
    expect(renderArgs.hookLine).toBe("This **changes** everything");
  });

  it("parity: a long (>12-word) headline is capped before it reaches the render", async () => {
    const longHeadline =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    const caller = makeCaller();
    await caller.regenerateImage(input({ headline: longHeadline }));
    const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
    const used: string = renderArgs.headline;
    // capHeadline contract: ≤16 words AND ≤90 chars.
    expect(used.trim().split(/\s+/).length).toBeLessThanOrEqual(16);
    expect(used.length).toBeLessThanOrEqual(90);
    expect(used).toBe(capHeadline(longHeadline));
  });

  it("parity: a passed-in https bgImageUrl is the AI-failure fallback background", async () => {
    // All styles generate an AI bg now, so on SUCCESS the AI data: URI overrides
    // any passed-in url. The passed-in article photo is the FALLBACK: simulate an
    // AI failure and assert the render falls back to that url (not blank).
    generateImageSafe.mockRejectedValueOnce(new Error("ai down"));
    const caller = makeCaller();
    await caller.regenerateImage(
      input({
        creativeStyle: "hook_bars",
        bgImageUrl: "https://cdn.example.com/article-photo.jpg",
      }),
    );
    const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
    // safeFetchPublicImage is mocked to null → the url stays as-is (not a data URI).
    expect(renderArgs.bgImageUrl).toBe("https://cdn.example.com/article-photo.jpg");
  });

  it("SSRF: a private-host bgImageUrl is dropped (never reaches the render bg)", async () => {
    // Even with the AI bg failing, a private-host fallback must be dropped — the
    // render should get the AI nothing-fallback, NOT the internal url.
    generateImageSafe.mockRejectedValueOnce(new Error("ai down"));
    const caller = makeCaller();
    await caller.regenerateImage(
      input({
        creativeStyle: "hook_bars",
        bgImageUrl: "https://10.0.0.5/internal.jpg",
      }),
    );
    expect(isPublicImageUrl).toHaveBeenCalledWith("https://10.0.0.5/internal.jpg");
    const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
    // Disallowed bg dropped before render; AI failed → no bgImageUrl at all.
    expect(renderArgs.bgImageUrl ?? null).toBeNull();
  });

  it("parity: bgContext is interpolated into the AI background prompt", async () => {
    const caller = makeCaller();
    // premium_editorial DOES generate an AI background, so the prompt is observable.
    await caller.regenerateImage(
      input({ creativeStyle: "premium_editorial", bgContext: "A bustling night market in Mumbai" }),
    );
    const bgArgs = generateImageSafe.mock.calls[0]?.[0] as any;
    expect(String(bgArgs.prompt)).toContain("A bustling night market in Mumbai");
  });

  // ── Round 9: accent-color precedence (picker > style-ref > logo > default) ──
  // Root cause of the user's "the fade copies but the color doesn't" report: the
  // reference's detected accent was LAST in line behind the logo color, so a logo
  // (or a saved-style color) shadowed it. These lock the corrected precedence.
  describe("accent-color precedence", () => {
    it("a style reference's detected accent is used when no explicit picker color is set", async () => {
      safeFetchPublicImage.mockResolvedValueOnce({ base64: "REFBYTES", mimeType: "image/png" });
      classifyCard.mockResolvedValueOnce({ accentColor: "#ff7a00" }); // orange, like the Moviefied ref
      const caller = makeCaller();
      await caller.regenerateImage(
        input({ aestheticRefUrl: "https://cdn.example.com/moviefied-ref.png" }),
      );
      const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
      expect(renderArgs.brandColor).toBe("#ff7a00");
    });

    it("the explicit picker color WINS over a style reference's detected accent", async () => {
      safeFetchPublicImage.mockResolvedValueOnce({ base64: "REFBYTES", mimeType: "image/png" });
      classifyCard.mockResolvedValueOnce({ accentColor: "#ff7a00" });
      const caller = makeCaller();
      await caller.regenerateImage(
        input({ accentColor: "#0055ff", aestheticRefUrl: "https://cdn.example.com/ref.png" }),
      );
      const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
      expect(renderArgs.brandColor).toBe("#0055ff");
      // The reference is never even classified for color when the picker wins.
      expect(classifyCard).not.toHaveBeenCalled();
    });

    it("a style reference's accent BEATS the logo color (the regression this fixes)", async () => {
      // Logo extraction would return #123456 (mocked); the reference's orange must win.
      safeFetchPublicImage.mockResolvedValueOnce({ base64: "REFBYTES", mimeType: "image/png" });
      classifyCard.mockResolvedValueOnce({ accentColor: "#ff7a00" });
      const caller = makeCaller();
      await caller.regenerateImage(
        input({
          logoUrl: "https://cdn.example.com/logo.png",
          aestheticRefUrl: "https://cdn.example.com/ref.png",
        }),
      );
      const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
      expect(renderArgs.brandColor).toBe("#ff7a00");
      expect(renderArgs.brandColor).not.toBe("#123456"); // NOT the logo color
    });

    it("falls back to the logo color when there is no reference and no picker color", async () => {
      const caller = makeCaller();
      await caller.regenerateImage(input({ logoUrl: "https://cdn.example.com/logo.png" }));
      const renderArgs = generateStyledCreativeImage.mock.calls[0]?.[0] as any;
      expect(renderArgs.brandColor).toBe("#123456"); // extractDominantColor mock
    });
  });
});

describe("resolveLogoForOrg", () => {
  beforeEach(() => {
    channelFindFirst.mockResolvedValue(null);
    mediaFindFirst.mockResolvedValue(null);
  });

  it("returns the supplied logoUrl when set (no DB lookup needed)", async () => {
    const res = await resolveLogoForOrg(prismaMock as any, {
      organizationId: ORG_ID,
      logoUrl: "https://cdn.example.com/logo.png",
      channelName: "Acme",
    });
    expect(res.logoUrl).toBe("https://cdn.example.com/logo.png");
    // input.logoUrl short-circuits the channel/DB lookup.
    expect(channelFindFirst).not.toHaveBeenCalled();
  });

  it("falls through to a DB category:logo media url when no logoUrl is supplied", async () => {
    channelFindFirst.mockResolvedValue({ id: "ch-1", avatar: "https://cdn/av.png", metadata: null });
    mediaFindFirst.mockResolvedValue({ url: "https://cdn.example.com/db-logo.png" });
    const res = await resolveLogoForOrg(prismaMock as any, {
      organizationId: ORG_ID,
      channelName: "Acme",
    });
    expect(res.logoUrl).toBe("https://cdn.example.com/db-logo.png");
  });

  it("falls through to channel.avatar when there is no DB logo media", async () => {
    channelFindFirst.mockResolvedValue({ id: "ch-1", avatar: "https://cdn.example.com/av.png", metadata: null });
    mediaFindFirst.mockResolvedValue(null);
    const res = await resolveLogoForOrg(prismaMock as any, {
      organizationId: ORG_ID,
      channelName: "Acme",
    });
    expect(res.logoUrl).toBe("https://cdn.example.com/av.png");
  });
});
