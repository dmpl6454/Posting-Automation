import { describe, it, expect } from "vitest";
import {
  isBareFacebookVideoId,
  buildOwnedIdSet,
  classifyPosts,
  targetsNeedingVideoResolution,
} from "../lib/external-post-dedup";

/**
 * Dedup between platform-fetched posts and posts WE published. Getting this wrong
 * double-counts every app-published post in Insights.
 *
 * Real ids from the live production probe (2026-08-06):
 *   page                     1196604146874966
 *   composite listing id     1196604146874966_122114466033390760
 *   bare Video-node id       2285901422221783
 *   its resolved post_id     122111714397390760
 *   ⇒ composite match key    1196604146874966_122111714397390760
 */
const PAGE = "1196604146874966";

describe("isBareFacebookVideoId", () => {
  it("treats an underscore-free id as a bare Video-node id", () => {
    expect(isBareFacebookVideoId("2285901422221783")).toBe(true);
  });
  it("treats a composite id as NOT bare", () => {
    expect(isBareFacebookVideoId(`${PAGE}_122114466033390760`)).toBe(false);
  });
  it("is false for an empty id (never match everything)", () => {
    expect(isBareFacebookVideoId("")).toBe(false);
  });
});

describe("classifyPosts", () => {
  it("matches an ordinary composite id exactly", () => {
    const listed = [{ platformPostId: `${PAGE}_122114466033390760` }];
    const out = classifyPosts(listed, [{ id: "t1", publishedId: `${PAGE}_122114466033390760` }], PAGE);
    expect(out[0]!.postTargetId).toBe("t1");
  });

  it("matches a bare Video-node target via its RESOLVED composite id (the real fix)", () => {
    const listed = [{ platformPostId: `${PAGE}_122111714397390760` }];
    const targets = [
      { id: "vid1", publishedId: "2285901422221783", resolvedPostId: `${PAGE}_122111714397390760` },
    ];
    expect(classifyPosts(listed, targets, PAGE)[0]!.postTargetId).toBe("vid1");
  });

  it("without resolution, a bare video target does NOT match — the pre-fix behavior", () => {
    const listed = [{ platformPostId: `${PAGE}_122111714397390760` }];
    const targets = [{ id: "vid1", publishedId: "2285901422221783" }];
    // This is the double-count hazard; it is why resolveVideoPostId exists.
    expect(classifyPosts(listed, targets, PAGE)[0]!.postTargetId).toBeNull();
  });

  it("marks a genuinely foreign post as platform-native (null)", () => {
    const listed = [{ platformPostId: `${PAGE}_999999999999999` }];
    const targets = [{ id: "t1", publishedId: `${PAGE}_122114466033390760` }];
    expect(classifyPosts(listed, targets, PAGE)[0]!.postTargetId).toBeNull();
  });

  it("INSTAGRAM bare media ids match exactly, with no resolution step", () => {
    const listed = [{ platformPostId: "17912345678901234" }];
    const targets = [{ id: "ig1", publishedId: "17912345678901234" }];
    // pageId is irrelevant for IG; an exact string match is enough.
    expect(classifyPosts(listed, targets, "")[0]!.postTargetId).toBe("ig1");
  });

  it("ignores targets with a null publishedId (never published / failed)", () => {
    const listed = [{ platformPostId: `${PAGE}_1` }];
    expect(classifyPosts(listed, [{ id: "t", publishedId: null }], PAGE)[0]!.postTargetId).toBeNull();
  });
});

describe("buildOwnedIdSet", () => {
  it("includes every alias: raw, resolved, and {page}_{bare}", () => {
    const set = buildOwnedIdSet(
      [{ id: "v", publishedId: "2285901422221783", resolvedPostId: `${PAGE}_122111714397390760` }],
      PAGE
    );
    expect(set.has("2285901422221783")).toBe(true);
    expect(set.has(`${PAGE}_122111714397390760`)).toBe(true);
    expect(set.has(`${PAGE}_2285901422221783`)).toBe(true);
  });
});

describe("targetsNeedingVideoResolution", () => {
  it("selects unresolved bare video targets that the listing did not already match", () => {
    const targets = [
      { id: "v1", publishedId: "2285901422221783" },
      { id: "f1", publishedId: `${PAGE}_122114466033390760` }, // composite — no call needed
      { id: "v2", publishedId: "1015462917761398", resolvedPostId: `${PAGE}_x` }, // done
    ];
    const out = targetsNeedingVideoResolution(targets, new Set(), PAGE, 10);
    expect(out.map((t) => t.id)).toEqual(["v1"]);
  });

  it("skips a bare id already present in the listing under its {page}_{bare} alias", () => {
    const targets = [{ id: "v1", publishedId: "2285901422221783" }];
    const listed = new Set([`${PAGE}_2285901422221783`]);
    expect(targetsNeedingVideoResolution(targets, listed, PAGE, 10)).toHaveLength(0);
  });

  it("caps the number of resolution calls per run (bounded Graph spend)", () => {
    const targets = Array.from({ length: 25 }, (_, i) => ({ id: `v${i}`, publishedId: `${1000000 + i}` }));
    expect(targetsNeedingVideoResolution(targets, new Set(), PAGE, 10)).toHaveLength(10);
  });
});
