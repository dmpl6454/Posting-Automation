import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reddit comments + YouTube in social listening (2026-10-05): the page offers
 * YouTube as a source and shows which post/video a comment was left on.
 */
const page = readFileSync(join(__dirname, "../app/dashboard/listening/page.tsx"), "utf8");

describe("listening sources", () => {
  it("offers YouTube and says Reddit includes comments", () => {
    expect(page).toMatch(/\{ id: "youtube", label: "YouTube \(videos \+ comments\)" \}/);
    expect(page).toMatch(/\{ id: "reddit", label: "Reddit \(posts \+ comments\)" \}/);
  });

  it("a comment mention shows its post/video, linking only an https URL", () => {
    expect(page).toMatch(/m\.kind !== "comment"/);
    expect(page).toMatch(/\/\^https:\\\/\\\/\/i\.test\(m\.parentUrl\)/);
    expect(page).toMatch(/data-testid="mention-comment-on"/);
  });

  it("explains the YouTube cadence and budget", () => {
    expect(page).toMatch(/every 6 hours per query/);
    expect(page).toMatch(/daily YouTube API budget/);
  });
});
