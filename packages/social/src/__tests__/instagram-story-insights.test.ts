import { describe, it, expect } from "vitest";
import {
  hasStoryMetrics,
  isNotEnoughViewersError,
  parseStoryNavigationBreakdown,
  parseStoryProfileMetrics,
} from "../utils/instagram-story-insights";

describe("parseStoryNavigationBreakdown", () => {
  it("accepts upper- and lower-case action types and ignores unknown ones", () => {
    const body = {
      data: [
        {
          name: "navigation",
          total_value: {
            breakdowns: [
              {
                results: [
                  { dimension_values: ["TAP_FORWARD"], value: 7 },
                  { dimension_values: ["tap_exit"], value: "3" },
                  { dimension_values: ["something_new"], value: 99 },
                  { dimension_values: ["tap_back"], value: null },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(parseStoryNavigationBreakdown(body)).toEqual({ tapsForward: 7, exits: 3 });
  });

  it("returns {} for an empty, malformed or unrelated body", () => {
    expect(parseStoryNavigationBreakdown(null)).toEqual({});
    expect(parseStoryNavigationBreakdown({ data: "x" })).toEqual({});
    expect(parseStoryNavigationBreakdown({ data: [{ name: "reach", values: [{ value: 3 }] }] })).toEqual({});
  });
});

describe("parseStoryProfileMetrics", () => {
  it("reads values[0].value and total_value.value shapes", () => {
    const body = {
      data: [
        { name: "profile_visits", values: [{ value: 4 }] },
        { name: "follows", total_value: { value: 2 } },
        { name: "link_clicks", values: [{ value: 0 }] },
        { name: "reach", values: [{ value: 50 }] },
      ],
    };
    expect(parseStoryProfileMetrics(body)).toEqual({ profileVisits: 4, follows: 2, linkClicks: 0 });
  });
});

describe("isNotEnoughViewersError / hasStoryMetrics", () => {
  it("matches only Meta's #10 not-enough-viewers answer", () => {
    expect(isNotEnoughViewersError({ code: 10, message: "(#10) Not enough viewers for the media to show insights" })).toBe(true);
    expect(isNotEnoughViewersError({ code: 10, message: "(#10) requires pages_read_user_content" })).toBe(false);
    expect(isNotEnoughViewersError({ code: 100, message: "Not enough viewers" })).toBe(false);
    expect(isNotEnoughViewersError(undefined)).toBe(false);
  });

  it("an empty story object is not worth storing; a measured 0 is", () => {
    expect(hasStoryMetrics({})).toBe(false);
    expect(hasStoryMetrics(undefined)).toBe(false);
    expect(hasStoryMetrics({ replies: 0 })).toBe(true);
    expect(hasStoryMetrics({ notEnoughViewers: true })).toBe(true);
  });
});
