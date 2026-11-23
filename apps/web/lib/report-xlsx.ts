/**
 * Insights → Reports "Export Excel" (2026-11-23): typed columns for the SAME
 * header the CSV export builds (ReportsTab.fetchExportRows) — one column
 * builder, so the two exports can never disagree about which columns exist.
 * Pure + tested (report-xlsx.test.ts).
 */
import type { CellKind, XlsxColumn } from "./xlsx";

const KIND_BY_HEADER: Record<string, CellKind> = {
  Post: "text",
  Channel: "text",
  Handle: "text",
  Platform: "text",
  Campaign: "text",
  "Published At (UTC)": "date",
  "Metric captured at (UTC)": "date",
  "Post URL": "link",
  "Engagement %": "percent",
};

const WIDTH_BY_HEADER: Record<string, number> = {
  Post: 50,
  Channel: 24,
  Handle: 20,
  Platform: 12,
  Campaign: 18,
  "Published At (UTC)": 18,
  "Metric captured at (UTC)": 20,
  "Post URL": 48,
  "Engagement %": 13,
};

/** Every other column is a metric count. */
export function reportXlsxColumns(header: string[]): XlsxColumn[] {
  return header.map((h) => ({ header: h, kind: KIND_BY_HEADER[h] ?? "number", width: WIDTH_BY_HEADER[h] ?? 12 }));
}

/** Rows per page fetched for the export (server max is this + 1). */
export const REPORT_PAGE_SIZE = 2000;
/** Hard stop for one file — far under Excel's 1,048,576-row sheet limit. */
export const XLSX_MAX_ROWS = 100_000;

/**
 * Next keyset cursor from a page that was fetched with `limit = pageSize + 1`.
 * Returns null when this was the last page.
 */
export function nextReportCursor<R extends { publishedAt: Date | string | null; targetId: string }>(
  page: R[],
  pageSize: number = REPORT_PAGE_SIZE
): { cursor: { publishedAt: string; targetId: string } | null; rows: R[] } {
  const rows = page.slice(0, pageSize);
  if (page.length <= pageSize || rows.length === 0) return { cursor: null, rows };
  const last = rows[rows.length - 1]!;
  if (!last.publishedAt) return { cursor: null, rows };
  return { cursor: { publishedAt: new Date(last.publishedAt).toISOString(), targetId: last.targetId }, rows };
}
