import { describe, it, expect } from "vitest";
import { parseGraphTimestamp } from "./graph-time";

describe("parseGraphTimestamp", () => {
  it("parses Graph's basic-format offset (+0000) by normalising it to +00:00", () => {
    const d = parseGraphTimestamp("2026-09-19T10:00:00+0000");
    expect(d?.toISOString()).toBe("2026-09-19T10:00:00.000Z");
  });

  it("honours a non-zero offset", () => {
    expect(parseGraphTimestamp("2026-09-19T15:30:00+0530")?.toISOString()).toBe("2026-09-19T10:00:00.000Z");
    expect(parseGraphTimestamp("2026-09-19T05:00:00-0500")?.toISOString()).toBe("2026-09-19T10:00:00.000Z");
  });

  it("leaves an already-extended offset or a Z timestamp alone", () => {
    expect(parseGraphTimestamp("2026-09-19T10:00:00+00:00")?.toISOString()).toBe("2026-09-19T10:00:00.000Z");
    expect(parseGraphTimestamp("2026-09-19T10:00:00Z")?.toISOString()).toBe("2026-09-19T10:00:00.000Z");
  });

  it("returns null instead of an Invalid Date for empty or garbage input", () => {
    expect(parseGraphTimestamp("")).toBeNull();
    expect(parseGraphTimestamp(null)).toBeNull();
    expect(parseGraphTimestamp(undefined)).toBeNull();
    expect(parseGraphTimestamp("not a date")).toBeNull();
  });
});
