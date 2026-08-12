import { describe, it, expect, vi } from "vitest";
import {
  ORPHANED_GRANT_REASON,
  buildOrphanedGrantHealth,
  markChannelsMissingFromGrant,
  mergeOrphanedGrantHealth,
  selectOrphanedChannels,
} from "../lib/orphaned-grant";

/**
 * The perpetual "N channels need reconnecting" banner.
 *
 * Root-caused live on prod 2026-08-12 (org "Tabish's Workspace"): decrypting the
 * stored `userAccessToken` per channel showed exactly TWO consents —
 *
 *   consent A  issued 2026-08-11 12:37  →  72 channels, all `ok`
 *   consent B  issued 2026-08-06 07:14  →   1 channel  ("Crime Alert"), needs_reconnect
 *
 * The owner DID reconnect on 08-11 and it healed 72 channels. The one page left
 * out of that grant was never visited by the callback's upsert loop, so it kept
 * a verdict written on 08-10 that read "The platform rejected the stored access
 * token. Reconnect this channel." — advice that could never work, because the
 * reconnect provably never touches that row.
 *
 * These tests lock the two properties that make the correction safe:
 *   1. it reaches the orphan, and
 *   2. it CANNOT touch a healthy channel belonging to a different login.
 */
const NOW = new Date("2026-08-12T10:00:00.000Z");

const needsReconnect = (reason = "token_invalid") => ({
  insightsHealth: {
    status: "needs_reconnect",
    reason,
    detail: "The platform rejected the stored access token. Reconnect this channel.",
    checkedAt: "2026-08-10T13:09:16.623Z",
  },
});

describe("selectOrphanedChannels", () => {
  it("selects a failing channel the consent left out — the reported bug", () => {
    const orphans = selectOrphanedChannels(
      [
        { id: "crime", platformId: "111686482859464", metadata: needsReconnect() },
        { id: "ok1", platformId: "1200847766436751", metadata: { insightsHealth: { status: "ok" } } },
      ],
      ["1200847766436751"]
    );
    expect(orphans.map((o) => o.id)).toEqual(["crime"]);
  });

  it("NEVER touches a healthy channel that was simply not part of this consent", () => {
    // A workspace may hold two platform logins granting different page sets.
    // Reconnecting login B must not slander login A's working channels.
    const orphans = selectOrphanedChannels(
      [
        { id: "loginA-healthy", platformId: "A1", metadata: { insightsHealth: { status: "ok" } } },
        { id: "loginA-nover", platformId: "A2", metadata: { igUserId: "x" } },
        { id: "loginA-expiring", platformId: "A3", metadata: { dataAccessExpiresAt: "2026-11-04T00:00:00.000Z" } },
      ],
      ["B1"]
    );
    expect(orphans).toEqual([]);
  });

  it("is idempotent — a second reconnect does not rewrite an identical verdict", () => {
    const already = selectOrphanedChannels(
      [{ id: "c", platformId: "P", metadata: needsReconnect(ORPHANED_GRANT_REASON) }],
      ["OTHER"]
    );
    expect(already).toEqual([]);
  });

  it("fails CLOSED on an empty grant instead of condemning the whole workspace", () => {
    // An empty page list is evidence something went wrong upstream, not evidence
    // that every channel was revoked.
    expect(
      selectOrphanedChannels([{ id: "c", platformId: "P", metadata: needsReconnect() }], [])
    ).toEqual([]);
  });

  it("also corrects a channel already flagged page_access_lost by the sync worker", () => {
    const orphans = selectOrphanedChannels(
      [{ id: "c", platformId: "P", metadata: needsReconnect("page_access_lost") }],
      ["OTHER"]
    );
    expect(orphans.map((o) => o.id)).toEqual(["c"]);
  });
});

describe("buildOrphanedGrantHealth", () => {
  const v = buildOrphanedGrantHealth("Facebook", NOW);

  it("stays actionable — the channel really cannot report Insights", () => {
    expect(v.status).toBe("needs_reconnect");
    expect(v.reason).toBe(ORPHANED_GRANT_REASON);
    expect(v.checkedAt).toBe(NOW.toISOString());
  });

  it("stops asserting the credential was rejected", () => {
    expect(v.detail).not.toMatch(/rejected the stored access token/i);
  });

  it("names the step that was actually missing, and an escape hatch", () => {
    expect(v.detail).toMatch(/Edit settings/);
    expect(v.detail).toMatch(/tick it/i);
    expect(v.detail).toMatch(/pause or disconnect/i);
  });

  it("keeps `reason` short enough for readInsightsHealth to preserve it", () => {
    // readInsightsHealth drops a reason longer than 40 chars, which would erase
    // the distinction this whole change exists to make.
    expect(v.reason.length).toBeLessThanOrEqual(40);
  });
});

describe("mergeOrphanedGrantHealth", () => {
  it("preserves sibling metadata keys", () => {
    // Losing igUserId / pageId breaks posting; losing dataAccessExpiresAt breaks
    // the 90-day cliff warning.
    const merged = mergeOrphanedGrantHealth(
      {
        pageId: "111686482859464",
        igUserId: "ig-1",
        userAccessToken: "enc:v1:…",
        dataAccessExpiresAt: "2026-11-04T07:14:28.000Z",
        insightsHealth: { status: "needs_reconnect", reason: "token_invalid" },
      },
      buildOrphanedGrantHealth("Facebook", NOW)
    );
    expect(merged.pageId).toBe("111686482859464");
    expect(merged.igUserId).toBe("ig-1");
    expect(merged.userAccessToken).toBe("enc:v1:…");
    expect(merged.dataAccessExpiresAt).toBe("2026-11-04T07:14:28.000Z");
    expect((merged.insightsHealth as any).reason).toBe(ORPHANED_GRANT_REASON);
  });

  it("tolerates absent or malformed metadata", () => {
    for (const bad of [null, undefined, "str", 42, []]) {
      const merged = mergeOrphanedGrantHealth(bad, buildOrphanedGrantHealth("Facebook", NOW));
      expect((merged.insightsHealth as any).status).toBe("needs_reconnect");
    }
  });
});

describe("markChannelsMissingFromGrant", () => {
  const makePrisma = (rows: any[]) => {
    const update = vi.fn().mockResolvedValue({});
    return {
      update,
      findMany: vi.fn().mockResolvedValue(rows),
      client: { channel: { findMany: vi.fn().mockResolvedValue(rows), update } },
    };
  };

  it("writes the corrected verdict only for the orphan", async () => {
    const p = makePrisma([
      { id: "crime", platformId: "111686482859464", metadata: needsReconnect() },
      { id: "healthy", platformId: "999", metadata: { insightsHealth: { status: "ok" } } },
    ]);
    const n = await markChannelsMissingFromGrant(
      p.client as never,
      "org-1",
      "FACEBOOK",
      ["1200847766436751"],
      "Facebook",
      NOW
    );
    expect(n).toBe(1);
    expect(p.update).toHaveBeenCalledTimes(1);
    const call = p.update.mock.calls[0]![0] as any;
    expect(call.where).toEqual({ id: "crime" });
    expect(call.data.metadata.insightsHealth.reason).toBe(ORPHANED_GRANT_REASON);
  });

  it("scopes the query to the org, the platform, and live channels only", async () => {
    const p = makePrisma([]);
    await markChannelsMissingFromGrant(p.client as never, "org-1", "FACEBOOK", ["A"], "Facebook", NOW);
    const where = (p.client.channel.findMany.mock.calls[0]![0] as any).where;
    expect(where.organizationId).toBe("org-1");
    expect(where.platform).toBe("FACEBOOK");
    expect(where.isActive).toBe(true);
    expect(where.disconnectedAt).toBeNull();
    expect(where.platformId).toEqual({ notIn: ["A"] });
  });

  it("does nothing at all when the grant is empty", async () => {
    const p = makePrisma([{ id: "c", platformId: "P", metadata: needsReconnect() }]);
    expect(
      await markChannelsMissingFromGrant(p.client as never, "org-1", "FACEBOOK", [], "Facebook", NOW)
    ).toBe(0);
    expect(p.client.channel.findMany).not.toHaveBeenCalled();
    expect(p.update).not.toHaveBeenCalled();
  });
});
