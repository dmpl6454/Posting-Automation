/**
 * Round 9 — `repurpose.classifyStyleReference` now returns the reference's
 * detected accent color + theme (in addition to suggestedStyle/confidence) so
 * the UI can PRE-FILL the brand-color + theme controls on reference attach
 * (overridable). These lock the widened return shape + the fail-soft contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const safeFetchPublicImage = vi.fn(async (..._a: any[]) => null as { base64: string; mimeType: string } | null);
const classifyCard = vi.fn(
  async (..._a: any[]) =>
    null as { preset: string; theme: "light" | "dark"; accentColor: string; confidence: number } | null,
);
const isPublicImageUrl = vi.fn((..._a: any[]) => true);
const isPublicPageUrl = vi.fn((..._a: any[]) => false);
const resolveImageFromPageUrl = vi.fn(async (..._a: any[]) => null as string | null);

vi.mock("@postautomation/ai", () => ({
  safeFetchPublicImage: (...a: any[]) => safeFetchPublicImage(...a),
  classifyCard: (...a: any[]) => classifyCard(...a),
  isPublicImageUrl: (...a: any[]) => isPublicImageUrl(...a),
  isPublicPageUrl: (...a: any[]) => isPublicPageUrl(...a),
  resolveImageFromPageUrl: (...a: any[]) => resolveImageFromPageUrl(...a),
}));

import { createCallerFactory } from "../trpc";
import { repurposeRouter } from "../routers/repurpose.router";

function makeCaller() {
  const createCaller = createCallerFactory(repurposeRouter);
  return createCaller({
    prisma: {} as any,
    organizationId: "org-1",
    session: { user: { id: "u1", email: "x@y.z" }, expires: "2099-01-01" } as any,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("repurpose.classifyStyleReference", () => {
  it("returns the detected accent + theme alongside the suggested style", async () => {
    safeFetchPublicImage.mockResolvedValueOnce({ base64: "B", mimeType: "image/png" });
    classifyCard.mockResolvedValueOnce({
      preset: "news_caption", // → premium_editorial via presetToCreativeStyle
      theme: "light",
      accentColor: "#ff7a00",
      confidence: 0.82,
    });
    const caller = makeCaller();
    const res = await caller.classifyStyleReference({ aestheticRefUrl: "https://cdn.example.com/ref.png" });
    expect(res.accentColor).toBe("#ff7a00");
    expect(res.theme).toBe("light");
    expect(res.confidence).toBeCloseTo(0.82);
    expect(res.suggestedStyle).not.toBeNull();
  });

  it("fail-soft: an unfetchable reference returns all-null, never throws", async () => {
    safeFetchPublicImage.mockResolvedValueOnce(null);
    isPublicPageUrl.mockReturnValueOnce(false);
    const caller = makeCaller();
    const res = await caller.classifyStyleReference({ aestheticRefUrl: "https://cdn.example.com/dead.png" });
    expect(res).toEqual({ suggestedStyle: null, confidence: 0, accentColor: null, theme: null });
  });

  it("fail-soft: a classify miss returns all-null", async () => {
    safeFetchPublicImage.mockResolvedValueOnce({ base64: "B", mimeType: "image/png" });
    classifyCard.mockResolvedValueOnce(null);
    const caller = makeCaller();
    const res = await caller.classifyStyleReference({ aestheticRefUrl: "https://cdn.example.com/ref.png" });
    expect(res).toEqual({ suggestedStyle: null, confidence: 0, accentColor: null, theme: null });
  });
});
