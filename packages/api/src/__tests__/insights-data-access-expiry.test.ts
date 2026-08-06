import { describe, it, expect } from "vitest";
import {
  evaluateChannelInsightsStatus,
  summarizeChannelStatuses,
  DATA_ACCESS_WARN_DAYS,
} from "../lib/insights-health";
import { reportableMetrics } from "../lib/platform-metrics";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

/**
 * Locks the handling of Meta's 90-day DATA-ACCESS window — the clock that
 * actually kills Meta insights every ~3 months and which had zero monitoring.
 *
 * Live-verified 2026-08-06: freshly reconnected FB Page AND IG user tokens both
 * report `expires_at = never` with `data_access_expires_at = +90 days`. Because
 * `expires_at` really is never, `Channel.tokenExpiresAt` is correctly NULL — and
 * `scheduleTokenRefreshes` filters `tokenExpiresAt: { lte: soon }`, which NULL can
 * never satisfy, so that cron has never selected a single Meta channel
 * (1338 of 1339 measured unreachable).
 *
 * And critically: re-exchanging via `fb_exchange_token` returned a token whose
 * `data_access_expires_at` was IDENTICAL (delta 0 days) — so auto-refresh cannot
 * fix this. Warning ahead of the deadline is the only remedy, which is what
 * these statuses drive.
 */
describe("evaluateChannelInsightsStatus — data-access cliff", () => {
  it("is ok when data access is comfortably in the future", () => {
    const s = evaluateChannelInsightsStatus({ dataAccessExpiresAt: inDays(90) }, NOW);
    expect(s.status).toBe("ok");
    expect(s.daysUntilDataAccessExpiry).toBe(90);
  });

  it("warns inside the warning window", () => {
    const s = evaluateChannelInsightsStatus({ dataAccessExpiresAt: inDays(10) }, NOW);
    expect(s.status).toBe("expiring_soon");
    expect(s.reason).toBe("data_access_expiring");
    expect(s.detail).toContain("10 days");
    // Posting is unaffected — the copy must say so, or users panic about outages.
    expect(s.detail).toContain("Posting is unaffected");
  });

  it("treats a lapsed window as needing a reconnect NOW", () => {
    const s = evaluateChannelInsightsStatus({ dataAccessExpiresAt: inDays(-1) }, NOW);
    expect(s.status).toBe("needs_reconnect");
    expect(s.reason).toBe("data_access_expired");
  });

  it("uses the documented warning threshold, not an ad-hoc number", () => {
    expect(evaluateChannelInsightsStatus({ dataAccessExpiresAt: inDays(DATA_ACCESS_WARN_DAYS) }, NOW).status).toBe(
      "expiring_soon"
    );
    expect(
      evaluateChannelInsightsStatus({ dataAccessExpiresAt: inDays(DATA_ACCESS_WARN_DAYS + 1) }, NOW).status
    ).toBe("ok");
  });

  it("a live capability failure OUTRANKS a future deadline — it is broken now", () => {
    const s = evaluateChannelInsightsStatus(
      {
        dataAccessExpiresAt: inDays(80),
        insightsHealth: { status: "needs_reconnect", reason: "token_invalid" },
      },
      NOW
    );
    expect(s.status).toBe("needs_reconnect");
    expect(s.reason).toBe("token_invalid");
    // …but the deadline is still reported alongside it.
    expect(s.daysUntilDataAccessExpiry).toBe(80);
  });

  it("is ok, and silent, when no deadline was ever recorded", () => {
    // Channels connected before the deadline was captured must not be nagged
    // until the backfill cron fills it in.
    const s = evaluateChannelInsightsStatus({ igUserId: "1" }, NOW);
    expect(s.status).toBe("ok");
    expect(s.daysUntilDataAccessExpiry).toBeUndefined();
  });

  it("ignores a malformed deadline instead of throwing", () => {
    expect(evaluateChannelInsightsStatus({ dataAccessExpiresAt: "not-a-date" }, NOW).status).toBe("ok");
    expect(evaluateChannelInsightsStatus({ dataAccessExpiresAt: 12345 }, NOW).status).toBe("ok");
    expect(evaluateChannelInsightsStatus(null, NOW).status).toBe("ok");
  });
});

describe("summarizeChannelStatuses", () => {
  const ch = (id: string, metadata: unknown) => ({ id, name: id, platform: "INSTAGRAM", metadata });

  it("counts both failure modes separately", () => {
    const s = summarizeChannelStatuses(
      [
        ch("broken", { insightsHealth: { status: "needs_reconnect", reason: "token_invalid" } }),
        ch("expiring", { dataAccessExpiresAt: inDays(5) }),
        ch("healthy", { dataAccessExpiresAt: inDays(80) }),
        ch("unknown", null),
      ],
      NOW
    );
    expect(s.needsReconnectCount).toBe(1);
    expect(s.expiringSoonCount).toBe(1);
    expect(s.channels.map((c) => c.id)).toEqual(["broken", "expiring"]);
  });

  it("orders broken-now first, then soonest deadline — the order to act in", () => {
    const s = summarizeChannelStatuses(
      [
        ch("expiring-late", { dataAccessExpiresAt: inDays(12) }),
        ch("expiring-soon", { dataAccessExpiresAt: inDays(2) }),
        ch("broken", { insightsHealth: { status: "needs_reconnect" } }),
      ],
      NOW
    );
    expect(s.channels.map((c) => c.id)).toEqual(["broken", "expiring-soon", "expiring-late"]);
  });

  it("is empty when everything is healthy", () => {
    const s = summarizeChannelStatuses([ch("a", { dataAccessExpiresAt: inDays(89) })], NOW);
    expect(s.needsReconnectCount).toBe(0);
    expect(s.expiringSoonCount).toBe(0);
    expect(s.channels).toEqual([]);
  });
});

/**
 * Locks the column/tile suppression. A metric no connected platform can EVER
 * report is dead screen furniture: an all-"—" column reads as a broken product.
 */
describe("reportableMetrics", () => {
  it("drops impressions and reach for a Facebook-only org", () => {
    // Meta deleted both Page-post metrics — re-verified WITH read_insights
    // granted, so no permission or reconnect brings them back.
    const keys = reportableMetrics(["FACEBOOK"]);
    expect(keys).not.toContain("impressions");
    expect(keys).not.toContain("reach");
    expect(keys).toEqual(expect.arrayContaining(["likes", "comments", "shares", "clicks"]));
  });

  it("keeps impressions when a Facebook capture actually reported views (video posts)", () => {
    const keys = reportableMetrics(["FACEBOOK"], [{ impressions: true }]);
    expect(keys).toContain("impressions");
  });

  it("drops clicks for an Instagram-only org — Instagram has no click metric", () => {
    const keys = reportableMetrics(["INSTAGRAM"]);
    expect(keys).not.toContain("clicks");
    expect(keys).toEqual(expect.arrayContaining(["impressions", "reach", "likes", "comments", "shares"]));
  });

  it("unions capability across a mixed org", () => {
    // FB brings clicks, IG brings impressions/reach ⇒ every column earns its place.
    const keys = reportableMetrics(["FACEBOOK", "INSTAGRAM"]);
    expect(keys).toEqual(
      expect.arrayContaining(["impressions", "reach", "likes", "comments", "shares", "clicks"])
    );
  });

  it("returns nothing for a platform with no analytics API at all", () => {
    expect(reportableMetrics(["TELEGRAM"])).toEqual([]);
  });

  it("returns nothing for an empty channel list", () => {
    expect(reportableMetrics([])).toEqual([]);
  });
});
