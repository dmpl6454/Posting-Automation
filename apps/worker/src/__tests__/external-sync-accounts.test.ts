import { describe, it, expect } from "vitest";
import {
  groupIntoAccounts,
  rankCandidates,
  selectShard,
  type ChannelRowLike,
} from "../lib/external-sync-accounts";

/**
 * Account-level collapsing is the optimization that makes this feature cheap:
 * measured on prod, 975 FB channel rows -> 409 distinct platformIds and 364 IG rows ->
 * 115. Syncing per ROW would roughly triple Graph traffic for identical data.
 */

const NOW = new Date("2026-08-06T12:00:00.000Z");

function row(over: Partial<ChannelRowLike> & { id: string; platformId: string }): ChannelRowLike {
  return {
    organizationId: "org1",
    platform: "FACEBOOK",
    accessToken: `tok-${over.id}`,
    metadata: null,
    updatedAt: NOW,
    ...over,
  };
}

const health = (status: string) => ({ insightsHealth: { status } });
const cliff = (iso: string) => ({ dataAccessExpiresAt: iso });

describe("groupIntoAccounts", () => {
  it("collapses many org rows for the SAME account into one sync unit", () => {
    const rows = [
      row({ id: "a", platformId: "P1", organizationId: "org1" }),
      row({ id: "b", platformId: "P1", organizationId: "org2" }),
      row({ id: "c", platformId: "P1", organizationId: "org3" }),
      row({ id: "d", platformId: "P2", organizationId: "org1" }),
    ];
    const accounts = groupIntoAccounts(rows, NOW);

    expect(accounts).toHaveLength(2); // 4 rows -> 2 Graph calls
    const p1 = accounts.find((a) => a.platformId === "P1")!;
    // ALL rows are fan-out targets, so every org sees the fetched posts.
    expect(p1.allRows).toHaveLength(3);
  });

  it("keeps the same platformId on DIFFERENT platforms separate", () => {
    const rows = [
      row({ id: "a", platformId: "X", platform: "FACEBOOK" }),
      row({ id: "b", platformId: "X", platform: "INSTAGRAM" }),
    ];
    expect(groupIntoAccounts(rows, NOW)).toHaveLength(2);
  });

  it("skips rows with an empty platformId", () => {
    expect(groupIntoAccounts([row({ id: "a", platformId: "" })], NOW)).toHaveLength(0);
  });
});

describe("rankCandidates", () => {
  it("puts a known-broken channel LAST (a recorded verdict is real evidence)", () => {
    const ranked = rankCandidates(
      [
        row({ id: "broken", platformId: "P", metadata: health("needs_reconnect") }),
        row({ id: "fine", platformId: "P", metadata: health("ok") }),
      ],
      NOW
    );
    expect(ranked[0]!.id).toBe("fine");
  });

  it("puts a channel whose data-access window has LAPSED after a live one", () => {
    const ranked = rankCandidates(
      [
        row({ id: "lapsed", platformId: "P", metadata: cliff("2026-07-01T00:00:00Z") }),
        row({ id: "live", platformId: "P", metadata: cliff("2026-10-21T00:00:00Z") }),
      ],
      NOW
    );
    expect(ranked[0]!.id).toBe("live");
  });

  it("prefers the LONGER remaining data-access runway", () => {
    const ranked = rankCandidates(
      [
        row({ id: "soon", platformId: "P", metadata: cliff("2026-08-20T00:00:00Z") }),
        row({ id: "later", platformId: "P", metadata: cliff("2026-11-04T00:00:00Z") }),
      ],
      NOW
    );
    expect(ranked[0]!.id).toBe("later");
  });

  it("prefers a KNOWN window over an unknown one", () => {
    const ranked = rankCandidates(
      [
        row({ id: "unknown", platformId: "P", metadata: null }),
        row({ id: "known", platformId: "P", metadata: cliff("2026-10-21T00:00:00Z") }),
      ],
      NOW
    );
    expect(ranked[0]!.id).toBe("known");
  });

  it("falls back to the freshest connection when nothing else separates them", () => {
    const ranked = rankCandidates(
      [
        row({ id: "old", platformId: "P", updatedAt: new Date("2026-01-01T00:00:00Z") }),
        row({ id: "new", platformId: "P", updatedAt: new Date("2026-08-01T00:00:00Z") }),
      ],
      NOW
    );
    expect(ranked[0]!.id).toBe("new");
  });

  it("a broken-but-fresh channel still loses to a healthy-but-stale one", () => {
    const ranked = rankCandidates(
      [
        row({ id: "brokenFresh", platformId: "P", metadata: health("needs_reconnect"), updatedAt: NOW }),
        row({ id: "okStale", platformId: "P", updatedAt: new Date("2026-01-01T00:00:00Z") }),
      ],
      NOW
    );
    expect(ranked[0]!.id).toBe("okStale");
  });

  it("does not mutate the input array", () => {
    const rows = [row({ id: "a", platformId: "P" }), row({ id: "b", platformId: "P" })];
    const before = rows.map((r) => r.id);
    rankCandidates(rows, NOW);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("selectShard", () => {
  it("partitions accounts across shards with no overlap and no loss", () => {
    const accounts = Array.from({ length: 120 }, (_, i) => ({ platform: "FACEBOOK", platformId: `P${i}` }));
    const shards = [0, 1, 2, 3].map((i) => selectShard(accounts, i, 4));
    const total = shards.reduce((n, s) => n + s.length, 0);
    expect(total).toBe(120); // every account covered exactly once
    const ids = new Set(shards.flat().map((a) => a.platformId));
    expect(ids.size).toBe(120);
  });

  it("is deterministic — the same account always lands in the same shard", () => {
    const accounts = [{ platform: "FACEBOOK", platformId: "P42" }];
    const first = [0, 1, 2, 3].findIndex((i) => selectShard(accounts, i, 4).length === 1);
    const again = [0, 1, 2, 3].findIndex((i) => selectShard(accounts, i, 4).length === 1);
    expect(first).toBe(again);
  });

  it("returns everything when sharding is disabled", () => {
    const accounts = [{ platform: "FACEBOOK", platformId: "P1" }];
    expect(selectShard(accounts, 0, 1)).toHaveLength(1);
  });
});
