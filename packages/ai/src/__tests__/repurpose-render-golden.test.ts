import { describe, it, expect } from "vitest";
import {
  buildStaticCreative,
  type StaticCreativeOptions,
  type CreativeStyle,
} from "../tools/creative-templates";

/**
 * Phase 4 byte-identical default-path safety gate (Task 10).
 *
 * These golden snapshots capture the EXACT HTML `buildStaticCreative` emits for
 * every CreativeStyle and slideRole with all REP-2/3/4 feature options UNSET.
 * The Repurpose feature work (per-slide text editing, postcard grid, free-drag)
 * must be strictly additive: with the new options untouched, the rendered output
 * must remain byte-identical to today. If a feature change alters any snapshot
 * below WITHOUT the corresponding new option being set, it has regressed an
 * existing render — revert and make the new behavior opt-in.
 *
 * Inputs are fully deterministic (no Date/Math.random) so snapshots are stable.
 * To intentionally update after an APPROVED additive change that legitimately
 * affects the default path, run with `-u` and review the diff carefully.
 */

const STYLES: CreativeStyle[] = [
  "premium_editorial",
  "hook_bars",
  "tweet_card",
  "bold_typographic",
];

/** A fixed, feature-option-free base for each style (the "today" default path). */
function baseFor(style: CreativeStyle): StaticCreativeOptions {
  return {
    style,
    headline: "Markets rally as central banks signal a pause on rate hikes",
    channelName: "Acme Newsroom",
    handle: "@acmenews",
    logoPosition: "top-left",
    brandColor: "#e11d48",
    verified: true,
    tag: "BREAKING",
    // NOTE: deliberately NO bgImageUrl / secondaryImageUrl / logoUrl / body /
    // hookLine here — REP-2/3/4 must not change the no-extra-input default render.
  };
}

describe("Repurpose render golden gate — default path is byte-identical (Phase 4 Task 10)", () => {
  for (const style of STYLES) {
    it(`${style} cover render is unchanged`, () => {
      expect(buildStaticCreative(baseFor(style))).toMatchSnapshot();
    });
  }

  it("carousel body slide render is unchanged", () => {
    expect(
      buildStaticCreative({
        ...baseFor("premium_editorial"),
        slideRole: "body",
        body: "The decision follows three consecutive quarters of easing inflation and steadier employment figures across major economies.",
      })
    ).toMatchSnapshot();
  });

  it("carousel cta slide render is unchanged", () => {
    expect(
      buildStaticCreative({
        ...baseFor("premium_editorial"),
        slideRole: "cta",
      })
    ).toMatchSnapshot();
  });

  it("hook_bars with a hook line is unchanged", () => {
    expect(
      buildStaticCreative({
        ...baseFor("hook_bars"),
        hookLine: "This **changes** everything",
      })
    ).toMatchSnapshot();
  });

  // Lock the DEFAULT_ACCENT path too: the baseFor() fixtures pass an explicit
  // brandColor, so without this case the default-accent code path would be
  // unguarded (verified: changing DEFAULT_ACCENT did not trip the other snapshots).
  for (const style of STYLES) {
    it(`${style} cover with NO brandColor (default accent) is unchanged`, () => {
      const opts = baseFor(style);
      delete opts.brandColor;
      expect(buildStaticCreative(opts)).toMatchSnapshot();
    });
  }
});
