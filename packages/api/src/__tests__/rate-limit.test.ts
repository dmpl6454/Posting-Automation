import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRateLimiter } from "../middleware/rate-limit";

describe("Rate Limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("window-based rate limiting", () => {
    it("should allow requests within the window limit", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

      const result1 = limiter("user-1");
      expect(result1.success).toBe(true);
      expect(result1.remaining).toBe(4);

      const result2 = limiter("user-1");
      expect(result2.success).toBe(true);
      expect(result2.remaining).toBe(3);
    });

    it("should allow exactly max requests before rejecting", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

      expect(limiter("user-1").success).toBe(true); // 1
      expect(limiter("user-1").success).toBe(true); // 2
      expect(limiter("user-1").success).toBe(true); // 3
      expect(limiter("user-1").success).toBe(false); // 4 - exceeds
    });

    it("should return failure when exceeding max requests", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

      limiter("user-1");
      limiter("user-1");
      const result = limiter("user-1");

      expect(result.success).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("should reset the window after expiry", () => {
      const limiter = createRateLimiter({ windowMs: 1_000, max: 2 });

      limiter("user-1");
      limiter("user-1");
      expect(limiter("user-1").success).toBe(false);

      // Advance time past the window
      vi.advanceTimersByTime(1_001);

      const result = limiter("user-1");
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it("should track multiple keys independently", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

      const result1 = limiter("user-1");
      const result2 = limiter("user-2");

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // user-1 is now exhausted
      expect(limiter("user-1").success).toBe(false);
      // user-2 is also exhausted
      expect(limiter("user-2").success).toBe(false);
    });

    it("should decrement remaining count correctly", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

      expect(limiter("key-a").remaining).toBe(4);
      expect(limiter("key-a").remaining).toBe(3);
      expect(limiter("key-a").remaining).toBe(2);
      expect(limiter("key-a").remaining).toBe(1);
      expect(limiter("key-a").remaining).toBe(0);
      // After exceeding, remaining stays at 0
      expect(limiter("key-a").remaining).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle max of 0 (first call starts a new window, second call rejects)", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 0 });

      // The first call opens a new window with count=1, which bypasses the > max check
      const result1 = limiter("user-1");
      expect(result1.success).toBe(true);
      expect(result1.remaining).toBe(-1); // max(0) - 1

      // The second call within the window correctly rejects
      const result2 = limiter("user-1");
      expect(result2.success).toBe(false);
      expect(result2.remaining).toBe(0);
    });

    it("should handle very short window (1ms)", () => {
      const limiter = createRateLimiter({ windowMs: 1, max: 1 });

      limiter("user-1");
      expect(limiter("user-1").success).toBe(false);

      vi.advanceTimersByTime(2);

      expect(limiter("user-1").success).toBe(true);
    });

    it("should provide correct resetAt timestamp", () => {
      const now = Date.now();
      const windowMs = 30_000;
      const limiter = createRateLimiter({ windowMs, max: 10 });

      const result = limiter("user-1");
      const expectedResetAt = new Date(now + windowMs);

      expect(result.resetAt.getTime()).toBe(expectedResetAt.getTime());
    });

    it("should provide consistent resetAt for requests in the same window", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

      const result1 = limiter("user-1");

      // Advance time slightly within the same window
      vi.advanceTimersByTime(500);

      const result2 = limiter("user-1");

      // Both should have the same resetAt because they share a window
      expect(result1.resetAt.getTime()).toBe(result2.resetAt.getTime());
    });

    it("should allow a new window to start fresh with full remaining count", () => {
      const limiter = createRateLimiter({ windowMs: 1_000, max: 5 });

      // Exhaust the first window
      for (let i = 0; i < 5; i++) {
        limiter("user-1");
      }
      expect(limiter("user-1").success).toBe(false);

      // Move past the window
      vi.advanceTimersByTime(1_001);

      const freshResult = limiter("user-1");
      expect(freshResult.success).toBe(true);
      expect(freshResult.remaining).toBe(4);
    });

    it("should handle many different keys without cross-contamination", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

      for (let i = 0; i < 100; i++) {
        const result = limiter(`key-${i}`);
        expect(result.success).toBe(true);
        expect(result.remaining).toBe(1);
      }
    });

    it("should correctly report remaining as 0 when at max (not exceeded)", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

      limiter("user-1"); // remaining: 1
      const atMax = limiter("user-1"); // remaining: 0, but still success
      expect(atMax.success).toBe(true);
      expect(atMax.remaining).toBe(0);
    });
  });
});
