import SwiftUI

/// Insights → Reports — every post on every channel over a window, the web's
/// ReportsTab: window (24h/7d/15d/30d), "now" vs "at that age" numbers,
/// platform and campaign filters (applied by the server, so the cap can't hide
/// rows), a CSV to share, and "Email me this report".
struct ReportsView: View {
    @Environment(SessionStore.self) private var session
    @State private var window = "7d"
    @State private var mode = "current"
    @State private var platform: String?
    @State private var campaign: String?
    @State private var platforms: [String] = []
    @State private var campaigns: [String] = []
    @State private var report: ReportsResponse?
    @State private var loading = false
    @State private var emailing = false
    @State private var error: String?
    @State private var notice: (title: String, detail: String)?

    static let limit = 500
    private var metrics: [MetricKey] { InsightsRules.visibleMetrics(report?.reportableMetrics) }

    var body: some View {
        List {
            Section {
                Picker("Window", selection: $window) {
                    Text("24h").tag("24h"); Text("7d").tag("7d"); Text("15d").tag("15d"); Text("30d").tag("30d")
                }
                .pickerStyle(.segmented)
                Picker("Numbers", selection: $mode) {
                    Text("As of now").tag("current")
                    Text("At that age").tag("at_age")
                }
                if platforms.count > 1 {
                    Picker("Platform", selection: $platform) {
                        Text("All platforms").tag(String?.none)
                        ForEach(platforms, id: \.self) { Text(Platform(raw: $0).displayName).tag(String?.some($0)) }
                    }
                }
                if !campaigns.isEmpty {
                    Picker("Campaign", selection: $campaign) {
                        Text("All campaigns").tag(String?.none)
                        ForEach(campaigns, id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                }
            } footer: {
                Text(mode == "current"
                     ? "Posts published in the last \(window), with their latest numbers."
                     : "Posts at least \(window) old, with the numbers captured when they were \(window) old. Posts from before mid-July 2026 have none.")
            }

            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }

            if let report {
                Section {
                    if report.rows.isEmpty {
                        Text("No posts in this window.").foregroundStyle(.secondary)
                    }
                    ForEach(report.rows) { row in reportRow(row) }
                } header: {
                    Text("\(report.rows.count.formatted()) row\(report.rows.count == 1 ? "" : "s")"
                         + (report.rows.count >= Self.limit ? " (first \(Self.limit) — download the CSV on the web for more)" : ""))
                } footer: {
                    if !report.rows.isEmpty { Text("Each row is one post on one channel. “—” means not reported or not captured yet.") }
                }
            }
        }
        .navigationTitle("Reports")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let report, !report.rows.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        ShareLink(item: csvFile(report), preview: SharePreview("Insights report \(window)")) {
                            Label("Share CSV", systemImage: "square.and.arrow.up")
                        }
                        Button { Task { await email() } } label: {
                            Label("Email to \(session.user?.email ?? "me")", systemImage: "envelope")
                        }
                        .disabled(emailing || session.user == nil)
                    } label: { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("Export report")
                }
            }
        }
        .refreshable { await load() }
        .task { if report == nil { await loadFilters(); await load() } }
        .onChange(of: window) { _, _ in Task { await load() } }
        .onChange(of: mode) { _, _ in Task { await load() } }
        .onChange(of: platform) { _, _ in Task { await load() } }
        .onChange(of: campaign) { _, _ in Task { await load() } }
        .overlay { if loading && report == nil { ProgressView() } }
        .alert(notice?.title ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(notice?.detail ?? "") }
    }

    private func reportRow(_ r: ReportRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(r.channelName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                if let at = r.publishedAt { Text(at, format: .dateTime.day().month().hour().minute()).font(.caption).foregroundStyle(.secondary) }
            }
            Text(r.contentPreview.isEmpty ? "(no caption)" : r.contentPreview).font(.caption).lineLimit(2).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(metrics, id: \.self) { m in
                        VStack(alignment: .leading, spacing: 1) {
                            Text((r.values[m] ?? nil).map(InsightsRules.compact) ?? "—").font(.footnote.weight(.semibold))
                            Text(InsightsRules.metricLabel(m, aggregate: false)).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(r.engagementRate.map { String(format: "%.2f%%", $0) } ?? "—").font(.footnote.weight(.semibold))
                        Text("Eng.").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            if let url = r.publishedUrl.flatMap(URL.init(string:)) {
                Link("Open post", destination: url).font(.caption)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: Data

    private struct ReportInput: Encodable {
        let window: String
        let mode: String
        let limit: Int
        var platform: String?
        var campaign: String?
    }
    private struct EmailInput: Encodable {
        let to: String
        let window: String
        let mode: String
        var platform: String?
        var campaign: String?
    }
    private struct Ignored: Decodable {}

    private func loadFilters() async {
        platforms = (try? await TRPCClient.shared.query("analytics.platformsInWindow")) ?? []
        campaigns = (try? await TRPCClient.shared.query("analytics.campaignLabels")) ?? []
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            report = try await TRPCClient.shared.query(
                "analytics.postReports",
                input: ReportInput(window: window, mode: mode, limit: Self.limit, platform: platform, campaign: campaign)
            )
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func csvFile(_ report: ReportsResponse) -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("insights-report-\(window)-\(mode).csv")
        try? InsightsRules.reportCSV(report.rows, metrics: metrics).write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func email() async {
        guard let to = session.user?.email else { return }
        emailing = true
        defer { emailing = false }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate(
                "analytics.emailReport", input: EmailInput(to: to, window: window, mode: mode, platform: platform, campaign: campaign)
            )
            notice = ("Report sent", "A CSV of this report is on its way to \(to).")
        } catch {
            notice = ("Couldn't email the report", error.localizedDescription)
        }
    }
}
