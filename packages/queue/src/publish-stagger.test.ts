import { describe, it, expect } from "vitest";
import { computePublishDelays, PLATFORM_STAGGER_MS, DEFAULT_STAGGER_MS } from "./publish-stagger";

describe("computePublishDelays", () => {
  it("gives the first target of EVERY platform delay 0 (all platforms start together)", () => {
    const delays = computePublishDelays([
      { platform: "FACEBOOK" },
      { platform: "TWITTER" },
      { platform: "TELEGRAM" },
      { platform: "YOUTUBE" },
    ]);
    expect(delays).toEqual([0, 0, 0, 0]);
  });

  it("staggers only within the same platform group", () => {
    const delays = computePublishDelays([
      { platform: "FACEBOOK" }, // fb #0
      { platform: "TELEGRAM" }, // tg #0
      { platform: "FACEBOOK" }, // fb #1 → 10s
      { platform: "TELEGRAM" }, // tg #1 → 2s
      { platform: "FACEBOOK" }, // fb #2 → 20s
    ]);
    expect(delays).toEqual([0, 0, 10_000, 2_000, 20_000]);
  });

  it("a 60-channel post spread across platforms no longer tails out ~10 minutes", () => {
    // 60 channels over 6 platforms (10 each) — worst per-platform tail is
    // 9 * stagger. Old behavior was a global 59 * 10s = 590s tail.
    const platforms = ["FACEBOOK", "INSTAGRAM", "TWITTER", "LINKEDIN", "TELEGRAM", "DISCORD"];
    const targets = Array.from({ length: 60 }, (_, i) => ({ platform: platforms[i % 6]! }));
    const delays = computePublishDelays(targets);
    expect(Math.max(...delays)).toBe(9 * 10_000); // 90s, was 590s
  });

  it("keeps the full 10s spacing for same-platform bursts (Meta/X shared-app quota)", () => {
    const targets = Array.from({ length: 5 }, () => ({ platform: "FACEBOOK" }));
    expect(computePublishDelays(targets)).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
  });

  it("falls back to the default stagger for unknown platforms", () => {
    const delays = computePublishDelays([
      { platform: "SOME_FUTURE_PLATFORM" },
      { platform: "SOME_FUTURE_PLATFORM" },
    ]);
    expect(delays).toEqual([0, DEFAULT_STAGGER_MS]);
  });

  it("returns an empty array for no targets", () => {
    expect(computePublishDelays([])).toEqual([]);
  });

  it("locks the strict tier for platforms with shared-app quotas", () => {
    for (const p of ["FACEBOOK", "INSTAGRAM", "THREADS", "TWITTER"]) {
      expect(PLATFORM_STAGGER_MS[p]).toBe(10_000);
    }
  });
});
