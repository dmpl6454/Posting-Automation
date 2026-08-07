import { describe, it, expect } from "vitest";
import { groupChannelsIntoAccounts, type SyncChannelRow } from "../lib/sync-accounts";
import { EXTERNAL_POST_FLOOR, EXTERNAL_POST_FLOOR_LABEL } from "../lib/external-post-floor";

/**
 * API-side account grouping, used by "Sync Now" so a manual sync costs ONE Graph call per
 * ACCOUNT rather than one per channel row (975 FB rows → 409 accounts on prod).
 *
 * Deliberately mirrors apps/worker/src/lib/external-sync-accounts.ts — see the header
 * there and in sync-accounts.ts for why the duplicate exists (worker Dockerfile quirk #10).
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");

function row(over: Partial<SyncChannelRow> & { id: string; platformId: string }): SyncChannelRow {
  return { platform: "FACEBOOK", metadata: null, updatedAt: NOW, ...over };
}

const health = (status: string) => ({ insightsHealth: { status } });
const cliff = (iso: string) => ({ dataAccessExpiresAt: iso });

describe("groupChannelsIntoAccounts", () => {
  it("collapses many org rows for the SAME account into ONE sync unit", () => {
    const groups = groupChannelsIntoAccounts(
      [
        row({ id: "a", platformId: "P1" }),
        row({ id: "b", platformId: "P1" }),
        row({ id: "c", platformId: "P1" }),
        row({ id: "d", platformId: "P2" }),
      ],
      NOW
    );

    expect(groups).toHaveLength(2); // 4 rows -> 2 Graph calls
    const p1 = groups.find((g) => g.platformId === "P1")!;
    // Every row is a fan-out target so each org sees the fetched posts.
    expect(p1.targetChannelIds).toHaveLength(3);
  });

  it("keeps the same platformId on DIFFERENT platforms separate", () => {
    const groups = groupChannelsIntoAccounts(
      [
        row({ id: "a", platformId: "X", platform: "FACEBOOK" }),
        row({ id: "b", platformId: "X", platform: "INSTAGRAM" }),
      ],
      NOW
    );
    expect(groups).toHaveLength(2);
  });

  it("ranks a known-broken channel LAST", () => {
    const [g] = groupChannelsIntoAccounts(
      [
        row({ id: "broken", platformId: "P", metadata: health("needs_reconnect") }),
        row({ id: "fine", platformId: "P", metadata: health("ok") }),
      ],
      NOW
    );
    expect(g!.candidateChannelIds[0]).toBe("fine");
  });

  it("prefers a live data-access window over a lapsed one", () => {
    const [g] = groupChannelsIntoAccounts(
      [
        row({ id: "lapsed", platformId: "P", metadata: cliff("2026-07-01T00:00:00Z") }),
        row({ id: "live", platformId: "P", metadata: cliff("2026-10-21T00:00:00Z") }),
      ],
      NOW
    );
    expect(g!.candidateChannelIds[0]).toBe("live");
  });

  it("falls back to the freshest connection", () => {
    const [g] = groupChannelsIntoAccounts(
      [
        row({ id: "old", platformId: "P", updatedAt: new Date("2026-01-01T00:00:00Z") }),
        row({ id: "new", platformId: "P", updatedAt: new Date("2026-08-01T00:00:00Z") }),
      ],
      NOW
    );
    expect(g!.candidateChannelIds[0]).toBe("new");
  });

  it("skips rows with an empty platformId", () => {
    expect(groupChannelsIntoAccounts([row({ id: "a", platformId: "" })], NOW)).toHaveLength(0);
  });

  it("targetChannelIds contains EVERY row, even ones ranked last", () => {
    const [g] = groupChannelsIntoAccounts(
      [
        row({ id: "broken", platformId: "P", metadata: health("needs_reconnect") }),
        row({ id: "fine", platformId: "P" }),
      ],
      NOW
    );
    // A broken token can't LIST, but its org must still receive the fetched posts.
    expect(g!.targetChannelIds.sort()).toEqual(["broken", "fine"]);
  });
});

describe("external post floor", () => {
  it("is a single shared constant so cron / Sync Now / UI copy cannot drift", () => {
    expect(EXTERNAL_POST_FLOOR.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(EXTERNAL_POST_FLOOR_LABEL).toBe("1 Aug 2026");
  });
});
