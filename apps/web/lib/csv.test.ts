import { describe, it, expect } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("escapes inner quotes and handles nulls/undefined as empty", () => {
    expect(toCsv(["a", "b"], [['say "hi"', null], [1, undefined]])).toBe(
      '"a","b"\n"say ""hi""",""\n"1",""'
    );
  });

  it("keeps commas and newlines safe inside quoted fields", () => {
    const csv = toCsv(["post"], [["line1\nline2, with comma"]]);
    expect(csv).toBe('"post"\n"line1\nline2, with comma"');
  });

  it("serializes numbers", () => {
    expect(toCsv(["n"], [[0], [42]])).toBe('"n"\n"0"\n"42"');
  });
});
