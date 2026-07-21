/**
 * Heavy-upload lane gate (scenario batch 2026-07-20): streamed platforms
 * (YouTube/X/LinkedIn) with media above the threshold are capped at
 * HEAVY_MEDIA_CONCURRENCY concurrent publishes; excess DEFERS via the
 * rate-limit re-queue pattern (never blocks in-process). These tests lock the
 * pure decision helpers the worker gate is built from.
 */
import { describe, it, expect } from "vitest";
import { isHeavyPublish, planHeavyDefer, HEAVY_SLOT_WAIT_MESSAGE } from "../../lib/publish-recovery";

const HEAVY = new Set(["YOUTUBE", "TWITTER", "LINKEDIN"]);
const THRESHOLD = 300 * 1024 * 1024;

describe("isHeavyPublish", () => {
  it("true only for streamed platforms above the threshold", () => {
    expect(isHeavyPublish("YOUTUBE", THRESHOLD + 1, THRESHOLD, HEAVY)).toBe(true);
    expect(isHeavyPublish("TWITTER", THRESHOLD + 1, THRESHOLD, HEAVY)).toBe(true);
    expect(isHeavyPublish("LINKEDIN", THRESHOLD + 1, THRESHOLD, HEAVY)).toBe(true);
  });

  it("false at or below the threshold (boundary exact)", () => {
    expect(isHeavyPublish("YOUTUBE", THRESHOLD, THRESHOLD, HEAVY)).toBe(false);
    expect(isHeavyPublish("YOUTUBE", 0, THRESHOLD, HEAVY)).toBe(false);
  });

  it("false for URL-pull platforms regardless of size — IG/FB must never defer", () => {
    expect(isHeavyPublish("INSTAGRAM", 4 * 1024 ** 3, THRESHOLD, HEAVY)).toBe(false);
    expect(isHeavyPublish("FACEBOOK", 4 * 1024 ** 3, THRESHOLD, HEAVY)).toBe(false);
    expect(isHeavyPublish("TIKTOK", 4 * 1024 ** 3, THRESHOLD, HEAVY)).toBe(false);
  });
});

describe("planHeavyDefer", () => {
  it("proceeds (null) when not heavy, whatever the slot state", () => {
    expect(planHeavyDefer({ isHeavy: false, active: 99, cap: 3 })).toBeNull();
  });

  it("proceeds (null) while below capacity", () => {
    expect(planHeavyDefer({ isHeavy: true, active: 2, cap: 3 })).toBeNull();
  });

  it("defers at capacity with a jittered 45-90s delay", () => {
    const atMin = planHeavyDefer({ isHeavy: true, active: 3, cap: 3, rand: () => 0 });
    const atMax = planHeavyDefer({ isHeavy: true, active: 3, cap: 3, rand: () => 0.999999 });
    expect(atMin?.delayMs).toBe(45_000);
    expect(atMax?.delayMs).toBeGreaterThanOrEqual(45_000);
    expect(atMax?.delayMs).toBeLessThan(90_000);
  });

  it("defers when active exceeds capacity (counter drift safety)", () => {
    expect(planHeavyDefer({ isHeavy: true, active: 5, cap: 3, rand: () => 0.5 })).not.toBeNull();
  });
});

describe("HEAVY_SLOT_WAIT_MESSAGE", () => {
  it("is the exact marker the watchdog keep-alive matches on", () => {
    // The defer branch writes this to PostTarget.errorMessage and the watchdog
    // string-matches it — a copy change here must be deliberate at BOTH sites.
    expect(HEAVY_SLOT_WAIT_MESSAGE).toBe("Waiting for a large-upload slot");
  });
});
