import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FEED_FILTERS,
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
    expect(parseFeedFilters(new URLSearchParams("sort=reach&minReach=10000&period=7"))).toEqual({ sort: "reach", minReach: 10000, days: 7 });
    expect(parseFeedFilters(new URLSearchParams("sort=views&minReach=123&period=999"))).toEqual(DEFAULT_FEED_FILTERS);
    expect(parseFeedFilters(new URLSearchParams("minReach=-5&period=abc"))).toEqual(DEFAULT_FEED_FILTERS);
  });

  it("writes non-defaults and keeps other params (like ?view)", () => {
    const base = new URLSearchParams("view=comments&sort=reach");
    expect(applyFeedFilters(base, { sort: "reach", minReach: 1000, days: 30 }).toString()).toBe("view=comments&sort=reach&minReach=1000&period=30");
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
