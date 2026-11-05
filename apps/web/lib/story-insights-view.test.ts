import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STORY_METRIC_COLUMNS,
  metricText,
  storyCsv,
  storyLifeLabel,
  storyReadingLabel,
  storyStatusLabel,
  type StoryRowView,
} from "./story-insights-view";

const row = (o: Partial<StoryRowView> = {}): StoryRowView => ({
  platform: "INSTAGRAM",
  channelName: "Bollywood",
  channelHandle: "bollywood",
  publishedAt: "2026-11-05T02:00:00.000Z",
  expiresAt: "2026-11-06T02:00:00.000Z",
  live: true,
  final: false,
  status: "measured",
  url: "https://www.instagram.com/stories/bollywood/1/",
  note: "=cmd note",
  capturedAt: "2026-11-05T08:00:00.000Z",
  views: 120,
  reach: 90,
  shares: 0,
  replies: null,
  totalInteractions: null,
  tapsForward: 40,
  tapsBack: 5,
  exits: 10,
  swipeForward: 7,
  profileVisits: 4,
  follows: 1,
  linkClicks: 2,
  ...o,
});

describe("story insights labels", () => {
  it("time left while live, Ended after", () => {
    const now = new Date("2026-11-05T20:00:00.000Z");
    expect(storyLifeLabel(row(), now)).toBe("Live, 6h left");
    expect(storyLifeLabel(row(), new Date("2026-11-06T01:30:00.000Z"))).toBe("Live, 30m left");
    expect(storyLifeLabel(row({ live: false }), now)).toBe("Ended");
  });

  it("reading label distinguishes final, still-moving and last readings", () => {
    expect(storyReadingLabel(row({ final: true }))).toBe("Final");
    expect(storyReadingLabel(row())).toBe("So far");
    expect(storyReadingLabel(row({ live: false }))).toBe("Last reading");
    expect(storyReadingLabel(row({ status: "pending" }))).toBe("");
  });

  it("explains every non-measured status in plain words", () => {
    expect(storyStatusLabel("not_available")).toMatch(/Facebook/);
    expect(storyStatusLabel("low_viewers")).toMatch(/Under 5 viewers/);
    expect(storyStatusLabel("reconnect")).toMatch(/Reconnect/);
    expect(storyStatusLabel("measured")).toBe("");
  });

  it("an unreported metric is a dash, a measured zero stays 0", () => {
    expect(metricText(null)).toBe("—");
    expect(metricText(0)).toBe("0");
  });
});

describe("storyCsv", () => {
  it("one column per metric, blanks for unreported values, never 0", () => {
    const { header, body } = storyCsv([row()]);
    expect(header).toHaveLength(7 + STORY_METRIC_COLUMNS.length + 2);
    const repliesIdx = header.indexOf("Replies");
    expect(body[0]![repliesIdx]).toBeNull();
    expect(body[0]![header.indexOf("Shares")]).toBe(0);
    expect(body[0]![header.indexOf("Views")]).toBe(120);
  });
});

describe("Insights page wiring", () => {
  const page = readFileSync(join(__dirname, "..", "app", "dashboard", "analytics", "page.tsx"), "utf8");
  const tab = readFileSync(join(__dirname, "..", "components", "analytics", "StoriesTab.tsx"), "utf8");

  it("offers a Stories tab reachable by ?tab=stories", () => {
    expect(page).toContain('{ id: "stories", label: "Stories" }');
    expect(page).toContain('t === "stories"');
    expect(page).toContain("<StoriesTab />");
  });

  it("the CSV goes through the formula-injection-safe toCsv", () => {
    expect(tab).toContain("toCsv(header, body)");
  });

  it("an <img> only ever gets the server's image-only thumbnailUrl", () => {
    expect(tab).toMatch(/<img src=\{r\.thumbnailUrl\}/);
    expect(tab).not.toMatch(/<img src=\{r\.url\}/);
  });
});
