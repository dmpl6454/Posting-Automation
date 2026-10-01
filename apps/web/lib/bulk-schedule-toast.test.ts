import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bulkScheduleToast } from "./bulk-schedule-toast";

/**
 * Bulk tab "Schedule" toast. bulk.bulkSchedule skips-and-COUNTS posts it must
 * not arm (skippedStories, skippedPending); a skip the toast does not mention is
 * a silent skip. Before 2026-10-01 a post skipped for a pending/held caption
 * fan-out produced "Scheduled — 0 post(s) scheduled successfully."
 */
describe("bulkScheduleToast", () => {
  it("plain success is unchanged", () => {
    expect(bulkScheduleToast({ scheduled: 3, skippedStories: 0, skippedPending: 0 })).toEqual({
      title: "Scheduled",
      description: "3 post(s) scheduled successfully.",
    });
  });

  it("names posts skipped for pending/held captions or super text", () => {
    const t = bulkScheduleToast({ scheduled: 2, skippedStories: 0, skippedPending: 1 });
    expect(t.title).toBe("Scheduled");
    expect(t.description).toContain("2 post(s) scheduled successfully.");
    expect(t.description).toContain("1 post(s) were skipped — unique captions");
    expect(t.description).toContain("on the post page");
  });

  it("keeps the story skip message", () => {
    expect(bulkScheduleToast({ scheduled: 1, skippedStories: 2 }).description).toContain(
      "2 Instagram stories were skipped — a story needs exactly one image or video."
    );
    expect(bulkScheduleToast({ scheduled: 1, skippedStories: 1 }).description).toContain("1 Instagram story was skipped");
  });

  it("never says 'Scheduled' or 'successfully' when nothing was scheduled", () => {
    const t = bulkScheduleToast({ scheduled: 0, skippedStories: 0, skippedPending: 2 });
    expect(t.title).not.toBe("Scheduled");
    expect(t.description).not.toContain("successfully");
    expect(t.description).toContain("2 post(s) were skipped");
  });

  it("tolerates an older server response without the skip counters", () => {
    expect(bulkScheduleToast({ scheduled: 1 })).toEqual({
      title: "Scheduled",
      description: "1 post(s) scheduled successfully.",
    });
  });
});

describe("BulkTab uses it (source lock)", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const src = readFileSync(join(ROOT, "apps/web/components/content-agent/BulkTab.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("the bulkSchedule success handler toasts the helper's result", () => {
    const start = src.indexOf("trpc.bulk.bulkSchedule.useMutation(");
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("onError", start));
    expect(handler).toMatch(/toast\(\s*bulkScheduleToast\(\s*result\s*\)\s*\)/);
    expect(handler).not.toMatch(/scheduled successfully/);
  });
});
