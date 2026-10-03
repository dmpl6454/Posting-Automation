import { describe, it, expect } from "vitest";
import {
  collectPerTargetMediaIds,
  sourceMediaIdOf,
  substitutePerTargetMedia,
} from "./per-target-media";

type Row = { id: string; url: string; metadata: unknown };
const original: Row = { id: "src-1", url: "https://s3/src.mp4", metadata: null };
const baseBurn: Row = {
  id: "burn-0",
  url: "https://s3/burn0.mp4",
  metadata: { superText: { sourceMediaId: "src-1" } },
};
const variant: Row = {
  id: "burn-3",
  url: "https://s3/burn3.mp4",
  metadata: { superText: { sourceMediaId: "src-1", variant: 3 } },
};
const image: Row = { id: "img-1", url: "https://s3/a.png", metadata: null };

describe("collectPerTargetMediaIds", () => {
  it("is empty for every pre-feature target shape", () => {
    expect(collectPerTargetMediaIds(null)).toEqual([]);
    expect(collectPerTargetMediaIds(undefined)).toEqual([]);
    expect(collectPerTargetMediaIds({})).toEqual([]);
    expect(collectPerTargetMediaIds({ igStoryContainer: { id: "x" } })).toEqual([]);
    expect(collectPerTargetMediaIds({ superTextMedia: "garbage" })).toEqual([]);
    expect(collectPerTargetMediaIds({ superTextMedia: [] })).toEqual([]);
  });

  it("returns the derived ids, deduped, ignoring malformed entries", () => {
    expect(
      collectPerTargetMediaIds({
        superTextMedia: {
          "src-1": { mediaId: "burn-3", text: "hi" },
          "src-2": { mediaId: "burn-3" },
          "src-3": { mediaId: 7 },
          "src-4": null,
        },
      })
    ).toEqual(["burn-3"]);
  });
});

describe("substitutePerTargetMedia", () => {
  const attachments = [
    { id: "pm-1", mediaId: "burn-0", order: 0, media: baseBurn },
    { id: "pm-2", mediaId: "img-1", order: 1, media: image },
  ];

  it("returns the SAME array when the target carries no map (byte-identical path)", () => {
    expect(substitutePerTargetMedia(attachments, null, [variant])).toBe(attachments);
    expect(substitutePerTargetMedia(attachments, {}, [variant])).toBe(attachments);
  });

  it("matches a repointed base burn back to its SOURCE id and swaps the row", () => {
    const out = substitutePerTargetMedia(
      attachments,
      { superTextMedia: { "src-1": { mediaId: "burn-3", text: "hi" } } },
      [variant]
    );
    expect(out).not.toBe(attachments);
    expect(out[0]).toMatchObject({ id: "pm-1", order: 0, mediaId: "burn-3", media: variant });
    // Untouched attachment keeps its identity.
    expect(out[1]).toBe(attachments[1]);
  });

  it("also matches when the attachment still points at the ORIGINAL source", () => {
    const out = substitutePerTargetMedia(
      [{ id: "pm-1", mediaId: "src-1", order: 0, media: original }],
      { superTextMedia: { "src-1": { mediaId: "burn-3" } } },
      [variant]
    );
    expect(out[0]!.media).toBe(variant);
  });

  it("leaves the shared attachment when the derived row did not load (degrade, never fail)", () => {
    const out = substitutePerTargetMedia(
      attachments,
      { superTextMedia: { "src-1": { mediaId: "burn-missing" } } },
      []
    );
    expect(out).toBe(attachments);
  });

  it("is a no-op when the target already points at its own variant", () => {
    const own = [{ id: "pm-1", mediaId: "burn-3", order: 0, media: variant }];
    expect(
      substitutePerTargetMedia(own, { superTextMedia: { "src-1": { mediaId: "burn-3" } } }, [variant])
    ).toBe(own);
  });

  it("sourceMediaIdOf falls back to the row's own id", () => {
    expect(sourceMediaIdOf(original)).toBe("src-1");
    expect(sourceMediaIdOf(baseBurn)).toBe("src-1");
    expect(sourceMediaIdOf({ id: "x", metadata: { superText: { sourceMediaId: "" } } })).toBe("x");
  });
});
