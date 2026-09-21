import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCaptionOverridesPayload, sanitizeRestoredCaptionOverrides } from "./caption-overrides-payload";

describe("buildCaptionOverridesPayload", () => {
  it("returns an empty object when nothing is custom — caller omits the key", () => {
    expect(buildCaptionOverridesPayload({}, ["a", "b"], "shared")).toEqual({});
  });

  it("sends only STILL-selected channels (the editor map is never pruned on deselect)", () => {
    expect(buildCaptionOverridesPayload({ a: "A", gone: "G" }, ["a", "b"], "shared")).toEqual({ a: "A" });
  });

  it("drops blank captions and captions identical to the shared one", () => {
    expect(buildCaptionOverridesPayload({ a: "  ", b: "shared\n", c: "Own" }, ["a", "b", "c"], "shared")).toEqual({
      c: "Own",
    });
  });

  it("keeps the caption verbatim", () => {
    const caption = "Hi 👋\n\n#tag ";
    expect(buildCaptionOverridesPayload({ a: caption }, ["a"], "x")).toEqual({ a: caption });
  });
});

describe("sanitizeRestoredCaptionOverrides", () => {
  it("drops non-object / array / non-string junk from an old or hand-edited draft", () => {
    expect(sanitizeRestoredCaptionOverrides(undefined)).toEqual({});
    expect(sanitizeRestoredCaptionOverrides(null)).toEqual({});
    expect(sanitizeRestoredCaptionOverrides([1, 2])).toEqual({});
    expect(sanitizeRestoredCaptionOverrides("nope")).toEqual({});
    expect(sanitizeRestoredCaptionOverrides({ a: 1, b: null, c: "ok", d: "   " })).toEqual({ c: "ok" });
  });
});

describe("ComposeTab wiring (source-level contract)", () => {
  const src = readFileSync(join(__dirname, "..", "components", "content-agent", "ComposeTab.tsx"), "utf8");

  it("both create paths (publish/schedule AND save-draft) send captionOverrides only when non-empty", () => {
    const hits = src.match(/\.\.\.\(Object\.keys\(manualCaptions\)\.length > 0 && \{ captionOverrides: manualCaptions \}\)/g);
    expect(hits?.length).toBe(2);
  });

  it("never sends per-channel captions for a story (no caption to vary)", () => {
    const hits = src.match(/!isStoryMode && customCaptions\s*\?\s*buildCaptionOverridesPayload\(captionOverrides, selectedChannels, content\)/g);
    expect(hits?.length).toBe(2);
  });

  it("persists the draft on a string signature, never the map's identity (OOM dep rule)", () => {
    expect(src).toMatch(/const captionOverridesSignature = customCaptions \? JSON\.stringify\(captionOverrides\) : ""/);
    // 2026-09-21: campaignLabel appended (a plain string — no identity churn).
    expect(src).toMatch(/storyMentionsSignature, captionOverridesSignature, campaignLabel\]\);/);
  });

  it("re-validates a restored draft's map and turns the editor on so it is visible", () => {
    expect(src).toMatch(/sanitizeRestoredCaptionOverrides\(saved\.draft\.captionOverrides\)/);
    expect(src).toMatch(/setCaptionOverrides\(restoredOverrides\);\s*setCustomCaptions\(true\);/);
  });

  it("resets the editor after a successful create", () => {
    expect(src).toMatch(/setCustomCaptions\(false\);\s*setCaptionOverrides\(\{\}\);/);
  });
});
