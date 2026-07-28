/**
 * buildSuperTextPayload — Compose's postMedia → post.create `metadata.superText`.
 *
 * The index-alignment case matters most: a mismatch here would burn one video's
 * text strip onto a DIFFERENT video.
 */
import { describe, it, expect } from "vitest";
import { buildSuperTextPayload } from "./super-text-payload";
import type { SuperTextConfig } from "@postautomation/super-text";

const cfg = (text: string): SuperTextConfig => ({
  version: 1,
  segments: [{ text }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
});

describe("buildSuperTextPayload", () => {
  it("returns {} when nothing has super text (ordinary post stays byte-identical)", () => {
    expect(buildSuperTextPayload([{}, {}], ["m1", "m2"])).toEqual({});
    expect(buildSuperTextPayload([], [])).toEqual({});
  });

  it("keys each config by the media id at the SAME index", () => {
    const out = buildSuperTextPayload(
      [{}, { superText: cfg("second") }, { superText: cfg("third") }],
      ["m1", "m2", "m3"]
    );
    expect(Object.keys(out).sort()).toEqual(["m2", "m3"]);
    expect(out.m2!.segments[0]!.text).toBe("second");
    expect(out.m3!.segments[0]!.text).toBe("third");
    expect(out.m1).toBeUndefined();
  });

  it("drops an invalid restored config instead of failing the whole post", () => {
    const bad = { ...cfg("x"), stripColor: "not-a-hex" } as unknown as SuperTextConfig;
    const out = buildSuperTextPayload([{ superText: bad }, { superText: cfg("ok") }], ["m1", "m2"]);
    expect(out.m1).toBeUndefined();
    expect(out.m2).toBeDefined();
  });

  it("ignores an item with no resolved media id", () => {
    expect(buildSuperTextPayload([{ superText: cfg("x") }], [])).toEqual({});
  });

  it("carries the chosen font through to the payload", () => {
    const out = buildSuperTextPayload([{ superText: { ...cfg("hi"), font: "sans" } }], ["m1"]);
    expect(out.m1!.font).toBe("sans");
  });

  it("a config with no font round-trips with NO injected key", () => {
    // zod must not default this field: an injected key would change
    // JSON.stringify and therefore the worker's S3 burn-cache hash for every
    // pre-existing config, forcing needless re-burns of correct videos.
    const out = buildSuperTextPayload([{ superText: cfg("hi") }], ["m1"]);
    expect("font" in out.m1!).toBe(false);
  });

  it("drops a config with a bogus font instead of failing the whole post", () => {
    const bad = { ...cfg("x"), font: "comic-sans" } as unknown as SuperTextConfig;
    const out = buildSuperTextPayload([{ superText: bad }, { superText: cfg("ok") }], ["m1", "m2"]);
    expect(out.m1).toBeUndefined();
    expect(out.m2).toBeDefined();
  });
});
