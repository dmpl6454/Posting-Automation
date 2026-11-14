import XCTest
@testable import PostAutomation

/// Insights (web-parity Phase 4, 2026-11-14) — same decisions as the web.
final class InsightsRulesTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) -> T {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom(TRPCClient.decodeDate)
        return try! d.decode(T.self, from: Data(json.utf8))
    }

    /// Base row with `extra` fields MERGED over it (a later duplicate key in raw
    /// JSON is not reliably the one a decoder keeps).
    private func channel(_ extra: String) -> ChannelStat {
        var base: [String: Any] = ["id": "c", "name": "Chan", "platform": "INSTAGRAM", "postCount": 3, "impressions": 100,
                                   "views": 100, "reach": 40, "likes": 0, "comments": 2, "shares": 1, "clicks": 0]
        let over = try! JSONSerialization.jsonObject(with: Data("{\(extra.drop(while: { $0 == "," }))}".utf8)) as! [String: Any]
        base.merge(over) { _, new in new }
        let data = try! JSONSerialization.data(withJSONObject: base)
        return decode(String(decoding: data, as: UTF8.self))
    }

    func testDashMeansNotReportedAndZeroStaysZero() {
        let ch = channel(#","hasSnapshot":true,"unavailable":["impressions","clicks"],"reachIsDistinct":true"#)
        XCTAssertNil(InsightsRules.cellValue(.impressions, ch))
        XCTAssertNil(InsightsRules.cellValue(.clicks, ch))
        XCTAssertEqual(InsightsRules.cellValue(.likes, ch), 0, "a captured 0 is a real 0")
        XCTAssertEqual(InsightsRules.cellValue(.views, ch), 100)
    }

    func testNothingCapturedYetIsDashEverywhere() {
        let ch = channel(#","hasSnapshot":false"#)
        XCTAssertNil(InsightsRules.cellValue(.views, ch))
    }

    func testReachThatIsJustImpressionsIsDash() {
        XCTAssertNil(InsightsRules.cellValue(.reach, channel(#","hasSnapshot":true,"reachIsDistinct":false"#)))
    }

    func testUnknownMetricNamesAndOddFieldsDontBreakDecoding() {
        let ch = channel(#","unavailable":["impressions","brand_new_metric"],"hasSnapshot":"yes","engagementRate":"x""#)
        XCTAssertEqual(ch.unavailable, [.impressions])
        XCTAssertNil(ch.hasSnapshot)
        XCTAssertNil(ch.engagementRate)
    }

    func testRateCell() {
        let ok = InsightsRules.rateCell(rate: 4.2, basis: RateBasis(impressionedPosts: 1, totalPosts: 10), flags: RateFlags(lowBase: true, reason: nil))
        XCTAssertEqual(ok.text, "4.20%")
        XCTAssertEqual(ok.basis, "(1/10)")
        XCTAssertTrue(ok.lowBase)
        let full = InsightsRules.rateCell(rate: 1, basis: RateBasis(impressionedPosts: 5, totalPosts: 5), flags: nil)
        XCTAssertNil(full.basis, "complete base needs no disclosure")
        let impossible = InsightsRules.rateCell(rate: nil, basis: RateBasis(impressionedPosts: 1, totalPosts: 1), flags: RateFlags(lowBase: false, reason: "rate_impossible"))
        XCTAssertNil(impossible.text)
        XCTAssertTrue(impossible.explanation.hasPrefix("More interactions than recorded views"))
        XCTAssertTrue(InsightsRules.rateCell(rate: nil, basis: nil, flags: nil).explanation.contains("nothing to compute"))
    }

    func testLabels() {
        XCTAssertEqual(InsightsRules.likeLabel("reactions"), "Reactions")
        XCTAssertEqual(InsightsRules.likeLabel(nil), "Likes")
        XCTAssertEqual(InsightsRules.metricLabel(.reach, aggregate: true), "Reach (summed)")
        XCTAssertEqual(InsightsRules.metricLabel(.reach, aggregate: false), "Reach")
    }

    func testVisibleMetricsFollowTheServer() {
        XCTAssertEqual(InsightsRules.visibleMetrics([.likes, .views]), [.views, .likes])
        XCTAssertEqual(InsightsRules.visibleMetrics(nil), MetricKey.allCases)
    }

    func testEmptyStates() {
        let noPosts = channel(#","postCount":0,"impressions":0,"views":0,"reach":0,"comments":0,"shares":0"#)
        XCTAssertEqual(InsightsRules.emptyState([noPosts], includesDirectPosts: false, publishedAllTime: 0), .noAppPosts)
        XCTAssertEqual(InsightsRules.emptyState([noPosts], includesDirectPosts: false, publishedAllTime: 12), .noAppPostsInRange(total: 12))
        let zeroCaptured = channel(#","impressions":0,"views":0,"reach":0,"comments":0,"shares":0,"hasSnapshot":true"#)
        XCTAssertEqual(InsightsRules.emptyState([zeroCaptured], includesDirectPosts: false, publishedAllTime: 3), .zeroEngagement)
        let zeroPending = channel(#","impressions":0,"views":0,"reach":0,"comments":0,"shares":0,"hasSnapshot":false"#)
        XCTAssertEqual(InsightsRules.emptyState([zeroPending], includesDirectPosts: false, publishedAllTime: 3), .noMetricsYet)
        XCTAssertEqual(InsightsRules.emptyState([channel("")], includesDirectPosts: false, publishedAllTime: 3), .none)
    }

    func testRangeUsesUtcDayBoundaries() {
        let now = TRPCClient.isoWithFraction.date(from: "2026-11-14T22:30:00.000Z")!
        let r = InsightsRules.range(days: 7, now: now)
        XCTAssertEqual(r.from, "2026-11-08T00:00:00.000Z")
        XCTAssertEqual(r.to, "2026-11-14T23:59:59.999Z")
    }

    func testCsvNeutralisesFormulasButNotNumbers() {
        XCTAssertEqual(InsightsRules.csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"")
        XCTAssertEqual(InsightsRules.csvCell("@cmd"), "'@cmd")
        XCTAssertEqual(InsightsRules.csvCell("-7"), "-7")
        XCTAssertEqual(InsightsRules.csvCell("a,b"), "\"a,b\"")
        XCTAssertEqual(InsightsRules.csvCell(nil), "")
    }

    func testReportRowKeepsNullDistinctFromZero() {
        let r: ReportRow = decode(#"{"targetId":"t","postId":"p","contentPreview":"x","channelName":"C","platform":"FACEBOOK","impressions":null,"likes":0,"views":12,"engagementRate":null}"#)
        XCTAssertEqual(r.values[.impressions] ?? nil, nil)
        XCTAssertEqual(r.values[.likes] ?? nil, 0)
        let csv = InsightsRules.reportCSV([r], metrics: [.impressions, .likes, .views])
        XCTAssertTrue(csv.contains(",,0,12,"), "null exports as an empty cell, zero as 0: \(csv)")
    }

    func testEngagementPayloadDecodes() {
        let e: InsightsEngagement = decode(#"{"includesDirectPosts":false,"impressions":10,"views":20,"likes":3,"engagementRate":2.5,"engagementRateBasis":{"impressionedPosts":1,"totalPosts":4},"engagementRateFlags":{"lowBase":true,"reason":null},"reportableMetrics":["views","likes"]}"#)
        XCTAssertEqual(e.values[.views], 20)
        XCTAssertEqual(e.reportableMetrics, [.views, .likes])
        XCTAssertEqual(e.basis?.totalPosts, 4)
    }
}
