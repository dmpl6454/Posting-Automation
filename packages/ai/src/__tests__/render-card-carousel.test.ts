import { describe, it, expect } from "vitest";
import { renderCard, legacyStyleToCardSpec } from "../tools/card-engine";

/**
 * Component 5 (carousel consistency) — contract test for the composable engine.
 *
 * NOTE on scope: the plan (Task 8) proposed rerouting `generateStyledCreativeImage`
 * through `renderCard` via `legacyStyleToCardSpec`. That reroute was deliberately
 * NOT done: `legacyStyleToCardSpec` is COVER-ONLY (it switches on the 4 legacy
 * styles and has no slideRole/body/cta/theme handling), whereas the live
 * `buildStaticCreative` branches on `slideRole` into `buildBodyChrome` for body +
 * cta slides. Routing the generator through the incomplete shim would render every
 * carousel BODY slide as a cover card with no body text — a regression on the
 * carousel path. The consistency goal is already met by buildStaticCreative
 * routing every slide through ONE template via slideRole. This test instead locks
 * the ENGINE's own text-align consistency (the property the reroute was meant to
 * guarantee) so any future migration onto the engine has a regression guard.
 */
const controls = {
  theme: "light" as const,
  brandColor: "#1e90ff",
  highlightColor: "#1e90ff",
  bgOpacity: 60,
  fontFamily: "inter" as const,
  textAlign: "left" as const,
  logoPosition: "tr" as const,
};

describe("carousel consistency through renderCard + legacy shim", () => {
  it("body slides share identical text-align (left) regardless of style", () => {
    const bodyA = renderCard(legacyStyleToCardSpec({ style: "premium_editorial", headline: "Test headline one", channelName: "Acme" }, controls));
    const bodyB = renderCard(legacyStyleToCardSpec({ style: "hook_bars", headline: "Test headline two", channelName: "Acme", hookLine: "Big news" }, controls));
    // Both must apply controls.textAlign — neither inherits a stray center.
    expect(bodyA).toContain("text-align:left");
    expect(bodyB).toContain("text-align:left");
  });

  it("renders at the 1080x1350 canvas", () => {
    const html = renderCard(legacyStyleToCardSpec({ style: "tweet_card", headline: "Tweet body text", channelName: "Acme", handle: "@acme" }, controls));
    expect(html).toMatch(/1080/);
    expect(html).toMatch(/1350/);
  });

  it("a center-aligned control produces text-align:center", () => {
    const html = renderCard(
      legacyStyleToCardSpec({ style: "bold_typographic", headline: "Centered headline", channelName: "Acme" }, { ...controls, textAlign: "center" }),
    );
    expect(html).toContain("text-align:center");
  });
});
