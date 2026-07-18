/**
 * Unit tests for the pure group-analytics aggregator
 * (packages/api/src/lib/group-stats.ts) used by analytics.groupStats.
 *
 * Locked semantics:
 *  - a channel in MULTIPLE groups counts in EACH group;
 *  - channels in NO group land in an "Ungrouped" bucket (only when they have
 *    activity rows);
 *  - a group whose channels have no rows still appears, all-zero;
 *  - engagementRate is computed from the SUMS ×100, and is 0 (not NaN/Infinity)
 *    when impressions are 0.
 */
import { describe, expect, it } from "vitest";
import {
  sumChannelRowsIntoGroups,
  UNGROUPED_ID,
  type ChannelStatRow,
  type GroupWithChannels,
} from "../lib/group-stats";

function row(channelId: string, overrides: Partial<ChannelStatRow> = {}): ChannelStatRow {
  return {
    channelId,
    posts: 1,
    impressions: 100,
    reach: 80,
    likes: 5,
    comments: 3,
    shares: 2,
    clicks: 4,
    ...overrides,
  };
}

function group(id: string, channelIds: string[], name = `Group ${id}`): GroupWithChannels {
  return { id, name, color: "#6366f1", channels: channelIds.map((cid) => ({ id: cid })) };
}

describe("sumChannelRowsIntoGroups", () => {
  it("sums each group's channels and computes engagementRate from the sums", () => {
    const groups = [group("g1", ["c1", "c2"])];
    const rows = [
      row("c1", { posts: 2, impressions: 100, likes: 5, comments: 3, shares: 2 }),
      row("c2", { posts: 3, impressions: 300, likes: 10, comments: 5, shares: 5 }),
    ];

    const out = sumChannelRowsIntoGroups(groups, rows);
    expect(out).toHaveLength(1);
    const g1 = out[0]!;
    expect(g1.id).toBe("g1");
    expect(g1.channelCount).toBe(2);
    expect(g1.posts).toBe(5);
    expect(g1.impressions).toBe(400);
    expect(g1.reach).toBe(160);
    expect(g1.clicks).toBe(8);
    // (15 likes + 8 comments + 7 shares) / 400 impressions * 100
    expect(g1.engagementRate).toBeCloseTo((30 / 400) * 100);
  });

  it("counts a channel in EACH group it belongs to (multi-group membership)", () => {
    const groups = [group("g1", ["shared", "only1"]), group("g2", ["shared"])];
    const rows = [
      row("shared", { posts: 4, impressions: 200 }),
      row("only1", { posts: 1, impressions: 50 }),
    ];

    const out = sumChannelRowsIntoGroups(groups, rows);
    const g1 = out.find((r) => r.id === "g1")!;
    const g2 = out.find((r) => r.id === "g2")!;
    expect(g1.posts).toBe(5);
    expect(g1.impressions).toBe(250);
    expect(g2.posts).toBe(4);
    expect(g2.impressions).toBe(200);
    // No Ungrouped bucket — every active channel is in a group.
    expect(out.find((r) => r.id === UNGROUPED_ID)).toBeUndefined();
  });

  it("puts channels that belong to no group into an Ungrouped bucket", () => {
    const groups = [group("g1", ["c1"])];
    const rows = [
      row("c1"),
      row("loner-a", { posts: 2, impressions: 10, likes: 1, comments: 0, shares: 0 }),
      row("loner-b", { posts: 1, impressions: 30, likes: 2, comments: 1, shares: 0 }),
    ];

    const out = sumChannelRowsIntoGroups(groups, rows);
    expect(out).toHaveLength(2);
    const ungrouped = out.find((r) => r.id === UNGROUPED_ID)!;
    expect(ungrouped.name).toBe("Ungrouped");
    expect(ungrouped.channelCount).toBe(2);
    expect(ungrouped.posts).toBe(3);
    expect(ungrouped.impressions).toBe(40);
    expect(ungrouped.engagementRate).toBeCloseTo((4 / 40) * 100);
    // Ungrouped is always LAST, after real groups.
    expect(out[out.length - 1]!.id).toBe(UNGROUPED_ID);
  });

  it("keeps a zero-post group visible with all-zero sums", () => {
    const groups = [group("empty", ["silent1", "silent2"])];

    const out = sumChannelRowsIntoGroups(groups, []);
    expect(out).toHaveLength(1);
    const empty = out[0]!;
    expect(empty.channelCount).toBe(2); // membership, not activity
    expect(empty.posts).toBe(0);
    expect(empty.impressions).toBe(0);
    expect(empty.clicks).toBe(0);
    expect(empty.engagementRate).toBe(0);
  });

  it("returns engagementRate 0 (not NaN/Infinity) when impressions are 0", () => {
    const groups = [group("g1", ["c1"])];
    const rows = [row("c1", { impressions: 0, likes: 7, comments: 2, shares: 1 })];

    const out = sumChannelRowsIntoGroups(groups, rows);
    expect(out[0]!.engagementRate).toBe(0);
    expect(Number.isFinite(out[0]!.engagementRate)).toBe(true);
  });

  it("returns an empty array for no groups and no rows", () => {
    expect(sumChannelRowsIntoGroups([], [])).toEqual([]);
  });

  it("uses the supplied ungroupedChannelCount for the Ungrouped bucket (membership, not activity)", () => {
    const groups = [group("g1", ["c1"])];
    // c1 is grouped; c2 has activity but is ungrouped; c3/c4 are ungrouped with
    // NO activity (not in rows). The true active-ungrouped count is 3 (c2,c3,c4).
    const rows = [
      row("c1", { impressions: 100, likes: 10 }),
      row("c2", { impressions: 50, likes: 5 }),
    ];

    const out = sumChannelRowsIntoGroups(groups, rows, 3);
    const ungrouped = out.find((r) => r.id === UNGROUPED_ID)!;
    expect(ungrouped.channelCount).toBe(3); // membership count, not the 1 activity row
    expect(ungrouped.impressions).toBe(50); // metrics still only from active-with-activity rows
    expect(ungrouped.likes).toBe(5);
  });

  it("emits the Ungrouped bucket when ungroupedChannelCount>0 even with no ungrouped activity rows", () => {
    const groups = [group("g1", ["c1"])];
    const rows = [row("c1", { impressions: 100, likes: 10 })];

    // 2 ungrouped active channels exist but none posted in-window.
    const out = sumChannelRowsIntoGroups(groups, rows, 2);
    const ungrouped = out.find((r) => r.id === UNGROUPED_ID)!;
    expect(ungrouped).toBeDefined();
    expect(ungrouped.channelCount).toBe(2);
    expect(ungrouped.impressions).toBe(0); // no activity rows to sum
  });

  it("omits the Ungrouped bucket when ungroupedChannelCount is 0 and no ungrouped rows", () => {
    const groups = [group("g1", ["c1"])];
    const rows = [row("c1", { impressions: 100 })];

    const out = sumChannelRowsIntoGroups(groups, rows, 0);
    expect(out.find((r) => r.id === UNGROUPED_ID)).toBeUndefined();
  });
});
