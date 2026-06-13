import { describe, it, expect, vi } from "vitest";
import { assertLogoMediaOwned } from "../routers/creative-template.router";
import { sanitizeCardSpecJson } from "../lib/sanitize-card-spec";

describe("creativeTemplate cardSpec persistence + read sanitization", () => {
  it("assertLogoMediaOwned throws FORBIDDEN for a foreign media id", async () => {
    const prisma = { media: { findFirst: vi.fn(async () => null) } };
    await expect(assertLogoMediaOwned(prisma, "org1", "m-other-org")).rejects.toThrow(/not found/i);
  });

  it("assertLogoMediaOwned passes for an owned media id", async () => {
    const prisma = { media: { findFirst: vi.fn(async () => ({ id: "m1" })) } };
    await expect(assertLogoMediaOwned(prisma, "org1", "m1")).resolves.toBeUndefined();
  });

  it("assertReferenceMediaOwned throws FORBIDDEN for a foreign reference id", async () => {
    const { assertReferenceMediaOwned } = await import("../routers/creative-template.router");
    const prisma = { media: { findFirst: vi.fn(async () => null) } };
    await expect(assertReferenceMediaOwned(prisma, "org1", "ref-other")).rejects.toThrow(/not found/i);
  });

  it("a stored cardSpec with a tampered color is scrubbed on read", () => {
    const tampered = {
      canvas: { w: 1080, h: 1350 },
      controls: { theme: "light", brandColor: '#000" onload=x', highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" },
      blocks: [],
    };
    expect(sanitizeCardSpecJson(tampered)!.controls.brandColor).toBe("#e11d48");
  });
});
