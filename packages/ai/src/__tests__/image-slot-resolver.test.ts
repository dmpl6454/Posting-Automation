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

// REP-3 postcard tiles must honor user → ARTICLE → AI: a tile with a real photo
// (user or article) must NOT be replaced by an AI image even when aiImages=true.
// The resolver's AI rung fires on aiToggle ALONE (ignores aiPrompt), so the router
// gates aiToggle OFF per-tile when a real photo exists. This models that decision.
describe("postcard per-tile precedence (REP-3 regression guard) — user → article → AI", () => {
  const resolveTile = (
    args: { userId?: string; artUrl?: string },
    ctxAiToggle: boolean,
  ) => {
    const hasRealPhoto = !!args.userId || !!args.artUrl;
    return resolveImageSlot(
      {
        ...(args.userId ? { userImageId: args.userId } : {}),
        ...(args.artUrl ? { articleImageUrl: args.artUrl } : {}),
        ...(!hasRealPhoto ? { aiPrompt: "tile" } : {}),
      },
      { ...baseCtx(), aiToggle: hasRealPhoto ? false : ctxAiToggle, articleImages: [] },
    );
  };

  it("a tile WITH an article image uses the article photo, NOT AI (even with aiImages on)", async () => {
    const r = await resolveTile({ artUrl: "https://cdn/a.jpg" }, true);
    expect(r).toEqual({ url: "https://cdn/a.jpg", source: "article" });
  });

  it("a tile WITH a user image uses the user photo, NOT AI (even with aiImages on)", async () => {
    // A user-assigned tile gates aiToggle off → AI never runs, user photo wins.
    const ctx = { ...baseCtx(), aiToggle: false, userImages: { u1: { url: "https://cdn/u.jpg" } } };
    const r = await resolveImageSlot({ userImageId: "u1" }, ctx);
    expect(r).toEqual({ url: "https://cdn/u.jpg", source: "user" });
    expect(ctx.generateAi).not.toHaveBeenCalled();
  });

  it("an EMPTY tile (no user, no article) DOES generate AI when aiImages on", async () => {
    const r = await resolveTile({}, true);
    expect(r.source).toBe("ai");
  });

  it("an EMPTY tile falls to branded when aiImages off", async () => {
    const r = await resolveTile({}, false);
    expect(r.source).toBe("branded");
  });
});
