import { describe, it, expect } from "vitest";
import { buildSnapshotMetadata } from "./snapshot-metadata";

describe("buildSnapshotMetadata", () => {
  it("merges provider honesty metadata with windowTag", () => {
    const md = buildSnapshotMetadata(
      { saved: 4, reachIsDistinct: false, likeKind: "saves", metricsAvailable: { clicks: false }, source: "api" },
      "7d",
      false
    );
    expect(md).toMatchObject({ windowTag: "7d", saved: 4, reachIsDistinct: false, likeKind: "saves", source: "api" });
    expect(md?.metricsAvailable).toEqual({ clicks: false });
  });

  it("adds capturedLate only when true", () => {
    expect(buildSnapshotMetadata({ source: "scrape" }, "24h", true)).toMatchObject({
      windowTag: "24h",
      capturedLate: true,
      source: "scrape",
    });
    expect(buildSnapshotMetadata({ source: "api" }, "24h", false)?.capturedLate).toBeUndefined();
  });

  it("returns undefined when there is nothing to store (byte-identical legacy path)", () => {
    expect(buildSnapshotMetadata({}, undefined, false)).toBeUndefined();
  });

  it("stores provider metadata even without a windowTag (cron path)", () => {
    const md = buildSnapshotMetadata({ likeKind: "upvotes", reachIsDistinct: false }, undefined, false);
    expect(md).toEqual({ likeKind: "upvotes", reachIsDistinct: false });
  });
});
