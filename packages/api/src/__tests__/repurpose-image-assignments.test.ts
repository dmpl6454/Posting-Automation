import { describe, it, expect } from "vitest";
import { resolveSlotAssignments, type SlotAssignment } from "../routers/repurpose.router";

describe("resolveSlotAssignments — org-scoped media id → url map", () => {
  const ownedRows = [
    { id: "m1", url: "https://cdn/u1.jpg" },
    { id: "m2", url: "https://cdn/u2.jpg" },
  ];

  it("maps assigned ids to a userImages lookup keyed by media id", () => {
    const asg: SlotAssignment[] = [
      { slot: "background", mediaId: "m1" },
      { slot: "slide:0", mediaId: "m2" },
    ];
    const map = resolveSlotAssignments(asg, ownedRows);
    expect(map).toEqual({ m1: { url: "https://cdn/u1.jpg" }, m2: { url: "https://cdn/u2.jpg" } });
  });

  it("ignores an assignment whose mediaId is not in the owned rows", () => {
    const asg: SlotAssignment[] = [{ slot: "background", mediaId: "ghost" }];
    expect(resolveSlotAssignments(asg, ownedRows)).toEqual({});
  });

  it("returns an empty map for no assignments", () => {
    expect(resolveSlotAssignments([], ownedRows)).toEqual({});
  });
});
