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

  it("serializes numbers (incl. negatives, which must NOT get the formula prefix)", () => {
    expect(toCsv(["n"], [[0], [42], [-7]])).toBe('"n"\n"0"\n"42"\n"-7"');
  });

  // SECURITY: cells starting with = + - @ \t \r would execute as formulas in
  // Excel/Sheets (CSV injection). String values get a neutralizing quote prefix.
  it("neutralizes formula-injection prefixes in string cells", () => {
    expect(toCsv(["p"], [["=HYPERLINK(\"http://evil\")"]])).toBe(
      '"p"\n"\'=HYPERLINK(""http://evil"")"'
    );
    expect(toCsv(["p"], [["+1234"], ["-lead"], ["@handle"]])).toBe(
      '"p"\n"\'+1234"\n"\'-lead"\n"\'@handle"'
    );
    // normal strings untouched
    expect(toCsv(["p"], [["hello = world"]])).toBe('"p"\n"hello = world"');
  });
});
