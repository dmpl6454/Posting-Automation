import { describe, it, expect, vi } from "vitest";
import { assertMediaOwned } from "../routers/chat.router";

function mockPrisma(found: Array<{ id: string }>) {
  return { media: { findMany: vi.fn(async () => found) } } as any;
}

describe("assertMediaOwned", () => {
  it("passes for empty mediaIds", async () => {
    await expect(assertMediaOwned(mockPrisma([]), "org-1", [])).resolves.toBeUndefined();
  });
  it("passes when all media belong to the org", async () => {
    await expect(assertMediaOwned(mockPrisma([{ id: "m1" }, { id: "m2" }]), "org-1", ["m1", "m2"])).resolves.toBeUndefined();
  });
  it("throws FORBIDDEN when a media id is foreign", async () => {
    await expect(assertMediaOwned(mockPrisma([{ id: "m1" }]), "org-1", ["m1", "m-other"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
