/**
 * Server-side CSV serialization for emailed Insights reports (2026-07-18).
 *
 * Replicates the formula-guarded serializer in apps/web/lib/csv.ts (the web
 * lib is not importable from packages/api — replicate, don't import; keep the
 * two in sync). RFC-4180-style quoting: every field is quoted, inner quotes
 * doubled — safe for commas, newlines, and quotes in post content.
 */

/**
 * SECURITY — CSV/formula injection: post content is user-controlled; a cell
 * starting with = + - @ (or tab/CR) executes as a formula when the CSV is
 * opened in Excel/Sheets (e.g. =HYPERLINK exfiltration). Neutralize by
 * prefixing a single quote — the standard mitigation; spreadsheets render the
 * value as text. Numbers (e.g. -7) are unaffected — only string cells guarded.
 * Leading whitespace is stripped before the test (Excel trims some leading
 * whitespace/nbsp before evaluating), so " =CMD" is still neutralized. Keep in
 * sync with apps/web/lib/csv.ts.
 */
const FORMULA_PREFIX = /^[=+\-@]/;

function needsFormulaGuard(s: string): boolean {
  const trimmed = s.replace(/^[\s \t\r]+/, "");
  return FORMULA_PREFIX.test(trimmed) || /^[\t\r]/.test(s);
}

export function toCsv(
  header: string[],
  rows: (string | number | null | undefined)[][]
): string {
  const esc = (v: string | number | null | undefined) => {
    let s = String(v ?? "");
    if (typeof v === "string" && needsFormulaGuard(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [header.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}
