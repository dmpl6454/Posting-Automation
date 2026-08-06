import { describe, it, expect } from "vitest";
import { sumChannelRowsIntoGroups, UNGROUPED_ID, type ChannelStatRow } from "../lib/group-stats";

/**
 * Group Performance used to render every metric as a raw formatNumber() sum with
 * NO capability gate, while the Channel Performance table one card above applied
 * the full honesty rules. The same underlying data therefore rendered "—" in one
 * table and "0" in the other, on one page.
 *
 * Measured on prod 2026-08-06: the FACEBOOK-only group "fb" summed to
 * `Reach 0` while BOTH its member channels reported reach as unavailable
 * (Meta deleted the FB Page-post reach metric — no permission restores it).
 */

function row(over: Partial<ChannelStatRow> & { channelId: string }): ChannelStatRow {
  return {
    posts: 0,
    impressions: 0,
    reach: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    clicks: 0,
    ...over,
  };
}

describe("group metric availability", () => {
  it("marks a metric unavailable when EVERY member channel says so (prod 'fb' group)", () => {
    // Both channels: FB video views land in impressions (available), reach dead.
    const rows = [
      row({ channelId: "c1", posts: 10, impressions: 57, likes: 19, unavailable: ["reach"] }),
      row({ channelId: "c2", posts: 7, impressions: 1, unavailable: ["reach"] }),
    ];
    const [g] = sumChannelRowsIntoGroups(
      [{ id: "g1", name: "fb", color: "#000", channels: [{ id: "c1" }, { id: "c2" }] }],
      rows
    );

    expect(g!.unavailable).toContain("reach");
    // Impressions stay reportable — this is real FB video-view data.
    expect(g!.unavailable).not.toContain("impressions");
    expect(g!.impressions).toBe(58);
  });

  it("keeps a metric available when even ONE member can report it (mixed FB+IG)", () => {
    const rows = [
      row({ channelId: "fb1", posts: 3, unavailable: ["reach", "impressions"] }),
      row({ channelId: "ig1", posts: 4, reach: 2619, unavailable: [] }),
    ];
    const [g] = sumChannelRowsIntoGroups(
      [{ id: "g1", name: "Demo", color: "#000", channels: [{ id: "fb1" }, { id: "ig1" }] }],
      rows
    );

    // IG reports reach, so the group's summed reach is meaningful.
    expect(g!.unavailable).not.toContain("reach");
    expect(g!.reach).toBe(2619);
  });

  it("treats rows with NO capability info as reporting (never hides an existing number)", () => {
    const rows = [row({ channelId: "c1", posts: 2, reach: 10 })]; // no `unavailable`
    const [g] = sumChannelRowsIntoGroups(
      [{ id: "g1", name: "legacy", color: "#000", channels: [{ id: "c1" }] }],
      rows
    );
    expect(g!.unavailable).toEqual([]);
  });

  it("exposes the engagement-rate base so a one-post rate can't read as the group's rate", () => {
    const rows = [
      row({
        channelId: "c1",
        posts: 10,
        impressions: 57,
        likes: 4,
        impressionedImpressions: 57,
        impressionedLikes: 4,
        impressionedPosts: 1,
        unavailable: [],
      }),
    ];
    const [g] = sumChannelRowsIntoGroups(
      [{ id: "g1", name: "fb", color: "#000", channels: [{ id: "c1" }] }],
      rows
    );

    expect(g!.engagementRateBasis).toEqual({ impressionedPosts: 1, totalPosts: 10 });
  });

  it("reports hasSnapshot=false for a group whose channels have no captures", () => {
    const rows = [row({ channelId: "c1", posts: 3, hasSnapshot: false })];
    const [g] = sumChannelRowsIntoGroups(
      [{ id: "g1", name: "new", color: "#000", channels: [{ id: "c1" }] }],
      rows
    );
    expect(g!.hasSnapshot).toBe(false);
  });

  it("applies the same gate to the Ungrouped bucket", () => {
    const rows = [row({ channelId: "loose", posts: 5, unavailable: ["reach", "clicks"] })];
    const result = sumChannelRowsIntoGroups([], rows);
    const ungrouped = result.find((r) => r.id === UNGROUPED_ID);

    expect(ungrouped!.unavailable).toEqual(expect.arrayContaining(["reach", "clicks"]));
  });

  it("an empty group claims nothing unavailable (no rows ⇒ no capability claim)", () => {
    const [g] = sumChannelRowsIntoGroups(
      [{ id: "g1", name: "empty", color: "#000", channels: [] }],
      []
    );
    expect(g!.unavailable).toEqual([]);
    expect(g!.engagementRateBasis).toEqual({ impressionedPosts: 0, totalPosts: 0 });
  });
});
