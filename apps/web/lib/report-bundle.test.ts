import { describe, it, expect } from "vitest";
import { buildIndexRows, buildReportBundle, groupReportRows, slugify, type BundleRowBase } from "./report-bundle";

const row = (o: Partial<BundleRowBase> & { postId: string }): BundleRowBase => ({
  contentPreview: "Afratafri at Shivajipark",
  campaignLabel: null,
  channelName: "paphq",
  impressions: null,
  likes: 1,
  comments: 0,
  shares: 0,
  reach: 10,
  views: 100,
  ...o,
});

describe("groupReportRows", () => {
  it("groups labelled rows by campaign and unlabelled rows per post, in first-appearance order", () => {
    const rows = [
      row({ postId: "p1", contentPreview: "Newest post" }),
      row({ postId: "p2", campaignLabel: "Diwali 2026" }),
      row({ postId: "p1", channelName: "papsdesk" }),
      row({ postId: "p3", campaignLabel: "Diwali 2026", channelName: "x" }),
      row({ postId: "p4", contentPreview: "" }),
    ];
    const groups = groupReportRows(rows);
    expect(groups.map((g) => [g.kind, g.key, g.rows.length])).toEqual([
      ["post", "p1", 2],
      ["campaign", "Diwali 2026", 2],
      ["post", "p4", 1],
    ]);
    expect(groups[0]!.fileName).toBe("posts/post-p1-newest-post.csv");
    expect(groups[1]!.fileName).toBe("campaigns/diwali-2026.csv");
    expect(groups[2]!.fileName).toBe("posts/post-p4.csv");
    expect(groups[2]!.title).toBe("(no text)");
  });

  it("a blank label is 'no campaign', and two labels with the same slug get distinct files", () => {
    const groups = groupReportRows([
      row({ postId: "p1", campaignLabel: "   " }),
      row({ postId: "p2", campaignLabel: "Diwali 2026" }),
      row({ postId: "p3", campaignLabel: "Diwali-2026!" }),
    ]);
    expect(groups.map((g) => g.fileName)).toEqual([
      "posts/post-p1-afratafri-at-shivajipark.csv",
      "campaigns/diwali-2026.csv",
      "campaigns/diwali-2026-2.csv",
    ]);
  });

  it("slugify never ends in a dash and respects the cap", () => {
    expect(slugify("Hello, World!!")).toBe("hello-world");
    expect(slugify("a".repeat(50) + " b", 40)).toBe("a".repeat(40));
    expect(slugify("Afratafri at Shivajipark as fans swarm the premiere", 40)).toBe("afratafri-at-shivajipark-as-fans-swarm");
  });
});

describe("index.csv totals", () => {
  it("sums only reported metrics and leaves a never-reported metric blank, never 0", () => {
    const groups = groupReportRows([
      row({ postId: "p1", views: 100, likes: 1, impressions: null, saved: null }),
      row({ postId: "p1", views: 50, likes: 2, impressions: null, saved: null, channelName: "b" }),
    ]);
    const [idx] = buildIndexRows(groups);
    expect(idx).toEqual(["Afratafri at Shivajipark", "Post", 1, 2, 150, null, 3, 0, 0, 20, null, "posts/post-p1-afratafri-at-shivajipark.csv"]);
  });

  it("counts distinct posts inside a campaign", () => {
    const groups = groupReportRows([
      row({ postId: "p1", campaignLabel: "C" }),
      row({ postId: "p1", campaignLabel: "C", channelName: "b" }),
      row({ postId: "p2", campaignLabel: "C" }),
    ]);
    expect(buildIndexRows(groups)[0]!.slice(0, 4)).toEqual(["C", "Campaign", 2, 3]);
  });
});

describe("buildReportBundle", () => {
  it("emits index.csv first, then one column-identical CSV per group, named for the window", () => {
    const header = ["Post", "Channel", "Likes"];
    const toRow = (r: BundleRowBase) => [r.contentPreview, r.channelName, r.likes];
    const bundle = buildReportBundle({
      rows: [row({ postId: "p1" }), row({ postId: "p2", campaignLabel: "Diwali 2026" })],
      header,
      toRow,
      window: "7d",
      mode: "current",
      date: "2026-10-03",
    });
    expect(bundle.zipName).toBe("postautomation-reports-by-campaign-7d-current-2026-10-03.zip");
    expect(bundle.groups).toBe(2);
    expect(bundle.files.map((f) => f.name)).toEqual(["index.csv", "posts/post-p1-afratafri-at-shivajipark.csv", "campaigns/diwali-2026.csv"]);
    expect(bundle.files[1]!.content.replace("\uFEFF", "").split("\n")[0]).toBe('"Post","Channel","Likes"');
    expect(bundle.files[1]!.content.split("\n")).toHaveLength(2);
  });

  it("neutralises a formula-shaped campaign label in index.csv (same guard as the single CSV)", () => {
    const bundle = buildReportBundle({
      rows: [row({ postId: "p1", campaignLabel: "=HYPERLINK(evil)" })],
      header: ["Post"],
      toRow: (r) => [r.contentPreview],
      window: "7d",
      mode: "current",
      date: "2026-10-03",
    });
    expect(bundle.files[0]!.content).toContain(`"'=HYPERLINK(evil)"`);
  });

  it("marks a truncated export in the archive name", () => {
    const bundle = buildReportBundle({ rows: [], header: [], toRow: () => [], window: "30d", mode: "at_age", date: "2026-10-03", truncated: true });
    expect(bundle.zipName).toBe("postautomation-reports-by-campaign-30d-at_age-2026-10-03-truncated.zip");
    expect(bundle.files).toHaveLength(1);
  });
});

describe("bundle files match the single download byte-for-byte in encoding", () => {
  it("every file starts with the UTF-8 BOM that downloadCsv prepends (Excel reads emoji/Devanagari correctly)", () => {
    const b = buildReportBundle({
      rows: [row({ postId: "p1", contentPreview: "सलमान 🎬" })],
      header: ["Post"],
      toRow: (r) => [r.contentPreview],
      window: "7d",
      mode: "current",
      date: "2026-10-03",
    });
    expect(b.files.length).toBe(2);
    for (const f of b.files) expect(f.content.startsWith("\uFEFF")).toBe(true);
    expect(b.files[1]!.content).toContain("सलमान 🎬");
  });
});
