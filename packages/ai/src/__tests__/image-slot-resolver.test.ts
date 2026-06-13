import { describe, it, expect, vi } from "vitest";
import { resolveImageSlot } from "../tools/image-slot-resolver";

const baseCtx = () => ({
  aiToggle: false,
  userImages: {} as Record<string, { url: string }>,
  articleImages: [] as string[],
  brandGradient: "linear-gradient(135deg,#e11d48,#11131a)",
  generateAi: vi.fn(async () => "data:image/png;base64,AAA"),
});

describe("resolveImageSlot — real-first ladder", () => {
  it("1) user-assigned image wins over everything", async () => {
    const ctx = { ...baseCtx(), aiToggle: true, userImages: { m1: { url: "https://cdn/u.jpg" } }, articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({ userImageId: "m1" }, ctx);
    expect(r).toEqual({ url: "https://cdn/u.jpg", source: "user" });
    expect(ctx.generateAi).not.toHaveBeenCalled();
  });

  it("2) AI generates when toggle on and no user image", async () => {
    const ctx = { ...baseCtx(), aiToggle: true, articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({}, ctx);
    expect(r.source).toBe("ai");
    expect(r.url).toBe("data:image/png;base64,AAA");
    expect(ctx.generateAi).toHaveBeenCalledTimes(1);
  });

  it("2b) AI failure falls through to article, never throws", async () => {
    const ctx = { ...baseCtx(), aiToggle: true, articleImages: ["https://cdn/a.jpg"], generateAi: vi.fn(async () => { throw new Error("billing hold"); }) };
    const r = await resolveImageSlot({}, ctx);
    expect(r).toEqual({ url: "https://cdn/a.jpg", source: "article" });
  });

  it("3) article image used when AI off", async () => {
    const ctx = { ...baseCtx(), articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({ articleImageUrl: "https://cdn/a.jpg" }, ctx);
    expect(r).toEqual({ url: "https://cdn/a.jpg", source: "article" });
  });

  it("3b) falls back to ctx.articleImages[0] when slot has no articleImageUrl", async () => {
    const ctx = { ...baseCtx(), articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({}, ctx);
    expect(r).toEqual({ url: "https://cdn/a.jpg", source: "article" });
  });

  it("4) branded gradient when nothing else, never blank", async () => {
    const ctx = baseCtx();
    const r = await resolveImageSlot({}, ctx);
    expect(r).toEqual({ url: ctx.brandGradient, source: "branded" });
  });

  it("ignores a userImageId not present in userImages (falls through)", async () => {
    const ctx = { ...baseCtx(), articleImages: ["https://cdn/a.jpg"] };
    const r = await resolveImageSlot({ userImageId: "ghost" }, ctx);
    expect(r.source).toBe("article");
  });
});
