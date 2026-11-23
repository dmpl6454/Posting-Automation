/**
 * Minimal Excel (.xlsx) writer for the Insights → Reports "Export Excel"
 * (2026-11-23). An .xlsx is a ZIP of SpreadsheetML XML parts, so this needs no
 * dependency: it builds the parts and hands them to lib/zip.ts. Pure + tested
 * (xlsx.test.ts parses the output back).
 *
 * One sheet, typed cells (text / number / date / percent / link), a bold
 * frozen header row, an autofilter, and column widths.
 *
 * SECURITY: text goes in as an inline string (`t="inlineStr"`), which Excel
 * never evaluates — only an <f> element is a formula — so the CSV export's
 * `'`-prefix formula guard is unnecessary here and would corrupt the text.
 * Link cells use a REAL hyperlink only for an http(s) URL with no whitespace or
 * control characters; anything else is written as plain text.
 */
import { buildZipCompressed, type ZipEntry } from "./zip";

export type CellKind = "text" | "number" | "date" | "percent" | "link";

export interface XlsxColumn {
  header: string;
  kind: CellKind;
  /** Approximate width in characters. */
  width?: number;
}

export type CellValue = string | number | Date | null | undefined;

/** Excel limits. */
const MAX_CELL_CHARS = 32_767;
const MAX_HYPERLINKS = 65_530;

/** Remove characters XML 1.0 forbids (and lone surrogates), then escape. */
export function xmlText(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return cleaned.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel serial date (days since 1899-12-30), in UTC — report dates are UTC. */
export function excelSerial(d: Date): number {
  return d.getTime() / 86_400_000 + 25_569;
}

/** A URL that is safe to make clickable. */
export function safeLink(v: string): boolean {
  return /^https?:\/\//i.test(v) && !/[\s\u0000-\u001F\u007F\u2028\u2029]/.test(v) && v.length <= 2_000;
}

function toDate(v: CellValue): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Style ids (cellXfs order in STYLES below).
const S_HEADER = 1;
const S_DATE = 2;
const S_INT = 3;
const S_PCT = 4;
const S_LINK = 5;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function textCell(ref: string, v: string, style?: number): string {
  const t = xmlText(v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) : v);
  return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${t}</t></is></c>`;
}

/**
 * Build the parts of a one-sheet workbook. Exposed separately from the ZIP
 * step so tests can inspect the XML.
 */
export function buildXlsxParts(sheetName: string, columns: XlsxColumn[], rows: CellValue[][]): ZipEntry[] {
  const safeSheet = xmlText(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report");
  const lastCol = columnLetter(Math.max(0, columns.length - 1));
  const lastRow = rows.length + 1;
  const links: { ref: string; target: string }[] = [];

  const out: string[] = [];
  out.push(
    `<row r="1">${columns.map((c, i) => textCell(`${columnLetter(i)}1`, c.header, S_HEADER)).join("")}</row>`
  );
  rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells: string[] = [];
    columns.forEach((col, ci) => {
      const v = row[ci];
      if (v === null || v === undefined || v === "") return;
      const ref = `${columnLetter(ci)}${r}`;
      if (col.kind === "date") {
        const d = toDate(v);
        cells.push(d ? `<c r="${ref}" s="${S_DATE}"><v>${excelSerial(d)}</v></c>` : textCell(ref, String(v)));
      } else if ((col.kind === "number" || col.kind === "percent") && typeof v === "number" && Number.isFinite(v)) {
        const style = col.kind === "percent" ? S_PCT : Number.isInteger(v) ? S_INT : 0;
        cells.push(`<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>`);
      } else if (col.kind === "link" && typeof v === "string" && safeLink(v) && links.length < MAX_HYPERLINKS) {
        links.push({ ref, target: v });
        cells.push(textCell(ref, v, S_LINK));
      } else {
        cells.push(textCell(ref, v instanceof Date ? v.toISOString() : String(v)));
      }
    });
    out.push(`<row r="${r}">${cells.join("")}</row>`);
  });

  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`)
    .join("");
  const hyperlinks = links.length
    ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>`
    : "";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${out.join("")}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>${hyperlinks}
</worksheet>`;

  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links
    .map(
      (l, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlText(l.target)}" TargetMode="External"/>`
    )
    .join("")}</Relationships>`;

  return [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${safeSheet.replace(/'/g, "''")}'!$A$1:$${lastCol}$${lastRow}</definedName></definedNames></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: sheetRels },
  ];
}

export async function buildXlsx(sheetName: string, columns: XlsxColumn[], rows: CellValue[][]): Promise<Uint8Array> {
  return buildZipCompressed(buildXlsxParts(sheetName, columns, rows));
}

/** Trigger a browser download of an .xlsx byte array. */
export function downloadXlsx(filename: string, bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
