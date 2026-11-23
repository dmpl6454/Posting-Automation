import Foundation

/// Insights display rules, ported from the web so both show the same numbers
/// the same way (apps/web/lib/metric-cell.ts, insights-empty-state.ts, csv.ts).
/// Pure and unit-tested.
enum InsightsRules {
    // MARK: Honest cells

    /// The number to show, or nil for "—": the platform never reports this
    /// metric, reach is just impressions again, or nothing was captured yet.
    /// A captured 0 is a real 0.
    static func cellValue(_ key: MetricKey, _ row: ChannelStat) -> Int? {
        if row.hasSnapshot == false { return nil }
        if row.unavailable.contains(key) { return nil }
        if key == .reach && row.reachIsDistinct == false { return nil }
        return row.values[key] ?? 0
    }

    struct RateCell: Equatable {
        /// "4.20%", or nil for "—".
        var text: String?
        /// Why — shown under the number on a tap.
        var explanation: String
        var lowBase: Bool
        /// "(1/10)" when only some posts reported impressions.
        var basis: String?
    }

    /// The ONE engagement-rate decision (web: engagementRateCell). The gate is
    /// the rate being nil — a "rate_impossible" verdict has a real base but must
    /// still show "—".
    static func rateCell(rate: Double?, basis: RateBasis?, flags: RateFlags?, unit: String = "post") -> RateCell {
        guard let rate else {
            return RateCell(
                text: nil,
                explanation: flags?.reason == "rate_impossible"
                    ? "More interactions than recorded views. Facebook reports reactions and video views from different sources, so a rate can't be computed here."
                    : "No \(unit) here reported an impression or view count, so there is nothing to compute a rate from.",
                lowBase: false,
                basis: nil
            )
        }
        let impressioned = basis?.impressionedPosts ?? 0
        let total = basis?.totalPosts ?? 0
        let lowBase = flags?.lowBase ?? false
        return RateCell(
            text: String(format: "%.2f%%", rate),
            explanation: (lowBase ? "Based on a small number of impressions — treat as indicative. " : "")
                + "Pooled over the \(impressioned) of \(total) \(unit)(s) that reported impressions.",
            lowBase: lowBase,
            basis: total > 0 && impressioned < total ? "(\(impressioned)/\(total))" : nil
        )
    }

    /// Facebook counts all reactions, Pinterest saves, Reddit upvotes.
    static func likeLabel(_ likeKind: String?) -> String {
        switch likeKind {
        case "reactions": return "Reactions"
        case "saves": return "Saves"
        case "upvotes": return "Upvotes"
        default: return "Likes"
        }
    }

    static func metricLabel(_ key: MetricKey, aggregate: Bool) -> String {
        switch key {
        case .impressions: return "Impressions"
        case .views: return "Views"
        // Reach is unique per post, so a sum across posts counts people twice.
        case .reach: return aggregate ? "Reach (summed)" : "Reach"
        case .likes: return "Likes"
        case .comments: return "Comments"
        case .shares: return "Shares"
        case .clicks: return "Clicks"
        }
    }

    /// Metrics to show: what some connected platform can report. While the
    /// server didn't say (legacy payload), show everything.
    static func visibleMetrics(_ reportable: [MetricKey]?) -> [MetricKey] {
        guard let reportable, !reportable.isEmpty else { return MetricKey.allCases }
        return MetricKey.allCases.filter { reportable.contains($0) }
    }

    // MARK: Empty states (web: deriveInsightsEmptyState)

    enum EmptyState: Equatable {
        case none, noAppPosts, noAppPostsInRange(total: Int), noMetricsYet, zeroEngagement
    }

    static func emptyState(_ rows: [ChannelStat], includesDirectPosts: Bool, publishedAllTime: Int) -> EmptyState {
        guard !rows.isEmpty else { return .none }
        func engagement(_ r: ChannelStat) -> Int {
            [MetricKey.impressions, .reach, .likes, .comments, .shares].reduce(0) { $0 + (r.values[$1] ?? 0) }
        }
        if rows.contains(where: { engagement($0) > 0 }) { return .none }
        let posted = rows.filter { $0.postCount > 0 }
        if posted.isEmpty {
            if includesDirectPosts { return .noMetricsYet }
            return publishedAllTime > 0 ? .noAppPostsInRange(total: publishedAllTime) : .noAppPosts
        }
        return posted.allSatisfy { $0.hasSnapshot == true } ? .zeroEngagement : .noMetricsYet
    }

    static func emptyMessage(_ s: EmptyState) -> (title: String, detail: String)? {
        switch s {
        case .none: return nil
        case .noAppPosts:
            return ("No posts sent from PostAutomation yet",
                    "Insights cover posts published through PostAutomation. Publish one and its numbers appear here.")
        case .noAppPostsInRange(let total):
            return ("Nothing published in this range",
                    "This workspace has \(total.formatted()) published post\(total == 1 ? "" : "s") in total — pick a longer range to see them.")
        case .noMetricsYet:
            return ("Numbers haven't arrived yet",
                    "Your posts are published, but their metrics haven't been collected yet. Tap Sync now, or check back later.")
        case .zeroEngagement:
            return ("No engagement yet",
                    "The platforms have reported on these posts, and the counts are genuinely zero so far.")
        }
    }

    // MARK: Ranges

    /// The web's UTC day boundaries: from the start of the first day to the
    /// end of today, so "today" means the same thing on both.
    static func range(days: Int, now: Date = Date()) -> (from: String, to: String) {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let today = utc.startOfDay(for: now)
        let start = utc.date(byAdding: .day, value: -(days - 1), to: today)!
        let end = utc.date(byAdding: .second, value: 86399, to: today)!.addingTimeInterval(0.999)
        return (TRPCClient.isoWithFraction.string(from: start), TRPCClient.isoWithFraction.string(from: end))
    }

    // MARK: Numbers

    static func compact(_ n: Int) -> String {
        let d = Double(n)
        switch abs(d) {
        case 1_000_000_000...: return String(format: "%.1fB", d / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", d / 1_000_000)
        case 10_000...: return String(format: "%.1fK", d / 1_000)
        default: return n.formatted()
        }
    }

    // MARK: CSV (web: apps/web/lib/csv.ts)

    /// A cell that could run as a spreadsheet formula gets a leading `'`.
    /// Numbers (incl. negatives) are untouched.
    static func csvCell(_ value: String?) -> String {
        guard var s = value else { return "" }
        if let first = s.first, "=+-@\t\r".contains(first), Double(s) == nil { s = "'" + s }
        if s.contains(",") || s.contains("\"") || s.contains("\n") || s.contains("\r") {
            s = "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return s
    }

    static func reportCSV(_ rows: [ReportRow], metrics: [MetricKey]) -> String {
        let header = ["Post", "Channel", "Platform", "Published (UTC)", "Campaign", "URL"]
            + metrics.map { metricLabel($0, aggregate: false) } + ["Engagement rate %", "Captured (UTC)"]
        var lines = [header.map(csvCell).joined(separator: ",")]
        for r in rows {
            var cells: [String?] = [
                r.contentPreview, r.channelName, r.platform,
                r.publishedAt.map { TRPCClient.isoWithFraction.string(from: $0) },
                r.campaignLabel, r.publishedUrl,
            ]
            cells += metrics.map { m in (r.values[m] ?? nil).map(String.init) }
            cells.append(r.engagementRate.map { String(format: "%.2f", $0) })
            cells.append(r.snapshotAt.map { TRPCClient.isoWithFraction.string(from: $0) })
            lines.append(cells.map(csvCell).joined(separator: ","))
        }
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    // MARK: Excel export (2026-11-23)

    /// Rows per page fetched for the Excel export (the server allows this + 1).
    static let reportPageSize = 2000
    /// Hard stop for one file — far under Excel's 1,048,576-row sheet limit.
    static let xlsxMaxRows = 100_000

    struct ReportCursor: Encodable, Equatable {
        var publishedAt: String
        var targetId: String
    }

    /// Keyset paging for a page fetched with `limit = pageSize + 1`: the rows to
    /// keep, and the cursor for the next page (nil when this was the last one).
    /// Same contract as the web's nextReportCursor — the server orders by
    /// (publishedAt DESC, targetId DESC), so the last kept row is the cursor.
    static func nextReportCursor(_ page: [ReportRow], pageSize: Int = reportPageSize) -> (rows: [ReportRow], cursor: ReportCursor?) {
        let rows = Array(page.prefix(pageSize))
        guard page.count > pageSize, let last = rows.last, let at = last.publishedAt else { return (rows, nil) }
        return (rows, ReportCursor(publishedAt: TRPCClient.isoWithFraction.string(from: at), targetId: last.targetId))
    }

    /// The Excel columns: the CSV's columns, typed, plus the handle — dates are
    /// real dates, counts real numbers, the post URL a clickable link.
    static func reportXlsxColumns(metrics: [MetricKey]) -> [XlsxWriter.Column] {
        [
            .init(header: "Post", kind: .text, width: 50),
            .init(header: "Channel", kind: .text, width: 24),
            .init(header: "Handle", kind: .text, width: 20),
            .init(header: "Platform", kind: .text, width: 12),
            .init(header: "Published (UTC)", kind: .date, width: 18),
            .init(header: "Campaign", kind: .text, width: 18),
            .init(header: "Post URL", kind: .link, width: 48),
        ]
        + metrics.map { XlsxWriter.Column(header: metricLabel($0, aggregate: false), kind: .number, width: 12) }
        + [
            .init(header: "Engagement %", kind: .percent, width: 13),
            .init(header: "Captured (UTC)", kind: .date, width: 20),
        ]
    }

    static func reportXlsxRow(_ r: ReportRow, metrics: [MetricKey]) -> [XlsxWriter.Cell] {
        func text(_ s: String?) -> XlsxWriter.Cell { s.map { .text($0) } ?? .empty }
        func date(_ d: Date?) -> XlsxWriter.Cell { d.map { .date($0) } ?? .empty }
        var cells: [XlsxWriter.Cell] = [
            text(r.contentPreview), text(r.channelName), text(r.channelUsername.map { "@" + $0 }),
            text(Platform(raw: r.platform).displayName), date(r.publishedAt), text(r.campaignLabel), text(r.publishedUrl),
        ]
        // nil ⇒ empty cell ("—" in the app); a real 0 stays 0.
        cells += metrics.map { m in (r.values[m] ?? nil).map { .number(Double($0)) } ?? .empty }
        cells.append(r.engagementRate.map { .number($0) } ?? .empty)
        cells.append(date(r.snapshotAt))
        return cells
    }

    static func reportXlsx(_ rows: [ReportRow], metrics: [MetricKey]) -> Data {
        XlsxWriter.build(
            sheetName: "Report",
            columns: reportXlsxColumns(metrics: metrics),
            rows: rows.map { reportXlsxRow($0, metrics: metrics) }
        )
    }
}
