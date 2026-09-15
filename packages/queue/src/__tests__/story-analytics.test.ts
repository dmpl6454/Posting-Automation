import { describe, it, expect } from "vitest";
import {
  STORY_LIFETIME_MS,
  STORY_CHECKPOINT_DELAY_MS,
  AT_AGE_WINDOWS,
  isStoryTargetFormat,
  atAgeWindowsForFormat,
  shouldReconcileCheckpoints,
  excludeExpiredStoriesWhere,
} from "../story-analytics";

describe("atAgeWindowsForFormat", () => {
  it("keeps all four checkpoints, with byte-identical delays, for every non-story format", () => {
    for (const f of [null, undefined, "FEED", "REEL", "SHORT", "VIDEO", "CAROUSEL"]) {
      expect(atAgeWindowsForFormat(f), String(f)).toEqual([
        ["24h", 86_400_000],
        ["7d", 604_800_000],
        ["15d", 1_296_000_000],
        ["30d", 2_592_000_000],
      ]);
    }
  });

  it("a STORY gets ONE checkpoint, an hour BEFORE it expires", () => {
    // 24h would land after Meta stops serving the story's insights — the capture
    // would fail, burn all three one-shot attempts, and store nothing.
    expect(atAgeWindowsForFormat("STORY")).toEqual([["24h", STORY_CHECKPOINT_DELAY_MS]]);
    expect(STORY_CHECKPOINT_DELAY_MS).toBeLessThan(STORY_LIFETIME_MS);
    expect(atAgeWindowsForFormat("story")).toEqual([["24h", STORY_CHECKPOINT_DELAY_MS]]);
  });

  it("returns a fresh array so a caller cannot mutate the shared constant", () => {
    const a = atAgeWindowsForFormat("FEED");
    a.pop();
    expect(atAgeWindowsForFormat("FEED")).toHaveLength(AT_AGE_WINDOWS.length);
  });
});

describe("shouldReconcileCheckpoints", () => {
  it("never re-enqueues a story checkpoint — an overdue one is post-expiry by definition", () => {
    expect(shouldReconcileCheckpoints("STORY")).toBe(false);
    for (const f of [null, undefined, "FEED", "REEL", "SHORT"]) {
      expect(shouldReconcileCheckpoints(f), String(f)).toBe(true);
    }
  });
});

describe("excludeExpiredStoriesWhere", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const cutoff = new Date(now.getTime() - STORY_LIFETIME_MS);

  it("states the NULL case EXPLICITLY — a bare NOT would drop every legacy target", () => {
    // PostTarget.format is nullable and nearly every existing row is NULL, so
    // `NOT (format = 'STORY' AND ...)` evaluates to NULL and excludes the row.
    const where = excludeExpiredStoriesWhere(now);
    expect(where).toEqual({
      OR: [{ format: null }, { format: { not: "STORY" } }, { format: "STORY", publishedAt: { gte: cutoff } }],
    });
    expect(where.OR.some((b) => b.format === null)).toBe(true);
  });

  it("is expressed as OR branches, never as a top-level NOT", () => {
    expect(excludeExpiredStoriesWhere(now)).not.toHaveProperty("NOT");
  });

  it("moves the cutoff with `now`", () => {
    const later = new Date(now.getTime() + 3_600_000);
    const branch = excludeExpiredStoriesWhere(later).OR[2] as { publishedAt: { gte: Date } };
    expect(branch.publishedAt.gte).toEqual(new Date(later.getTime() - STORY_LIFETIME_MS));
  });
});

describe("isStoryTargetFormat", () => {
  it("is case-insensitive and null-safe", () => {
    expect(isStoryTargetFormat("STORY")).toBe(true);
    expect(isStoryTargetFormat("story")).toBe(true);
    expect(isStoryTargetFormat(null)).toBe(false);
    expect(isStoryTargetFormat(undefined)).toBe(false);
    expect(isStoryTargetFormat("REEL")).toBe(false);
  });
});
