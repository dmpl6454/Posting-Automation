import Foundation

/// Minimal Excel (.xlsx) writer — a Swift port of apps/web/lib/xlsx.ts, used by
/// Insights → Reports "Export Excel" (2026-11-23). An .xlsx is a ZIP of
/// SpreadsheetML parts, so this needs no dependency. Pure + tested
/// (XlsxWriterTests parses the output back).
///
/// One sheet, typed cells (text / number / date / percent / link), a bold
/// frozen header row, an autofilter and column widths.
///
/// SECURITY: text is written as an inline string (`t="inlineStr"`), which Excel
/// never evaluates — only an <f> element is a formula — so the CSV export's
/// `'`-prefix guard is unnecessary here and would corrupt the text. Link cells
/// become a REAL hyperlink only for an http(s) URL with no whitespace or
/// control characters; anything else is plain text.
enum XlsxWriter {
    enum Kind { case text, number, date, percent, link }

    struct Column {
        var header: String
        var kind: Kind
        var width: Int = 14
    }

    enum Cell {
        case empty
        case text(String)
        case number(Double)
        case date(Date)
    }

    static let maxCellChars = 32_767
    static let maxHyperlinks = 65_530

    // MARK: Helpers (internal for tests)

    /// Drop characters XML 1.0 forbids, then escape.
    static func xmlText(_ raw: String) -> String {
        var out = ""
        out.reserveCapacity(raw.utf8.count)
        for scalar in raw.unicodeScalars {
            let v = scalar.value
            let allowed = v == 0x9 || v == 0xA || v == 0xD || (v >= 0x20 && v <= 0xD7FF)
                || (v >= 0xE000 && v <= 0xFFFD) || v >= 0x10000
            guard allowed else { continue }
            switch scalar {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// 0 → "A", 25 → "Z", 26 → "AA".
    static func columnLetter(_ index: Int) -> String {
        var n = index + 1
        var s = ""
        while n > 0 {
            let r = (n - 1) % 26
            s = String(UnicodeScalar(UInt8(65 + r))) + s
            n = (n - 1) / 26
        }
        return s
    }

    /// Excel serial date (days since 1899-12-30), UTC — report dates are UTC.
    static func excelSerial(_ d: Date) -> Double {
        d.timeIntervalSince1970 / 86_400 + 25_569
    }

    /// A URL that is safe to make clickable.
    static func safeLink(_ v: String) -> Bool {
        let lower = v.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://"), v.count <= 2_000 else { return false }
        return !v.unicodeScalars.contains { s in
            s.properties.isWhitespace || s.value < 0x20 || s.value == 0x7F || s.value == 0x2028 || s.value == 0x2029
        }
    }

    private static func number(_ v: Double) -> String {
        if v == v.rounded(), abs(v) < 1e15 { return String(Int64(v)) }
        return String(v)
    }

    // Style ids (cellXfs order in `styles`).
    private static let sHeader = 1, sDate = 2, sInt = 3, sPct = 4, sLink = 5

    private static let styles = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\
    <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>\
    <fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>\
    <font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>\
    <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>\
    <fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>\
    <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
    <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>\
    <cellXfs count="6">\
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>\
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>\
    <xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>\
    <xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>\
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>\
    </cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>
    """

    private static func textCell(_ ref: String, _ v: String, style: Int = 0) -> String {
        let clipped = v.count > maxCellChars ? String(v.prefix(maxCellChars)) : v
        return "<c r=\"\(ref)\"\(style > 0 ? " s=\"\(style)\"" : "") t=\"inlineStr\"><is><t xml:space=\"preserve\">\(xmlText(clipped))</t></is></c>"
    }

    // MARK: Workbook

    /// The parts of a one-sheet workbook, before zipping (tests inspect these).
    static func parts(sheetName: String, columns: [Column], rows: [[Cell]]) -> [(name: String, data: Data)] {
        let forbidden = CharacterSet(charactersIn: "\\/?*[]:")
        let cleanedName = String(String(sheetName.unicodeScalars.map { forbidden.contains($0) ? " " : Character($0) }).prefix(31))
        let safeSheet = xmlText(cleanedName.isEmpty ? "Report" : cleanedName)
        let lastCol = columnLetter(max(0, columns.count - 1))
        let lastRow = rows.count + 1
        var links: [(ref: String, target: String)] = []

        var sheetData = "<row r=\"1\">"
        for (i, c) in columns.enumerated() { sheetData += textCell("\(columnLetter(i))1", c.header, style: sHeader) }
        sheetData += "</row>"

        for (ri, row) in rows.enumerated() {
            let r = ri + 2
            sheetData += "<row r=\"\(r)\">"
            for (ci, col) in columns.enumerated() {
                guard ci < row.count else { continue }
                let ref = "\(columnLetter(ci))\(r)"
                switch (row[ci], col.kind) {
                case (.empty, _):
                    continue
                case (.text(let s), _) where s.isEmpty:
                    continue
                case (.date(let d), _):
                    sheetData += "<c r=\"\(ref)\" s=\"\(sDate)\"><v>\(number(excelSerial(d)))</v></c>"
                case (.number(let v), .percent) where v.isFinite:
                    sheetData += "<c r=\"\(ref)\" s=\"\(sPct)\"><v>\(number(v))</v></c>"
                case (.number(let v), _) where v.isFinite:
                    let style = v == v.rounded() ? sInt : 0
                    sheetData += "<c r=\"\(ref)\"\(style > 0 ? " s=\"\(style)\"" : "")><v>\(number(v))</v></c>"
                case (.text(let s), .link) where safeLink(s) && links.count < maxHyperlinks:
                    links.append((ref, s))
                    sheetData += textCell(ref, s, style: sLink)
                case (.text(let s), _):
                    sheetData += textCell(ref, s)
                case (.number(let v), _):
                    sheetData += textCell(ref, String(v))
                }
            }
            sheetData += "</row>"
        }

        let cols = columns.enumerated()
            .map { "<col min=\"\($0.offset + 1)\" max=\"\($0.offset + 1)\" width=\"\($0.element.width)\" customWidth=\"1\"/>" }
            .joined()
        let hyperlinks = links.isEmpty ? "" : "<hyperlinks>"
            + links.enumerated().map { "<hyperlink ref=\"\($0.element.ref)\" r:id=\"rId\($0.offset + 1)\"/>" }.joined()
            + "</hyperlinks>"
        let sheet = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" \
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\
        <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>\
        <cols>\(cols)</cols><sheetData>\(sheetData)</sheetData>\
        <autoFilter ref="A1:\(lastCol)\(lastRow)"/>\(hyperlinks)</worksheet>
        """
        let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        let sheetRels = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
        \(links.enumerated().map { "<Relationship Id=\"rId\($0.offset + 1)\" Type=\"\(rel)/hyperlink\" Target=\"\(xmlText($0.element.target))\" TargetMode=\"External\"/>" }.joined())\
        </Relationships>
        """
        let contentTypes = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
        <Default Extension="xml" ContentType="application/xml"/>\
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\
        <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>
        """
        let rootRels = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
        <Relationship Id="rId1" Type="\(rel)/officeDocument" Target="xl/workbook.xml"/></Relationships>
        """
        let quotedSheet = safeSheet.replacingOccurrences(of: "'", with: "''")
        let workbook = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="\(rel)">\
        <sheets><sheet name="\(safeSheet)" sheetId="1" r:id="rId1"/></sheets>\
        <definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\
        '\(quotedSheet)'!$A$1:$\(lastCol)$\(lastRow)</definedName></definedNames></workbook>
        """
        let workbookRels = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
        <Relationship Id="rId1" Type="\(rel)/worksheet" Target="worksheets/sheet1.xml"/>\
        <Relationship Id="rId2" Type="\(rel)/styles" Target="styles.xml"/></Relationships>
        """
        return [
            ("[Content_Types].xml", Data(contentTypes.utf8)),
            ("_rels/.rels", Data(rootRels.utf8)),
            ("xl/workbook.xml", Data(workbook.utf8)),
            ("xl/_rels/workbook.xml.rels", Data(workbookRels.utf8)),
            ("xl/styles.xml", Data(styles.utf8)),
            ("xl/worksheets/sheet1.xml", Data(sheet.utf8)),
            ("xl/worksheets/_rels/sheet1.xml.rels", Data(sheetRels.utf8)),
        ]
    }

    static func build(sheetName: String, columns: [Column], rows: [[Cell]]) -> Data {
        Zip.archive(parts(sheetName: sheetName, columns: columns, rows: rows))
    }
}

/// A minimal ZIP writer (no ZIP64 — an .xlsx part is far under 4 GB). Each
/// entry is DEFLATE-compressed when that is smaller, else stored.
enum Zip {
    static func archive(_ entries: [(name: String, data: Data)]) -> Data {
        var out = Data()
        var central = Data()
        for e in entries {
            let nameBytes = Data(e.name.utf8)
            let crc = crc32(e.data)
            let deflated = (try? (e.data as NSData).compressed(using: .zlib)) as Data?
            let useDeflate = deflated.map { $0.count < e.data.count } ?? false
            let body = useDeflate ? deflated! : e.data
            let method: UInt16 = useDeflate ? 8 : 0
            let offset = UInt32(out.count)

            var local = Data()
            local.le32(0x0403_4B50); local.le16(20); local.le16(0x0800) // UTF-8 names
            local.le16(method); local.le16(0); local.le16(0x21) // 1980-01-01
            local.le32(crc); local.le32(UInt32(body.count)); local.le32(UInt32(e.data.count))
            local.le16(UInt16(nameBytes.count)); local.le16(0)
            out.append(local); out.append(nameBytes); out.append(body)

            central.le32(0x0201_4B50); central.le16(20); central.le16(20); central.le16(0x0800)
            central.le16(method); central.le16(0); central.le16(0x21)
            central.le32(crc); central.le32(UInt32(body.count)); central.le32(UInt32(e.data.count))
            central.le16(UInt16(nameBytes.count)); central.le16(0); central.le16(0)
            central.le16(0); central.le16(0); central.le32(0); central.le32(offset)
            central.append(nameBytes)
        }
        let centralOffset = UInt32(out.count)
        out.append(central)
        out.le32(0x0605_4B50); out.le16(0); out.le16(0)
        out.le16(UInt16(entries.count)); out.le16(UInt16(entries.count))
        out.le32(UInt32(central.count)); out.le32(centralOffset); out.le16(0)
        return out
    }

    private static let table: [UInt32] = (0..<256).map { i in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { buf in
            for b in buf { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        }
        return c ^ 0xFFFF_FFFF
    }
}

private extension Data {
    mutating func le16(_ v: UInt16) { Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) } }
    mutating func le32(_ v: UInt32) { Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) } }
}
