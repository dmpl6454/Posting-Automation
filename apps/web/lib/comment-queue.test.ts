import { describe, it, expect } from "vitest";
import { addDone, DONE_TTL_MS, parseDoneMap, removeDone } from "./comment-queue";

const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("comment queue Done store", () => {
  it("parses a stored map and drops entries past the TTL", () => {
    const raw = JSON.stringify({ a: NOW - 1000, old: NOW - DONE_TTL_MS - 1 });
    expect(parseDoneMap(raw, NOW)).toEqual({ a: NOW - 1000 });
  });

  it("garbage, arrays and wrong value types never throw and never survive", () => {
    expect(parseDoneMap("{not json", NOW)).toEqual({});
    expect(parseDoneMap("[1,2]", NOW)).toEqual({});
    expect(parseDoneMap(JSON.stringify({ a: "yesterday", b: null, c: NOW }), NOW)).toEqual({ c: NOW });
    expect(parseDoneMap(null, NOW)).toEqual({});
  });

  it("add / remove are pure and remove of an unknown id returns the same map", () => {
    const m = addDone({}, "x", NOW);
    expect(m).toEqual({ x: NOW });
    expect(removeDone(m, "x")).toEqual({});
    expect(removeDone(m, "nope")).toBe(m);
  });

  it("keeps only the newest 2000 entries", () => {
    let m: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) m[`id${i}`] = NOW - 10_000 + i;
    m = addDone(m, "newest", NOW);
    expect(Object.keys(m)).toHaveLength(2000);
    expect(m.newest).toBe(NOW);
    expect(m.id0).toBeUndefined();
  });
});
