import { describe, it, expect } from "vitest";
import { effectiveChannelUnavailable } from "../lib/platform-metrics";
import { readInsightsHealth, summarizeInsightsHealth, needsReconnect } from "../lib/insights-health";

/**
 * Locks the channel-level capability override used by the AGGREGATE read paths
 * (perChannelStats → Channel Performance, groupStats → Group Performance).
 *
 * Why this exists: the static platform map is a platform-wide constant, but
 * Facebook's capability varies PER POST — a FEED post genuinely has no
 * impressions (Meta deleted the metric) while a VIDEO post returns real views
 * through video_insights. gatePostReportRow was taught to prefer the per-capture
 * metadata in 2026-07-27, but the aggregates still consulted the static map only,
 * so the SAME data showed as a number in Reports and as "—" in Channel
 * Performance on the same page.
 */
describe("effectiveChannelUnavailable", () => {
  it("hides FB impressions/reach when no capture reported them", () => {
    const unavail = effectiveChannelUnavailable("FACEBOOK", { impressions: false, reach: false }, false);
    expect(unavail).toContain("impressions");
    expect(unavail).toContain("reach");
  });

  it("REVEALS FB impressions when a capture reported them (the video-views case)", () => {
    // The PR #148 regression, in the aggregates. A Facebook channel that posted a
    // video has real view counts; the static map alone would hide them as "—".
    const unavail = effectiveChannelUnavailable("FACEBOOK", { impressions: true, reach: false }, false);
    expect(unavail).not.toContain("impressions");
    expect(unavail).toContain("reach");
  });

  it("falls back to the static map for legacy captures with no metadata", () => {
    // Pre-2026-07 snapshots make no capability claim, so the platform-wide
    // default must still apply — byte-identical to pre-override behavior.
    const unavail = effectiveChannelUnavailable("FACEBOOK", undefined, true);
    expect(unavail).toEqual(expect.arrayContaining(["impressions", "reach"]));
  });

  it("prefers a real capture over a legacy snapshot when both exist", () => {
    // A channel with one legacy row and one modern row that DID report views:
    // the real data must win, otherwise adding history hides current metrics.
    const unavail = effectiveChannelUnavailable("FACEBOOK", { impressions: true }, true);
    expect(unavail).not.toContain("impressions");
  });

  it("keeps IG clicks unavailable — Instagram has no click metric at all", () => {
    expect(effectiveChannelUnavailable("INSTAGRAM", { impressions: true, reach: true }, false)).toContain("clicks");
  });

  it("marks every metric unavailable for platforms with no analytics API", () => {
    const unavail = effectiveChannelUnavailable("TELEGRAM", undefined, true);
    expect(unavail).toEqual(
      expect.arrayContaining(["impressions", "reach", "likes", "comments", "shares", "clicks"])
    );
  });

  it("treats aliased reach as unavailable via the static fallback", () => {
    // YOUTUBE reachIsDistinct=false ⇒ reach is just impressions re-labeled, so it
    // must not render as a duplicate column.
    expect(effectiveChannelUnavailable("YOUTUBE", undefined, true)).toContain("reach");
  });
});

describe("readInsightsHealth", () => {
  it("reads a needs_reconnect verdict written by the sync worker", () => {
    const h = readInsightsHealth({
      igUserId: "123",
      insightsHealth: {
        status: "needs_reconnect",
        reason: "missing_scope",
        missingScopes: ["read_insights"],
        detail: "Reconnect to grant: read_insights.",
        checkedAt: "2026-08-06T00:00:00.000Z",
      },
    });
    expect(h?.status).toBe("needs_reconnect");
    expect(h?.missingScopes).toEqual(["read_insights"]);
  });

  it("returns null for channels with no verdict, or unparseable metadata", () => {
    expect(readInsightsHealth(null)).toBeNull();
    expect(readInsightsHealth({})).toBeNull();
    expect(readInsightsHealth({ igUserId: "1" })).toBeNull();
    expect(readInsightsHealth("not-an-object")).toBeNull();
    expect(readInsightsHealth([1, 2, 3])).toBeNull();
    expect(readInsightsHealth({ insightsHealth: "garbled" })).toBeNull();
  });

  it("ignores an unknown status so a garbled value can't render a scary banner", () => {
    expect(readInsightsHealth({ insightsHealth: { status: "EXPLODED" } })).toBeNull();
  });

  it("filters implausible scope names out of untrusted metadata", () => {
    const h = readInsightsHealth({
      insightsHealth: { status: "needs_reconnect", missingScopes: ["read_insights", "<script>", 42] },
    });
    expect(h?.missingScopes).toEqual(["read_insights"]);
  });

  it("caps an overlong detail string", () => {
    const h = readInsightsHealth({
      insightsHealth: { status: "needs_reconnect", detail: "x".repeat(5000) },
    });
    expect(h?.detail!.length).toBeLessThanOrEqual(200);
  });
});

describe("summarizeInsightsHealth", () => {
  const ch = (id: string, metadata: unknown) => ({ id, name: `ch-${id}`, platform: "FACEBOOK", metadata });

  it("counts only channels explicitly flagged, never inferring from zero metrics", () => {
    // A channel with genuinely zero engagement must NEVER be reported as broken.
    const s = summarizeInsightsHealth([
      ch("a", { insightsHealth: { status: "needs_reconnect", missingScopes: ["read_insights"] } }),
      ch("b", { insightsHealth: { status: "ok" } }),
      ch("c", null),
      ch("d", { insightsHealth: { status: "needs_reconnect", missingScopes: ["pages_read_user_content"] } }),
    ]);
    expect(s.needsReconnectCount).toBe(2);
    expect(s.channels.map((c) => c.id)).toEqual(["a", "d"]);
    expect(s.missingScopes).toEqual(["pages_read_user_content", "read_insights"]);
  });

  it("returns an empty summary when every channel is healthy", () => {
    const s = summarizeInsightsHealth([ch("a", { insightsHealth: { status: "ok" } })]);
    expect(s.needsReconnectCount).toBe(0);
    expect(s.missingScopes).toEqual([]);
  });
});

describe("needsReconnect", () => {
  it("is true only for an explicit needs_reconnect verdict", () => {
    expect(needsReconnect({ insightsHealth: { status: "needs_reconnect" } })).toBe(true);
    expect(needsReconnect({ insightsHealth: { status: "ok" } })).toBe(false);
    expect(needsReconnect(null)).toBe(false);
  });
});
