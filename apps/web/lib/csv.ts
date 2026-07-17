/**
 * Minimal CSV serialization for the Insights → Reports export (2026-07-17).
 * Pure + testable (csv.test.ts). RFC-4180-style quoting: every field is quoted,
 * inner quotes doubled — safe for commas, newlines, and quotes in post content.
 */
/**
 * SECURITY — CSV/formula injection: post content is user-controlled; a cell
 * starting with = + - @ (or tab/CR) executes as a formula when the CSV is
 * opened in Excel/Sheets (e.g. =HYPERLINK exfiltration). Neutralize by
 * prefixing a single quote — the standard mitigation; spreadsheets render the
 * value as text.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function toCsv(
  header: string[],
  rows: (string | number | null | undefined)[][]
): string {
  const esc = (v: string | number | null | undefined) => {
    let s = String(v ?? "");
    if (typeof v === "string" && FORMULA_PREFIX.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [header.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

/** Trigger a browser download of a CSV string. The BOM makes Excel detect UTF-8. */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
