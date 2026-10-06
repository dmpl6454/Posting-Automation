import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FEED_FILTERS,
  MENTION_SOURCES,
  SOURCE_FILTER_OPTIONS,
  SOURCE_LABEL,
  parseSource,
  SENTIMENT_FILTER_OPTIONS,
  parseSentiment,
  applyFeedFilters,
  compactCount,
  isFiltered,
  parseFeedFilters,
  reachLabel,
} from "./listening-feed";

/** Social Listening feed: sort by reach, minimum reach, period (2026-10-06). */
const page = readFileSync(join(__dirname, "../app/dashboard/listening/page.tsx"), "utf8");

describe("feed filters in the URL", () => {
  it("reads only the values on offer; anything else is the default", () => {
    expect(parseFeedFilters(new URLSearchParams(""))).toEqual(DEFAULT_FEED_FILTERS);
    expect(parseFeedFilters(new URLSearchParams("sort=reach&minReach=10000&period=7"))).toEqual({ sort: "reach", minReach: 10000, days: 7, sentiment: null, source: null });
    expect(parseFeedFilters(new URLSearchParams("sort=views&minReach=123&period=999"))).toEqual(DEFAULT_FEED_FILTERS);
    expect(parseFeedFilters(new URLSearchParams("minReach=-5&period=abc"))).toEqual(DEFAULT_FEED_FILTERS);
  });

  it("writes non-defaults and keeps other params (like ?view)", () => {
    const base = new URLSearchParams("view=comments&sort=reach");
    expect(applyFeedFilters(base, { sort: "reach", minReach: 1000, days: 30, sentiment: null, source: null }).toString()).toBe("view=comments&sort=reach&minReach=1000&period=30");
    expect(applyFeedFilters(new URLSearchParams("sort=reach&minReach=1000&period=30"), DEFAULT_FEED_FILTERS).toString()).toBe("");
    expect(isFiltered(DEFAULT_FEED_FILTERS)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FEED_FILTERS, days: 1 })).toBe(true);
  });
});

describe("reach on a mention card", () => {
  it("names what each source counts, and shows nothing when the source reported none", () => {
    expect(reachLabel("YOUTUBE", 1_234_567)).toBe("1.2M views");
    expect(reachLabel("TIKTOK", 4_500)).toBe("4.5K views");
    expect(reachLabel("TWITTER", 980)).toBe("980 impressions");
    expect(reachLabel("REDDIT", 1)).toBe("1 upvote");
    expect(reachLabel("REDDIT", 312)).toBe("312 upvotes");
    expect(reachLabel("NEWS", 5)).toBe("5 reach");
    expect(reachLabel("NEWS", 0)).toBeNull();
    expect(reachLabel("YOUTUBE", null)).toBeNull();
    expect(compactCount(210_000)).toBe("210.0K");
  });
});

describe("listening page contract", () => {
  it("pages the feed with the filters and offers the controls", () => {
    expect(page).toMatch(/trpc\.listening\.mentions\.useInfiniteQuery\(/);
    expect(page).toMatch(/sort: feed\.sort,\s+minReach: feed\.minReach,/);
    expect(page).toMatch(/getNextPageParam: \(last\) => last\.nextCursor/);
    expect(page).toContain("data-testid={`mention-sort-${o.id}`}");
    expect(page).toMatch(/\{ id: "recent", label: "Newest" \},\s+\{ id: "reach", label: "Most reach" \}/);
    for (const id of ["mention-min-reach", "mention-period", "mention-load-more", "mention-reach"]) {
      expect(page).toContain(`data-testid="${id}"`);
    }
  });

  it("explains which sources report reach", () => {
    expect(page).toMatch(/views on YouTube and TikTok, impressions on X, upvotes on Reddit posts/);
  });
});

describe("overall sentiment filter (2026-10-06)", () => {
  it("?sentiment= reads positive / neutral / negative / mixed, case-insensitively; anything else is all", () => {
    expect(parseFeedFilters(new URLSearchParams("sentiment=negative")).sentiment).toBe("NEGATIVE");
    expect(parseFeedFilters(new URLSearchParams("sentiment=Positive")).sentiment).toBe("POSITIVE");
    expect(parseSentiment("neutral")).toBe("NEUTRAL");
    expect(parseSentiment("mixed")).toBe("MIXED");
    expect(parseSentiment("angry")).toBeNull();
    expect(parseSentiment(null)).toBeNull();
  });

  it("is written lower-case, dropped when cleared, and counts as filtered", () => {
    const on = applyFeedFilters(new URLSearchParams("period=7"), { ...DEFAULT_FEED_FILTERS, days: 7, sentiment: "NEUTRAL" });
    expect(on.toString()).toBe("period=7&sentiment=neutral");
    expect(applyFeedFilters(on, { ...DEFAULT_FEED_FILTERS, days: 7 }).toString()).toBe("period=7");
    expect(isFiltered({ ...DEFAULT_FEED_FILTERS, sentiment: "POSITIVE" })).toBe(true);
  });

  it("offers All, Positive, Neutral, Negative and Mixed", () => {
    expect(SENTIMENT_FILTER_OPTIONS.map((o) => o.label)).toEqual(["All", "Positive", "Neutral", "Negative", "Mixed"]);
  });

  it("the page sends it to the feed query; chips and the distribution legend both set it", () => {
    expect(page).toMatch(/\.\.\.\(feed\.sentiment \? \{ sentiment: feed\.sentiment \} : \{\}\)/);
    expect(page).toContain("data-testid={`mention-sentiment-${(o.value ?? \"all\").toLowerCase()}`}");
    expect(page).toContain("data-testid={`sentiment-legend-${s.key}`}");
    expect(page).toMatch(/onClick=\{\(\) => setFeed\(\{ sentiment: active \? null : s\.value \}\)\}/);
    expect(page).toMatch(/onClick=\{\(\) => setFeed\(DEFAULT_FEED_FILTERS\)\}/);
  });
});

describe("source filter (2026-10-06)", () => {
  const schema = readFileSync(join(__dirname, "../../../packages/db/prisma/schema.prisma"), "utf8");

  it("MENTION_SOURCES is exactly the MentionSource enum", () => {
    const body = schema.slice(schema.indexOf("enum MentionSource {"), schema.indexOf("}", schema.indexOf("enum MentionSource {")));
    const values = body.split("\n").slice(1).map((l) => l.trim()).filter((l) => /^[A-Z]+$/.test(l));
    expect([...MENTION_SOURCES].sort()).toEqual(values.sort());
    for (const v of MENTION_SOURCES) expect(SOURCE_LABEL[v]).toBeTruthy();
  });

  it("?source= reads any enum value case-insensitively; anything else is all sources", () => {
    expect(parseFeedFilters(new URLSearchParams("source=youtube")).source).toBe("YOUTUBE");
    expect(parseSource("HackerNews")).toBe("HACKERNEWS");
    expect(parseSource("blog")).toBe("BLOG");
    expect(parseSource("myspace")).toBeNull();
    expect(parseSource("")).toBeNull();
  });

  it("is written lower-case, dropped when cleared, counts as filtered, and keeps other params", () => {
    const on = applyFeedFilters(new URLSearchParams("sentiment=negative"), { ...DEFAULT_FEED_FILTERS, sentiment: "NEGATIVE", source: "REDDIT" });
    expect(on.toString()).toBe("sentiment=negative&source=reddit");
    expect(applyFeedFilters(on, { ...DEFAULT_FEED_FILTERS, sentiment: "NEGATIVE" }).toString()).toBe("sentiment=negative");
    expect(isFiltered({ ...DEFAULT_FEED_FILTERS, source: "NEWS" })).toBe(true);
  });

  it("offers the sources listening collects (not the never-written BLOG / FORUM / OTHER); News covers Bing and GDELT too", () => {
    const values = SOURCE_FILTER_OPTIONS.map((o) => o.value);
    expect(values[0]).toBeNull();
    expect(values).toHaveLength(13);
    expect(values).not.toContain("BLOG");
    expect(values).not.toContain("OTHER");
    expect(SOURCE_LABEL.NEWS).toBe("News");
  });

  it("the page sends it, offers a select, and the Sources rows toggle it", () => {
    expect(page).toMatch(/\.\.\.\(feed\.source \? \{ source: feed\.source \} : \{\}\)/);
    expect(page).toContain('data-testid="mention-source"');
    expect(page).toContain("data-testid={`source-row-${s.source.toLowerCase()}`}");
    expect(page).toMatch(/setFeed\(\{ source: active \? null : parseSource\(s\.source\) \}\)/);
    expect(page).not.toMatch(/const SOURCE_LABEL/);
  });
});
