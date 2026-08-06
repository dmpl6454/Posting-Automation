import { describe, it, expect } from "vitest";
import {
  deriveInsightsHealth,
  mergeInsightsHealth,
  shouldApplyHealthVerdict,
  RECONNECT_VERDICT_TTL_MS,
  type ChannelInsightsHealth,
} from "../lib/channel-insights-health";

/**
 * VERDICT FLAPPING — measured on prod 2026-08-06.
 *
 * Facebook's getPostAnalytics takes two paths: a FEED post hits the fields edge
 * and reports `missing_scope` without `pages_read_user_content`; a VIDEO post
 * routes to getVideoAnalytics, which never touches that scope and reports NO
 * degradation. Both wrote the channel verdict, so on a channel with both post
 * types they overwrote each other and the stored verdict was decided by
 * whichever post synced last:
 *
 *   Bollywood             17 captures (6 degraded, 11 clean) · last clean → "ok"            ✗
 *   Contents of bollywood 25 captures (4 degraded, 21 clean) · last clean → "ok"            ✗
 *   Asthetic               2 captures (2 degraded,  0 clean) · last bad   → needs_reconnect ✓
 *
 * The first two are the most-used FB channels in the deployment — users saw "—"
 * for comments with no banner and no way to learn a reconnect would fix it.
 */

const T0 = new Date("2026-08-06T12:00:00.000Z");
const bad = (checkedAt: string): ChannelInsightsHealth => ({
  status: "needs_reconnect",
  reason: "missing_scope",
  missingScopes: ["pages_read_user_content"],
  checkedAt,
});
const ok = (checkedAt: string): ChannelInsightsHealth => ({ status: "ok", checkedAt });

describe("insights health — verdict flapping", () => {
  it("a clean VIDEO capture does NOT clear a fresh missing_scope verdict (the prod bug)", () => {
    const stored = { insightsHealth: bad(T0.toISOString()) };
    // A video post syncs 5 minutes later and reports no degradation.
    const later = new Date(T0.getTime() + 5 * 60_000);
    const merged = mergeInsightsHealth(stored, deriveInsightsHealth(undefined, later), later);

    expect(merged).toBeNull(); // verdict stands — banner keeps showing
  });

  it("a NEW actionable verdict always writes immediately (fast to warn)", () => {
    const stored = { insightsHealth: ok(T0.toISOString()) };
    const later = new Date(T0.getTime() + 60_000);
    const merged = mergeInsightsHealth(
      stored,
      deriveInsightsHealth({ reason: "missing_scope", missingScopes: ["read_insights"] }, later),
      later
    );

    expect((merged as any)?.insightsHealth.status).toBe("needs_reconnect");
  });

  it("a clean capture DOES clear the verdict once it is older than the TTL (real reconnect)", () => {
    const stored = { insightsHealth: bad(T0.toISOString()) };
    const later = new Date(T0.getTime() + RECONNECT_VERDICT_TTL_MS + 1000);
    const merged = mergeInsightsHealth(stored, deriveInsightsHealth(undefined, later), later);

    expect((merged as any)?.insightsHealth.status).toBe("ok");
  });

  it("token_invalid is protected the same way as missing_scope", () => {
    const stored = {
      insightsHealth: { status: "needs_reconnect", reason: "token_invalid", checkedAt: T0.toISOString() },
    };
    const later = new Date(T0.getTime() + 60_000);
    expect(mergeInsightsHealth(stored, deriveInsightsHealth(undefined, later), later)).toBeNull();
  });

  it("an unparseable checkedAt is treated as stale (a garbled value can't pin a channel broken)", () => {
    const stored = { insightsHealth: { status: "needs_reconnect", reason: "missing_scope", checkedAt: "not-a-date" } };
    const merged = mergeInsightsHealth(stored, deriveInsightsHealth(undefined, T0), T0);
    expect((merged as any)?.insightsHealth.status).toBe("ok");
  });

  it("preserves sibling metadata keys when writing (igUserId/orgId/instance)", () => {
    const stored = { igUserId: "1784", orgId: "urn:li:org:9", insightsHealth: ok(T0.toISOString()) };
    const later = new Date(T0.getTime() + 60_000);
    const merged = mergeInsightsHealth(
      stored,
      deriveInsightsHealth({ reason: "token_invalid" }, later),
      later
    ) as any;

    expect(merged.igUserId).toBe("1784");
    expect(merged.orgId).toBe("urn:li:org:9");
  });

  it("replays the prod sequence: 6 degraded + 11 clean captures ⇒ still flagged", () => {
    // Bollywood's 2026-08-06 day, interleaved as the worker would see it.
    const sequence = [
      "bad", "clean", "clean", "bad", "clean", "clean", "bad", "clean", "bad",
      "clean", "clean", "bad", "clean", "clean", "bad", "clean", "clean",
    ] as const;

    let metadata: Record<string, unknown> = {};
    sequence.forEach((kind, i) => {
      const at = new Date(T0.getTime() + i * 60_000); // all within the TTL
      const health = deriveInsightsHealth(
        kind === "bad" ? { reason: "missing_scope", missingScopes: ["pages_read_user_content"] } : undefined,
        at
      );
      const merged = mergeInsightsHealth(metadata, health, at);
      if (merged) metadata = merged;
    });

    // The LAST capture was clean — pre-fix this ended as "ok" (the prod bug).
    expect((metadata.insightsHealth as any).status).toBe("needs_reconnect");
    expect((metadata.insightsHealth as any).missingScopes).toContain("pages_read_user_content");
  });

  it("shouldApplyHealthVerdict still suppresses a no-op rewrite", () => {
    const stored = ok(T0.toISOString());
    const later = new Date(T0.getTime() + 60_000);
    expect(shouldApplyHealthVerdict(stored, ok(later.toISOString()), later)).toBe(false);
  });
});
