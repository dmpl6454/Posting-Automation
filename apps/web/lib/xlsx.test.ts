import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildXlsx, buildXlsxParts, columnLetter, excelSerial, safeLink, xmlText } from "./xlsx";
import { reportXlsxColumns, nextReportCursor } from "./report-xlsx";

/** Minimal ZIP reader (local headers) that handles STORE and DEFLATE. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extra = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extra;
    const data = bytes.subarray(start, start + size);
    out[name] = new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data);
    p = start + size;
  }
  return out;
}

describe("xlsx helpers", () => {
  it("columnLetter", () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });
  it("excelSerial is UTC (1970-01-01 = 25569)", () => {
    expect(excelSerial(new Date("1970-01-01T00:00:00Z"))).toBe(25569);
    expect(excelSerial(new Date("2026-11-23T12:00:00Z"))).toBeCloseTo(46349.5, 6);
  });
  it("xmlText escapes markup and strips characters XML forbids", () => {
    expect(xmlText(`<b>&"x"</b>\u0001\u0008ok`)).toBe("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;ok");
    expect(xmlText("emoji 😀 kept")).toBe("emoji 😀 kept");
    expect(xmlText("lone \uD800 surrogate")).toBe("lone  surrogate");
  });
  it("safeLink only accepts plain http(s) URLs", () => {
    expect(safeLink("https://www.instagram.com/p/abc/")).toBe(true);
    expect(safeLink("javascript:alert(1)")).toBe(false);
    expect(safeLink("https://x.test/a b")).toBe(false);
    expect(safeLink("https://x.test/\nfake")).toBe(false);
  });
});

describe("buildXlsxParts", () => {
  const columns = reportXlsxColumns(["Post", "Platform", "Published At (UTC)", "Post URL", "Likes", "Engagement %"]);
  const parts = buildXlsxParts("Report", columns, [
    ["=HYPERLINK(\"http://evil\")", "INSTAGRAM", "2026-11-20T10:30:00.000Z", "https://www.instagram.com/p/abc/", 12, 3.456],
    ["plain", "FACEBOOK", "", "javascript:alert(1)", null, null],
  ]);
  const byName = Object.fromEntries(parts.map((p) => [p.name, String(p.data)]));
  const sheet = byName["xl/worksheets/sheet1.xml"]!;

  it("has every part Excel needs", () => {
    expect(Object.keys(byName).sort()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml",
      "xl/workbook.xml", "xl/worksheets/_rels/sheet1.xml.rels", "xl/worksheets/sheet1.xml",
    ]);
  });

  it("writes text as an inline string — never a formula", () => {
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://evil&quot;)</t>');
  });

  it("types dates, numbers and percents", () => {
    expect(sheet).toContain(`<c r="C2" s="2"><v>${excelSerial(new Date("2026-11-20T10:30:00.000Z"))}</v></c>`);
    expect(sheet).toContain('<c r="E2" s="3"><v>12</v></c>');
    expect(sheet).toContain('<c r="F2" s="4"><v>3.456</v></c>');
  });

  it("links only the safe URL, and leaves empty cells empty", () => {
    expect(sheet).toContain('<hyperlink ref="D2" r:id="rId1"/>');
    expect(sheet).not.toContain('ref="D3"');
    expect(byName["xl/worksheets/_rels/sheet1.xml.rels"]).toContain(
      'Target="https://www.instagram.com/p/abc/" TargetMode="External"'
    );
    expect(sheet).toContain('<c r="D3" t="inlineStr"><is><t xml:space="preserve">javascript:alert(1)</t>');
    expect(sheet).not.toContain('r="E3"'); // null metric ⇒ no cell (not a fake 0)
  });

  it("freezes and filters the header row", () => {
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:F3"/>');
    expect(byName["xl/workbook.xml"]).toContain("'Report'!$A$1:$F$3");
  });
});

describe("buildXlsx (compressed ZIP)", () => {
  it("round-trips through a real inflater", async () => {
    const cols = reportXlsxColumns(["Post", "Likes"]);
    const rows = Array.from({ length: 500 }, (_, i) => [`post number ${i}`, i]);
    const bytes = await buildXlsx("Report", cols, rows);
    const files = unzip(bytes);
    expect(files["xl/worksheets/sheet1.xml"]).toContain("post number 499");
    expect(files["[Content_Types].xml"]).toContain("spreadsheetml.sheet.main+xml");
  });
});

describe("nextReportCursor", () => {
  const row = (id: string, at: string) => ({ targetId: id, publishedAt: at });
  it("continues when the page came back over-full, from the last KEPT row", () => {
    const page = [row("a", "2026-11-03T00:00:00Z"), row("b", "2026-11-02T00:00:00Z"), row("c", "2026-11-01T00:00:00Z")];
    const r = nextReportCursor(page, 2);
    expect(r.rows.map((x) => x.targetId)).toEqual(["a", "b"]);
    expect(r.cursor).toEqual({ publishedAt: "2026-11-02T00:00:00.000Z", targetId: "b" });
  });
  it("stops on a short page", () => {
    expect(nextReportCursor([row("a", "2026-11-03T00:00:00Z")], 2).cursor).toBeNull();
  });
});
