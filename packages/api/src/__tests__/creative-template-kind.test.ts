import { describe, it, expect } from "vitest";
import { deriveTemplateKind } from "../routers/creative-template.router";

describe("deriveTemplateKind", () => {
  it("returns the explicit kind when provided, even if referenceMediaId is present", () => {
    expect(deriveTemplateKind({ kind: "logo", referenceMediaId: "some-media-id" })).toBe("logo");
  });

  it("returns 'style' when referenceMediaId is present and kind is not set", () => {
    expect(deriveTemplateKind({ referenceMediaId: "some-media-id" })).toBe("style");
  });

  it("returns 'logo' when no referenceMediaId and no explicit kind", () => {
    expect(deriveTemplateKind({})).toBe("logo");
  });
});
