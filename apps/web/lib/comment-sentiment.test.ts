import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commentThreadHref, fillDailySeries, formatAvgScore, sentimentKey, sentimentPercents } from "./comment-sentiment";
import { describeLastRun } from "./comment-automation";

describe("sentimentPercents", () => {
  it("splits SCORED comments only and always adds up to 100", () => {
    const p = sentimentPercents({ positive: 1, neutral: 1, mixed: 1, negative: 0, pending: 50 });
    expect(p.positive + p.neutral + p.mixed + p.negative).toBe(100);
    expect(p.negative).toBe(0);
    expect(sentimentPercents({ positive: 2, neutral: 1, mixed: 0, negative: 1, pending: 0 })).toEqual({ positive: 50, neutral: 25, mixed: 0, negative: 25 });
  });
  it("nothing scored ⇒ all zero (pending is not a verdict)", () => {
    expect(sentimentPercents({ positive: 0, neutral: 0, mixed: 0, negative: 0, pending: 9 })).toEqual({ positive: 0, neutral: 0, mixed: 0, negative: 0 });
  });
});

describe("helpers", () => {
  it("sentimentKey", () => {
    expect(sentimentKey("NEGATIVE")).toBe("negative");
    expect(sentimentKey(null)).toBeNull();
    expect(sentimentKey("WEIRD")).toBeNull();
  });
  it("formatAvgScore", () => {
    expect(formatAvgScore(0.4166)).toBe("+0.42");
    expect(formatAvgScore(-0.1)).toBe("-0.10");
    expect(formatAvgScore(0)).toBe("0.00");
    expect(formatAvgScore(null)).toBe("—");
  });
  it("commentThreadHref encodes ids", () => {
    expect(commentThreadHref("ch 1", "t&2")).toBe("/dashboard/comments?channel=ch%201&post=t%262");
  });
  it("fillDailySeries covers every UTC day of the range, oldest first", () => {
    const now = Date.parse("2026-10-05T20:00:00Z");
    const out = fillDailySeries([{ day: "2026-10-04", positive: 2, neutral: 0, mixed: 0, negative: 1, pending: 0 }], 3, now);
    expect(out.map((d) => d.day)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(out[1]!.positive).toBe(2);
    expect(out[0]!.positive + out[2]!.negative).toBe(0);
  });
  it("the Automation tab's last-run line mentions scoring", () => {
    expect(describeLastRun({ postsChecked: 3, sentimentScored: 12, sentimentNegative: 2, sentimentPending: 4 })).toBe(
      "Checked 3 posts · scored 12 comments (2 negative) · 4 waiting to be scored."
    );
  });
});

describe("source contracts", () => {
  const panel = readFileSync(join(__dirname, "../components/listening/comment-sentiment-panel.tsx"), "utf8");
  const page = readFileSync(join(__dirname, "../app/dashboard/listening/page.tsx"), "utf8");
  const thread = readFileSync(join(__dirname, "../components/comments/comment-thread.tsx"), "utf8");
  const automation = readFileSync(join(__dirname, "../components/comments/comment-automation.tsx"), "utf8");

  it("the Listening page has a Comments view reachable by ?view=comments, inside a Suspense boundary", () => {
    expect(page).toMatch(/searchParams\.get\("view"\) === "comments"/);
    expect(page).toMatch(/<CommentSentimentPanel \/>/);
    expect(page).toMatch(/<Suspense fallback=\{null\}>\s*<ListeningPageInner \/>/);
  });

  it("unscored comments are shown as waiting, never as neutral", () => {
    expect(panel).toMatch(/"Waiting"/);
    expect(panel).not.toMatch(/sentiment \?\? "NEUTRAL"|\?\? "neutral"/);
  });

  it("every comment links to its thread to act on it", () => {
    expect(panel).toMatch(/commentThreadHref\(c\.channelId, c\.postTargetId\)/);
  });

  it("the comment thread shows the scored sentiment tag", () => {
    expect(thread).toMatch(/data-testid="comment-sentiment"/);
    expect(thread).toMatch(/sentimentKey\(sentiments\[c\.id\]\?\.sentiment\)/);
  });

  it("the Automation tab saves the switch", () => {
    expect(automation).toMatch(/sentimentEnabled: sentiment,/);
    expect(automation).toMatch(/data-testid="sentiment-switch"/);
  });
});
