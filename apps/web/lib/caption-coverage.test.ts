import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captionBlockReason } from "./caption-coverage";

/**
 * The owner-reported gate: per-channel captions filled in, shared caption empty,
 * no way to publish. An empty shared caption is now allowed, but ONLY on full
 * per-channel coverage — partial coverage would publish empty text.
 */
describe("captionBlockReason", () => {
  const base = {
    content: "",
    customCaptions: true,
    selectedChannels: ["ch1", "ch2"],
    captionOverrides: {} as Record<string, string>,
  };

  it("does not block when a shared caption exists", () => {
    expect(captionBlockReason({ ...base, content: "hello" })).toBeNull();
  });

  it("does not block when a shared caption exists even with no overrides", () => {
    expect(
      captionBlockReason({ ...base, content: "hello", customCaptions: false })
    ).toBeNull();
  });

  it("THE BUG: does not block when every channel has its own caption and the shared box is empty", () => {
    expect(
      captionBlockReason({ ...base, captionOverrides: { ch1: "A", ch2: "B" } })
    ).toBeNull();
  });

  it("blocks on PARTIAL coverage and names how many are missing", () => {
    const reason = captionBlockReason({ ...base, captionOverrides: { ch1: "A" } });
    expect(reason).toBe(
      "1 of 2 channels still have no caption. Fill those in, or write a shared caption."
    );
  });

  it("treats a whitespace-only per-channel caption as missing", () => {
    expect(captionBlockReason({ ...base, captionOverrides: { ch1: "A", ch2: "  \n " } })).toMatch(
      /1 of 2 channels/
    );
  });

  it("blocks when the per-channel editor is off and there is no shared caption", () => {
    expect(captionBlockReason({ ...base, customCaptions: false })).toBe("Add a caption.");
  });

  it("blocks with no channels selected — nothing can cover the empty caption", () => {
    expect(captionBlockReason({ ...base, selectedChannels: [] })).toBe("Add a caption.");
  });

  it("blocks with the full message when the editor is on but entirely empty", () => {
    expect(captionBlockReason(base)).toBe(
      "Add a caption — either a shared one, or a caption for every selected channel."
    );
  });

  it("ignores overrides for channels that are no longer selected", () => {
    // The overrides map is never pruned on deselect, so a stale entry must not
    // count as coverage for a channel that IS selected.
    expect(
      captionBlockReason({ ...base, captionOverrides: { ch1: "A", removed: "B" } })
    ).toMatch(/1 of 2 channels/);
  });
});

describe("ComposeTab wiring (source-level contract)", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const compose = readFileSync(
    join(ROOT, "apps/web/components/content-agent/ComposeTab.tsx"),
    "utf8"
  );

  it("derives the gate from the shared helper, not a local re-implementation", () => {
    expect(compose).toMatch(/captionBlockReason\(/);
    expect(compose).toMatch(/const needsSharedCaption = /);
  });

  it("feeds ONE predicate to the submit handler and all three buttons", () => {
    // If these drift, a button enables and post.create then refuses — the exact
    // failure this fix removes.
    const uses = compose.match(/needsSharedCaption/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });

  it("leaves the preview placeholder on the RAW content check", () => {
    // `!isStoryMode && !content && selectedPlatforms.length === 0` renders the
    // "start typing" empty state. It is not a gate: swapping it would hide the
    // placeholder as soon as per-channel captions covered every channel.
    expect(compose).toMatch(/!isStoryMode && !content && selectedPlatforms\.length === 0/);
  });
});
