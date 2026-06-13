import { describe, it, expect } from "vitest";
import { buildSavedStyleName, shouldPersistReference } from "../routers/repurpose.router";

describe("saved-style persistence helpers", () => {
  it("buildSavedStyleName derives a readable name from a hint preset + date", () => {
    const name = buildSavedStyleName("news_inset", new Date("2026-06-13T00:00:00Z"));
    expect(name).toMatch(/News Inset/);
    expect(name).toMatch(/2026-06-13/);
  });

  it("buildSavedStyleName falls back to 'Saved style' for an unknown preset", () => {
    expect(buildSavedStyleName(undefined, new Date("2026-06-13T00:00:00Z"))).toMatch(/Saved style/);
  });

  it("shouldPersistReference true only with a stored media id AND a confident hint", () => {
    expect(shouldPersistReference("media-1", { confidence: 0.8 } as any)).toBe(true);
    expect(shouldPersistReference("media-1", { confidence: 0.2 } as any)).toBe(false);
    expect(shouldPersistReference(undefined, { confidence: 0.9 } as any)).toBe(false);
    expect(shouldPersistReference("media-1", null)).toBe(false);
  });
});
