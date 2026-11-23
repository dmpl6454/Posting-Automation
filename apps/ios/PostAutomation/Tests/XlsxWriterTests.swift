import XCTest
@testable import PostAutomation

/// Insights → Reports "Export Excel": the writer's output is read back (a tiny
/// ZIP reader below), so a broken archive or malformed XML fails here.
final class XlsxWriterTests: XCTestCase {

    /// Minimal ZIP reader: local headers in order → [name: uncompressed data].
    private func unzip(_ d: Data) throws -> [String: Data] {
        let b = [UInt8](d)
        func u16(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
        func u32(_ i: Int) -> Int { u16(i) | u16(i + 2) << 16 }
        var out: [String: Data] = [:]
        var i = 0
        while i + 4 <= b.count, u32(i) == 0x0403_4B50 {
            let method = u16(i + 8), crc = UInt32(u32(i + 14)), csize = u32(i + 18), usize = u32(i + 22)
            let nlen = u16(i + 26), elen = u16(i + 28)
            let name = String(decoding: b[(i + 30)..<(i + 30 + nlen)], as: UTF8.self)
            let start = i + 30 + nlen + elen
            let body = Data(b[start..<(start + csize)])
            let data: Data = method == 8 ? try (body as NSData).decompressed(using: .zlib) as Data : body
            XCTAssertEqual(data.count, usize, name)
            XCTAssertEqual(Zip.crc32(data), crc, "crc of \(name)")
            out[name] = data
            i = start + csize
        }
        XCTAssertEqual(u32(i), 0x0201_4B50, "central directory follows the entries")
        return out
    }

    private func sheetXML(_ data: Data) throws -> String {
        let files = try unzip(data)
        XCTAssertNotNil(files["[Content_Types].xml"])
        XCTAssertNotNil(files["xl/workbook.xml"])
        return String(decoding: try XCTUnwrap(files["xl/worksheets/sheet1.xml"]), as: UTF8.self)
    }

    func testCrc32KnownValue() {
        XCTAssertEqual(Zip.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testColumnLetters() {
        XCTAssertEqual(XlsxWriter.columnLetter(0), "A")
        XCTAssertEqual(XlsxWriter.columnLetter(25), "Z")
        XCTAssertEqual(XlsxWriter.columnLetter(26), "AA")
        XCTAssertEqual(XlsxWriter.columnLetter(701), "ZZ")
    }

    func testXmlTextEscapesAndDropsForbiddenCharacters() {
        XCTAssertEqual(XlsxWriter.xmlText("a<b>&\"c\u{0}\u{1}d\u{FFFE}"), "a&lt;b&gt;&amp;&quot;cd")
        XCTAssertEqual(XlsxWriter.xmlText("ok 🎬 नमस्ते"), "ok 🎬 नमस्ते")
    }

    func testSafeLink() {
        XCTAssertTrue(XlsxWriter.safeLink("https://www.instagram.com/p/abc/"))
        XCTAssertFalse(XlsxWriter.safeLink("javascript:alert(1)"))
        XCTAssertFalse(XlsxWriter.safeLink("https://a.com/x y"))
        XCTAssertFalse(XlsxWriter.safeLink("https://a.com/\u{2028}x"))
    }

    func testExcelSerialIsUTC() {
        // 2026-01-01T00:00:00Z → 46023
        XCTAssertEqual(XlsxWriter.excelSerial(Date(timeIntervalSince1970: 1_767_225_600)), 46023, accuracy: 1e-9)
    }

    func testWorkbookRoundTripsWithTypedCells() throws {
        let cols: [XlsxWriter.Column] = [
            .init(header: "Post", kind: .text), .init(header: "When", kind: .date),
            .init(header: "Likes", kind: .number), .init(header: "Eng", kind: .percent),
            .init(header: "URL", kind: .link),
        ]
        let rows: [[XlsxWriter.Cell]] = [
            [.text("=HYPERLINK(\"x\") <b>"), .date(Date(timeIntervalSince1970: 1_767_225_600)), .number(0), .number(2.5), .text("https://x.com/p/1")],
            [.text("second"), .empty, .empty, .empty, .text("javascript:alert(1)")],
        ]
        let data = XlsxWriter.build(sheetName: "Re/port", columns: cols, rows: rows)
        let files = try unzip(data)
        let sheet = try sheetXML(data)

        // Text is an inline string — never a formula.
        XCTAssertFalse(sheet.contains("<f>"))
        XCTAssertTrue(sheet.contains("=HYPERLINK(&quot;x&quot;) &lt;b&gt;"))
        XCTAssertTrue(sheet.contains(#"<c r="B2" s="2"><v>46023</v></c>"#), "a real date")
        XCTAssertTrue(sheet.contains(#"<c r="C2" s="3"><v>0</v></c>"#), "a real zero stays 0")
        XCTAssertTrue(sheet.contains(#"<c r="D2" s="4"><v>2.5</v></c>"#))
        XCTAssertFalse(sheet.contains(#"r="C3""#), "nil is an empty cell, not 0")
        XCTAssertTrue(sheet.contains(#"<hyperlink ref="E2" r:id="rId1"/>"#))
        XCTAssertFalse(sheet.contains(#"ref="E3""#), "unsafe URL is not a hyperlink")
        XCTAssertTrue(sheet.contains(#"<autoFilter ref="A1:E3"/>"#))
        let rels = String(decoding: try XCTUnwrap(files["xl/worksheets/_rels/sheet1.xml.rels"]), as: UTF8.self)
        XCTAssertTrue(rels.contains(#"Target="https://x.com/p/1" TargetMode="External""#))
        let wb = String(decoding: try XCTUnwrap(files["xl/workbook.xml"]), as: UTF8.self)
        XCTAssertTrue(wb.contains(#"<sheet name="Re port""#), "sheet name sanitized")
    }

    // MARK: Report rows

    private func row(_ id: String, at: String?, likes: Int?) -> ReportRow {
        let atJSON = at.map { "\"\($0)\"" } ?? "null"
        let likesJSON = likes.map(String.init) ?? "null"
        let json = #"{"targetId":"\#(id)","postId":"p","contentPreview":"Hi","channelName":"Ch","channelUsername":"ch","platform":"INSTAGRAM","publishedAt":\#(atJSON),"publishedUrl":"https://www.instagram.com/p/\#(id)/","likes":\#(likesJSON),"views":0,"engagementRate":1.25,"snapshotAt":null}"#
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom(TRPCClient.decodeDate)
        return try! d.decode(ReportRow.self, from: Data(json.utf8))
    }

    func testNextReportCursor() {
        let page = [row("c", at: "2026-11-03T10:00:00.123Z", likes: 1),
                    row("b", at: "2026-11-02T10:00:00.000Z", likes: 1),
                    row("a", at: "2026-11-01T10:00:00.000Z", likes: 1)]
        let more = InsightsRules.nextReportCursor(page, pageSize: 2)
        XCTAssertEqual(more.rows.map(\.targetId), ["c", "b"])
        XCTAssertEqual(more.cursor, .init(publishedAt: "2026-11-02T10:00:00.000Z", targetId: "b"))

        let last = InsightsRules.nextReportCursor(Array(page.prefix(2)), pageSize: 2)
        XCTAssertEqual(last.rows.count, 2)
        XCTAssertNil(last.cursor, "a short page is the last page")
    }

    func testReportXlsxHasLinksAndBlanksForMissingMetrics() throws {
        let data = InsightsRules.reportXlsx(
            [row("t1", at: "2026-11-03T10:00:00.000Z", likes: nil), row("t2", at: nil, likes: 7)],
            metrics: [.views, .likes]
        )
        let sheet = try sheetXML(data)
        XCTAssertTrue(sheet.contains("Post URL"))
        XCTAssertTrue(sheet.contains("@ch"))
        XCTAssertTrue(sheet.contains(#"<hyperlink ref="G2""#), "post link is clickable")
        XCTAssertTrue(sheet.contains(#"<c r="H2" s="3"><v>0</v></c>"#), "views 0 stays 0")
        XCTAssertFalse(sheet.contains(#"r="I2""#), "unreported likes is blank, not 0")
        XCTAssertTrue(sheet.contains(#"<c r="I3" s="3"><v>7</v></c>"#))
        XCTAssertTrue(sheet.contains(#"<c r="J2" s="4"><v>1.25</v></c>"#))
    }
}
