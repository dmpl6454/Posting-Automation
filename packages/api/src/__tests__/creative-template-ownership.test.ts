import { describe, it, expect, vi } from "vitest";
import { assertLogoMediaOwned } from "../routers/creative-template.router";

function mockPrisma(found: Array<{ id: string }>) {
  return {
    media: { findFirst: vi.fn(async () => found[0] ?? null) },
  } as any;
}

describe("assertLogoMediaOwned", () => {
  it("passes when logoMediaId is undefined (no-reference path)", async () => {
    await expect(assertLogoMediaOwned(mockPrisma([]), "org-1", undefined)).resolves.toBeUndefined();
  });
  it("passes when the logo media belongs to the org", async () => {
    await expect(assertLogoMediaOwned(mockPrisma([{ id: "m1" }]), "org-1", "m1")).resolves.toBeUndefined();
  });
  it("throws FORBIDDEN when the logo media is not in the org", async () => {
    await expect(assertLogoMediaOwned(mockPrisma([]), "org-1", "m-other")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
