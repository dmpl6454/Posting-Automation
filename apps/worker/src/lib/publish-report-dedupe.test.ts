/**
 * The publish-report email went out once per job that reached a final state,
 * with nothing remembering it had already been sent. Measured on prod
 * (post cmulhowhx0003n50i4htdhlsr, 2026-09-29): the earlier rate-limit loop
 * had left four jobs queued for one Facebook target; after the code:368 fix
 * each of them failed for good and each re-sent the SAME report — the creator
 * got it four times (02:13, 02:17, 02:42, 02:43 UTC).
 *
 * A report is now claimed once per (post, round, outcome) with an atomic
 * Redis SET NX before sending:
 *   - an identical repeat is skipped (the bug);
 *   - a CHANGED outcome (a channel that was reported failed later publishes)
 *     still sends a corrected report — same as before;
 *   - a new user-initiated round (Retry / reschedule changes Post.scheduledAt)
 *     still sends, even if the outcome happens to be identical.
 * It fails OPEN: a Redis error sends anyway, because a duplicate report is
 * cheap and a lost one is the incident this whole area exists to prevent.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishReportFingerprint, claimPublishReport, publishReportKey } from "./publish-report-dedupe";

const t = (id: string, status: string, publishedUrl: string | null = null, ambiguousAt: Date | null = null) => ({
  id,
  status,
  publishedUrl,
  ambiguousAt,
});

const ROUND = new Date("2026-09-28T16:56:25.000Z");

describe("publishReportFingerprint", () => {
  it("is identical for the same post, round and outcome", () => {
    const a = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "PUBLISHED", "https://x/1"), t("b", "FAILED")] });
    const b = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "PUBLISHED", "https://x/1"), t("b", "FAILED")] });
    expect(a).toBe(b);
  });

  it("does not depend on the order targets were returned in", () => {
    const a = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "PUBLISHED", "https://x/1"), t("b", "FAILED")] });
    const b = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("b", "FAILED"), t("a", "PUBLISHED", "https://x/1")] });
    expect(a).toBe(b);
  });

  it("changes when a channel's outcome changes (late success must still be reported)", () => {
    const before = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "PUBLISHED", "https://x/1"), t("b", "FAILED")] });
    const after = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "PUBLISHED", "https://x/1"), t("b", "PUBLISHED", "https://x/2")] });
    expect(after).not.toBe(before);
  });

  it("changes when a published link changes", () => {
    const a = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "PUBLISHED", "https://x/1")] });
    const b = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "PUBLISHED", "https://x/9")] });
    expect(a).not.toBe(b);
  });

  it("changes when a target becomes 'may already be live' (ambiguous)", () => {
    const a = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "FAILED")] });
    const b = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "FAILED", null, new Date())] });
    expect(a).not.toBe(b);
  });

  it("changes on a new round (Retry/reschedule moves scheduledAt) even if the outcome is identical", () => {
    const a = publishReportFingerprint({ postId: "p1", scheduledAt: ROUND, targets: [t("a", "FAILED")] });
    const b = publishReportFingerprint({ postId: "p1", scheduledAt: new Date(ROUND.getTime() + 60_000), targets: [t("a", "FAILED")] });
    expect(a).not.toBe(b);
  });

  it("handles a null scheduledAt (publish-now posts created without one)", () => {
    expect(() => publishReportFingerprint({ postId: "p1", scheduledAt: null, targets: [t("a", "PUBLISHED", "https://x/1")] })).not.toThrow();
  });
});

describe("publishReportKey", () => {
  it("is scoped to the post", () => {
    expect(publishReportKey("p1", "abc")).toBe("publish-report:p1:abc");
  });
});

describe("claimPublishReport", () => {
  it("claims with SET NX + a TTL and returns true the first time", async () => {
    const set = vi.fn(async (..._a: any[]) => "OK" as const);
    await expect(claimPublishReport({ set }, "p1", "abc")).resolves.toBe(true);
    const [key, value, ex, ttl, nx] = set.mock.calls[0]!;
    expect(key).toBe("publish-report:p1:abc");
    expect(value).toBe("1");
    expect(ex).toBe("EX");
    expect(ttl).toBeGreaterThan(0);
    expect(nx).toBe("NX");
  });

  it("returns false when the identical report was already claimed", async () => {
    const set = vi.fn(async (..._a: any[]) => null);
    await expect(claimPublishReport({ set }, "p1", "abc")).resolves.toBe(false);
  });

  it("fails OPEN — a Redis error still sends the report", async () => {
    const set = vi.fn(async (..._a: any[]) => {
      throw new Error("redis down");
    });
    await expect(claimPublishReport({ set }, "p1", "abc")).resolves.toBe(true);
  });
});

describe("the worker claims before it sends (source lock — the worker module opens Redis at load)", () => {
  const src = readFileSync(join(__dirname, "../workers/post-publish.worker.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function sendPublishReportEmail("), src.indexOf("// ── In-app notifications"));

  it("sendPublishReportEmail computes a fingerprint and claims it", () => {
    expect(fn).toMatch(/publishReportFingerprint\(/);
    expect(fn).toMatch(/claimPublishReport\(/);
  });

  it("the claim happens before any mail is sent", () => {
    expect(fn.indexOf("claimPublishReport(")).toBeGreaterThan(-1);
    expect(fn.indexOf("claimPublishReport(")).toBeLessThan(fn.indexOf("sendMail("));
  });

  it("the post read includes scheduledAt (the round marker)", () => {
    expect(fn).toMatch(/scheduledAt:\s*true/);
  });
});
