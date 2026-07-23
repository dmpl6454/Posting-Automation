import { describe, it, expect } from "vitest";
import { toCsv } from "../lib/report-csv";

// report-csv.ts intentionally replicates apps/web/lib/csv.ts (the web lib is not
// importable from packages/api). This locks the formula-injection guard —
// including the leading-whitespace bypass — so the two stay in sync.
describe("report-csv toCsv formula guard", () => {
  it("neutralizes leading formula chars", () => {
    expect(toCsv(["p"], [["=HYPERLINK(\"http://evil\")"]])).toBe(
      '"p"\n"\'=HYPERLINK(""http://evil"")"'
    );
    expect(toCsv(["p"], [["+1"], ["-lead"], ["@h"]])).toBe('"p"\n"\'+1"\n"\'-lead"\n"\'@h"');
  });

  it("neutralizes a formula behind leading whitespace", () => {
    expect(toCsv(["p"], [[" =cmd"]])).toBe('"p"\n"\' =cmd"');
    expect(toCsv(["p"], [["\t=cmd"]])).toBe('"p"\n"\'\t=cmd"');
  });

  it("leaves numbers (incl. negatives) and normal strings untouched", () => {
    expect(toCsv(["n"], [[-7], [0]])).toBe('"n"\n"-7"\n"0"');
    expect(toCsv(["p"], [["hello = world"]])).toBe('"p"\n"hello = world"');
  });
});
