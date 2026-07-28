/**
 * 🔒 GOLDEN RENDER GATE — keep green, never run `-u` blindly.
 *
 * Snapshots the DEFAULT (font-less, i.e. "classic") strip and burn-frame output.
 * Any change that alters a default-path render fails this test. When adding a
 * render feature, gate it behind an option that defaults to today's behaviour so
 * this passes with 0 snapshots written — that 0-written result IS the
 * byte-identity proof for every post and draft already in the system.
 *
 * Only run `-u` for a deliberately approved change, and confirm the diff is
 * ADDITIONS ONLY (new snapshots), never a modification to an existing one.
 *
 * Mirrors packages/ai/src/__tests__/repurpose-render-golden.test.ts.
 */
import { describe, it, expect } from "vitest";
import { buildStripInnerHtml, buildSuperTextFrameHtml } from "../html";
import type { SuperTextConfig } from "../schema";

/** Exercises per-word colour, an inherited colour, and emoji in one fixture. */
const golden: SuperTextConfig = {
  version: 1,
  segments: [{ text: "Ranveer" }, { text: "returns", color: "#EF4444" }, { text: "😍✨" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

describe("golden render gate — default (classic) path", () => {
  it("strip inner html is unchanged", () => {
    expect(buildStripInnerHtml(golden)).toMatchSnapshot();
  });

  it("burn frame html is unchanged at 1080x1920", () => {
    expect(buildSuperTextFrameHtml(golden, 1080, 1920)).toMatchSnapshot();
  });

  it("burn frame html is unchanged at 720x1280", () => {
    expect(buildSuperTextFrameHtml(golden, 720, 1280)).toMatchSnapshot();
  });

  it("an explicit font:'classic' is identical to omitting it", () => {
    expect(buildStripInnerHtml({ ...golden, font: "classic" })).toMatchSnapshot();
  });
});
