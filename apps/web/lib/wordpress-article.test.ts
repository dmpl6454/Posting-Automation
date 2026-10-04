import { describe, it, expect } from "vitest";
import {
  articleBlockReason,
  addArticleTags,
  buildArticlePayload,
  sanitizeRestoredArticle,
  pruneSelectionForArticle,
  EMPTY_ARTICLE,
  ARTICLE_TITLE_MAX,
} from "./wordpress-article";
import { storySelectableChannels, groupSelectableIds } from "./instagram-story";

const wp = { id: "w1", platform: "WORDPRESS" };
const ig = { id: "i1", platform: "INSTAGRAM" };
const fb = { id: "f1", platform: "FACEBOOK" };

describe("article mode channel scoping", () => {
  it("storySelectableChannels offers WordPress only in article mode, everything in post mode", () => {
    expect(storySelectableChannels([wp, ig, fb], "article")).toEqual([wp]);
    expect(storySelectableChannels([wp, ig, fb], "story")).toEqual([ig, fb]);
    expect(storySelectableChannels([wp, ig, fb], "post")).toEqual([wp, ig, fb]);
  });
  it("pruneSelectionForArticle drops non-WordPress picks and counts them", () => {
    expect(pruneSelectionForArticle(["w1", "i1", "f1"], [wp, ig, fb])).toEqual({ next: ["w1"], removed: 2 });
  });
  it("a Groups pill acts on WordPress members only in article mode", () => {
    const group = { channels: [{ ...wp, isActive: true }, { ...ig, isActive: true }] };
    expect(groupSelectableIds(group, new Set(["w1", "i1"]), "article")).toEqual(["w1"]);
    expect(groupSelectableIds(group, new Set(["w1", "i1"]), "post")).toEqual(["w1", "i1"]);
  });
});

describe("articleBlockReason — one predicate for submit, buttons and banner", () => {
  const ok = { title: "T", bodyLength: 10, selectedCount: 1, uploading: false };
  it("passes a complete article", () => expect(articleBlockReason(ok)).toBeNull());
  it("names the missing piece in order: title, body, site, uploads", () => {
    expect(articleBlockReason({ ...ok, title: "  " })).toMatch(/title/);
    expect(articleBlockReason({ ...ok, title: "x".repeat(ARTICLE_TITLE_MAX + 1) })).toMatch(/too long/);
    expect(articleBlockReason({ ...ok, bodyLength: 0 })).toMatch(/body/);
    expect(articleBlockReason({ ...ok, selectedCount: 0 })).toMatch(/WordPress site/);
    expect(articleBlockReason({ ...ok, uploading: true })).toMatch(/uploading/);
  });
});

describe("addArticleTags", () => {
  it("splits on commas/newlines, trims, dedupes case-insensitively, caps at 50", () => {
    expect(addArticleTags(["Bollywood"], " premiere, bollywood\nPVR ,, ")).toEqual(["Bollywood", "premiere", "PVR"]);
    expect(addArticleTags([], Array.from({ length: 60 }, (_, i) => `t${i}`).join(","))).toHaveLength(50);
  });
});

describe("buildArticlePayload", () => {
  it("keeps term ids for STILL-selected channels only, drops empty selections and a blank excerpt", () => {
    const payload = buildArticlePayload(
      {
        title: " T ",
        excerpt: "  ",
        status: "draft",
        newTags: ["a"],
        taxonomyByChannelId: {
          w1: { categoryIds: [1], tagIds: [] },
          w2: { categoryIds: [2], tagIds: [3] }, // deselected
          w3: { categoryIds: [], tagIds: [] }, // nothing picked
        },
      },
      ["w1", "w3"]
    );
    expect(payload).toEqual({ title: "T", status: "draft", newTags: ["a"], taxonomyByChannelId: { w1: { categoryIds: [1], tagIds: [] } } });
    expect("excerpt" in payload).toBe(false);
  });
});

describe("sanitizeRestoredArticle — a draft is re-validated entry by entry", () => {
  it("restores a well-formed block and drops garbage", () => {
    expect(
      sanitizeRestoredArticle({
        title: "T",
        excerpt: "E",
        status: "pending",
        newTags: ["x", "x", 3],
        taxonomyByChannelId: { w1: { categoryIds: [1, 1.5, "2", -3], tagIds: "no" }, "": { categoryIds: [1] } },
      })
    ).toEqual({
      title: "T",
      excerpt: "E",
      status: "pending",
      newTags: ["x"],
      taxonomyByChannelId: { w1: { categoryIds: [1], tagIds: [] } },
    });
  });
  it("returns null for nothing-to-restore and for non-objects", () => {
    expect(sanitizeRestoredArticle(undefined)).toBeNull();
    expect(sanitizeRestoredArticle("x")).toBeNull();
    expect(sanitizeRestoredArticle({ status: "weird" })).toBeNull();
    expect(sanitizeRestoredArticle({ title: "T", status: "weird" })?.status).toBe("publish");
  });
  it("EMPTY_ARTICLE is the blank state", () => {
    expect(EMPTY_ARTICLE).toEqual({ title: "", excerpt: "", status: "publish", newTags: [], taxonomyByChannelId: {} });
  });
});
