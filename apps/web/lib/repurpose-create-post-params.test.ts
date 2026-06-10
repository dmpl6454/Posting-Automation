import { describe, expect, it } from "vitest";
import {
  buildCreatePostQuery,
  parseCreatePostMediaIds,
  parseCsvList,
} from "./repurpose-create-post-params";

describe("buildCreatePostQuery", () => {
  it("carousel forwards ALL slide ids via aiMediaIds and NOT a single aiMediaId", () => {
    const q = buildCreatePostQuery({
      format: "carousel",
      content: "hello world",
      image: "https://s3.example.com/cover.png",
      mediaId: "slide0",
      carouselMediaIds: ["a", "b", "c"],
    });
    // encodeURIComponent encodes commas → %2C; URLSearchParams.get() decodes them on read
    expect(q).toContain("aiMediaIds=a%2Cb%2Cc");
    // and round-trips back to the raw list via the parser (mirrors page.tsx)
    expect(new URLSearchParams(q).get("aiMediaIds")).toBe("a,b,c");
    // must NOT include a single-id param
    expect(q).not.toMatch(/(^|&)aiMediaId=/);
    expect(q).toContain("tab=compose");
  });

  it("carousel forwards slide image URLs via aiImages and NOT a single aiImage", () => {
    const q = buildCreatePostQuery({
      format: "carousel",
      content: "c",
      carouselMediaIds: ["a", "b"],
      carouselImages: ["https://s3/x.png", "https://s3/y.png"],
    });
    const params = new URLSearchParams(q);
    expect(params.get("aiMediaIds")).toBe("a,b");
    expect(params.get("aiImages")).toBe("https://s3/x.png,https://s3/y.png");
    expect(params.has("aiImage")).toBe(false);
    expect(params.has("aiMediaId")).toBe(false);
  });

  it("static post forwards a single aiMediaId and NOT aiMediaIds", () => {
    const q = buildCreatePostQuery({
      format: "static",
      content: "caption",
      image: "https://s3.example.com/img.png",
      mediaId: "x",
    });
    expect(q).toContain("aiMediaId=x");
    expect(q).not.toContain("aiMediaIds=");
  });

  it("reel forwards a single aiMediaId (not aiMediaIds) even if carouselMediaIds exist", () => {
    const q = buildCreatePostQuery({
      format: "reel",
      content: "reel caption",
      mediaId: "video1",
      carouselMediaIds: ["a", "b"],
    });
    expect(q).toContain("aiMediaId=video1");
    expect(q).not.toContain("aiMediaIds=");
  });

  it("carousel without carouselMediaIds falls back to single aiMediaId", () => {
    const q = buildCreatePostQuery({
      format: "carousel",
      content: "c",
      mediaId: "only",
      carouselMediaIds: [],
    });
    expect(q).toContain("aiMediaId=only");
    expect(q).not.toContain("aiMediaIds=");
  });

  it("encodes content", () => {
    const q = buildCreatePostQuery({ format: "static", content: "a & b", mediaId: "m" });
    expect(q).toContain("content=a%20%26%20b");
  });
});

describe("parseCreatePostMediaIds", () => {
  it("parses comma list from aiMediaIds", () => {
    expect(parseCreatePostMediaIds({ aiMediaIds: "a,b,c" })).toEqual(["a", "b", "c"]);
  });

  it("falls back to single aiMediaId when no list", () => {
    expect(parseCreatePostMediaIds({ aiMediaId: "a" })).toEqual(["a"]);
  });

  it("returns [] when neither present", () => {
    expect(parseCreatePostMediaIds({})).toEqual([]);
    expect(parseCreatePostMediaIds({ aiMediaIds: null, aiMediaId: null })).toEqual([]);
  });

  it("prefers aiMediaIds over aiMediaId", () => {
    expect(parseCreatePostMediaIds({ aiMediaIds: "x,y", aiMediaId: "z" })).toEqual(["x", "y"]);
  });

  it("trims and drops empty segments", () => {
    expect(parseCreatePostMediaIds({ aiMediaIds: " a , , b " })).toEqual(["a", "b"]);
  });
});

describe("parseCsvList", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseCsvList(" a , b ,, c ")).toEqual(["a", "b", "c"]);
  });
  it("returns [] for null/empty", () => {
    expect(parseCsvList(null)).toEqual([]);
    expect(parseCsvList("")).toEqual([]);
    expect(parseCsvList("   ")).toEqual([]);
  });
});
