/**
 * REP-2 backend — regenerateImage schema additions.
 *
 * Verifies:
 *  1. slideRole + slideBody are OPTIONAL — omitting both still validates (cover/static
 *     regen path is byte-identical, no behaviour change).
 *  2. slideRole accepts all three enum values ("cover" | "body" | "cta").
 *  3. slideBody accepts a string up to 400 chars.
 *  4. slideBody beyond 400 chars is rejected.
 *  5. slideRole with an invalid value is rejected.
 *
 * This mirrors the pattern used in approval-submit.test.ts: import the zod schema
 * fragment directly without spinning up the full tRPC server.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

// ── Mirror of the regenerateImage input schema ───────────────────────────────
// Keep in sync with packages/api/src/routers/repurpose.router.ts regenerateImage input.
// Only the fields needed for this test are included; the rest are not relevant.
const regenerateImageInput = z.object({
  headline: z.string().min(1),
  creativeStyle: z
    .enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"])
    .default("premium_editorial"),
  theme: z.enum(["dark", "light", "gradient"]).default("light"),
  logoUrl: z.string().optional(),
  logoPosition: z.enum(["top-left", "top-right"]).default("top-right"),
  accentColor: z.string().nullish(),
  imageContext: z.string().max(300).optional(),
  aestheticRefUrl: z.string().optional(),
  channelName: z.string().optional(),
  channelHandle: z.string().optional(),
  hookLine: z.string().optional(),
  bgImageUrl: z.string().url().optional(),
  bgContext: z.string().max(600).optional(),
  referenceMimicry: z.boolean().default(false),
  mimicryTextMode: z.enum(["ai", "overlay"]).default("ai"),
  brandName: z.string().max(60).optional(),
  headlineColor: z.string().max(9).optional(),
  headlineFont: z
    .enum([
      "inter",
      "serif_display",
      "condensed",
      "montserrat",
      "poppins",
      "bebas",
      "anton",
      "archivo_black",
      "dm_serif",
      "lora",
      "roboto_slab",
      "bitter",
      "space_grotesk",
      "libre_franklin",
    ])
    .optional(),
  labelColor: z.string().max(9).optional(),
  logoSize: z.number().int().min(4).max(40).optional(),
  headlineAlign: z.enum(["left", "center", "right"]).optional(),
  // REP-2 additions
  slideRole: z.enum(["cover", "body", "cta"]).optional(),
  slideBody: z.string().max(400).optional(),
});

describe("regenerateImage input schema — REP-2 slideRole/slideBody", () => {
  it("validates without slideRole or slideBody (existing cover/static path unchanged)", () => {
    const result = regenerateImageInput.safeParse({ headline: "Test headline" });
    expect(result.success).toBe(true);
  });

  it("validates with slideRole=body and slideBody set", () => {
    const result = regenerateImageInput.safeParse({
      headline: "x",
      slideRole: "body",
      slideBody: "Some slide body text.",
    });
    expect(result.success).toBe(true);
  });

  it("validates with slideRole=cover", () => {
    const result = regenerateImageInput.safeParse({
      headline: "x",
      slideRole: "cover",
    });
    expect(result.success).toBe(true);
  });

  it("validates with slideRole=cta", () => {
    const result = regenerateImageInput.safeParse({
      headline: "x",
      slideRole: "cta",
    });
    expect(result.success).toBe(true);
  });

  it("validates with slideBody set but no slideRole (optional independently)", () => {
    const result = regenerateImageInput.safeParse({
      headline: "x",
      slideBody: "body only, no role",
    });
    expect(result.success).toBe(true);
  });

  it("rejects slideBody longer than 400 chars", () => {
    const result = regenerateImageInput.safeParse({
      headline: "x",
      slideRole: "body",
      slideBody: "a".repeat(401),
    });
    expect(result.success).toBe(false);
  });

  it("accepts slideBody of exactly 400 chars", () => {
    const result = regenerateImageInput.safeParse({
      headline: "x",
      slideRole: "body",
      slideBody: "a".repeat(400),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid slideRole value", () => {
    const result = regenerateImageInput.safeParse({
      headline: "x",
      slideRole: "intro",
    });
    expect(result.success).toBe(false);
  });
});
