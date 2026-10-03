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

/**
 * ADDITIONS (2026-10-02): the `insta` layout preset + `scope`/`introSeconds` keys.
 * Separate snapshots — the classic block above must still pass with 0 written.
 */
describe("golden render gate — insta layout preset (opt-in)", () => {
  const insta: SuperTextConfig = {
    ...golden,
    font: "sans",
    layout: "insta",
    scope: "cover",
    yPct: 84,
    fontSizePct: 4.6,
    segments: [
      { text: "Anil", color: "#D8501B" },
      { text: "Kapoor", color: "#D8501B" },
      { text: "exits" },
      { text: "from" },
      { text: "Juhu" },
      { text: "PVR" },
    ],
  };

  it("strip inner html for insta is pinned", () => {
    expect(buildStripInnerHtml(insta)).toMatchSnapshot();
  });

  it("burn frame html for insta is pinned at 1080x1920 (the @font-face payload stripped)", () => {
    const html = buildSuperTextFrameHtml(insta, 1080, 1920).replace(/base64,[A-Za-z0-9+/=]+/, "base64,<payload>");
    expect(html).toMatchSnapshot();
  });

  /**
   * ADDITION (2026-10-03): the real Instagram Sans Medium at the new M preset.
   * The `sans` snapshots above stay byte-identical — this is a further block.
   */
  it("strip inner html for the instagram face at M (4.8) is pinned", () => {
    expect(buildStripInnerHtml({ ...insta, font: "instagram", fontSizePct: 4.8 })).toMatchSnapshot();
  });

  it("burn frame for the instagram face declares its @font-face at weight 700 (the Bold cut)", () => {
    const html = buildSuperTextFrameHtml({ ...insta, font: "instagram", fontSizePct: 4.8 }, 1080, 1920);
    expect(html).toContain("font-family:'Instagram Sans';font-style:normal;font-weight:700;");
    expect(html.replace(/base64,[A-Za-z0-9+/=]+/, "base64,<payload>")).toMatchSnapshot();
  });

  /** ADDITION (2026-10-03): a manual line break. Absent ⇒ every snapshot above is unchanged. */
  it("strip inner html with a manual break after 'PVR' is pinned", () => {
    expect(
      buildStripInnerHtml({
        ...insta,
        font: "instagram",
        fontSizePct: 4.8,
        segments: [...insta.segments.slice(0, -1), { text: "PVR", break: true }, { text: "Any" }, { text: "guess?" }],
      })
    ).toMatchSnapshot();
  });

  it("scope and introSeconds never reach the CSS — same strip html whatever the scope", () => {
    expect(buildStripInnerHtml({ ...insta, scope: "video" })).toBe(buildStripInnerHtml(insta));
    expect(buildStripInnerHtml({ ...insta, scope: "intro", introSeconds: 5 })).toBe(buildStripInnerHtml(insta));
  });
});
