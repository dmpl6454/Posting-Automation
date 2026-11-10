import { describe, it, expect } from "vitest";
import {
  rateLimitWaitMessage,
  rateLimitWaitMinutes,
  isOrphanedRateLimitWait,
  rateLimitRetryLostMessage,
  RATE_LIMIT_ORPHAN_GRACE_MS,
} from "./publish-recovery";

const NOW = new Date("2026-11-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("lost rate-limit retries", () => {
  it("round-trips the wait marker the worker writes", () => {
    expect(rateLimitWaitMessage(30 * 60_000)).toBe("Rate-limited, retrying in 30min");
    expect(rateLimitWaitMinutes(rateLimitWaitMessage(2 * 60 * 60_000))).toBe(120);
    expect(rateLimitWaitMinutes("Some other error")).toBeNull();
    expect(rateLimitWaitMinutes(null)).toBeNull();
  });

  it("is lost only after the promised retry time plus grace, with no job queued", () => {
    const t = { status: "SCHEDULED", errorMessage: rateLimitWaitMessage(30 * 60_000), updatedAt: ago(30 * 60_000 + RATE_LIMIT_ORPHAN_GRACE_MS + 1) };
    expect(isOrphanedRateLimitWait(t, NOW, new Set(), "t1")).toBe(true);
  });

  it("is NOT lost while the retry is still due or still queued", () => {
    const due = { status: "SCHEDULED", errorMessage: rateLimitWaitMessage(6 * 60 * 60_000), updatedAt: ago(60 * 60_000) };
    expect(isOrphanedRateLimitWait(due, NOW, new Set(), "t1")).toBe(false);
    const late = { status: "SCHEDULED", errorMessage: rateLimitWaitMessage(2 * 60_000), updatedAt: ago(24 * 60 * 60_000) };
    expect(isOrphanedRateLimitWait(late, NOW, new Set(["t1"]), "t1")).toBe(false);
  });

  it("ignores targets that are not rate-limit waits", () => {
    const old = ago(24 * 60 * 60_000);
    expect(isOrphanedRateLimitWait({ status: "SCHEDULED", errorMessage: null, updatedAt: old }, NOW, new Set(), "t")).toBe(false);
    expect(isOrphanedRateLimitWait({ status: "SCHEDULED", errorMessage: "Waiting for a large-upload slot", updatedAt: old }, NOW, new Set(), "t")).toBe(false);
    expect(isOrphanedRateLimitWait({ status: "FAILED", errorMessage: rateLimitWaitMessage(60_000), updatedAt: old }, NOW, new Set(), "t")).toBe(false);
  });

  it("tells the user it was not published and to Retry", () => {
    expect(rateLimitRetryLostMessage("FACEBOOK")).toBe(
      "Facebook rate-limited this post and its automatic retry was lost, so it was not published. Use Retry on the post page."
    );
    expect(rateLimitRetryLostMessage(null)).toMatch(/^The platform/);
  });
});
