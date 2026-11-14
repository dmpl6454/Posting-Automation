import SwiftUI

/// Insights tab — the web's /dashboard/analytics "Insights" view: range and
/// platform filter, channel-health banner, overview tiles, engagement tiles
/// (only metrics some connected platform can report), channel performance
/// with honest "—" cells, and Sync now. Rules: InsightsRules.
struct InsightsView: View {
    @Environment(SessionStore.self) private var session
    @State private var days = 30
    @State private var platform: String?
    @State private var platforms: [String] = []
    @State private var overview: InsightsOverview?
    @State private var engagement: InsightsEngagement?
    @State private var channels: [ChannelStat] = []
    @State private var health: InsightsHealthSummary?
    @State private var loading = false
    @State private var syncing = false
    @State private var error: String?
    @State private var notice: (title: String, detail: String)?

    private var metrics: [MetricKey] { InsightsRules.visibleMetrics(engagement?.reportableMetrics) }

    var body: some View {
        NavigationStack {
            List {
                filters
                if let health, health.needsReconnectCount + health.expiringSoonCount > 0 { healthBanner(health) }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
                if let overview { overviewSection(overview) }
                if let engagement { engagementSection(engagement) }
                if let empty = InsightsRules.emptyMessage(
                    InsightsRules.emptyState(channels, includesDirectPosts: engagement?.includesDirectPosts ?? false,
                                             publishedAllTime: overview?.publishedAllTime ?? 0)
                ) {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(empty.title).font(.subheadline.weight(.semibold))
                            Text(empty.detail).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                channelSection
            }
            .navigationTitle("Insights")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await sync() } } label: {
                        if syncing { ProgressView() } else { Label("Sync now", systemImage: "arrow.triangle.2.circlepath") }
                    }
                    .disabled(syncing)
                }
            }
            .refreshable { await load() }
            .task { if overview == nil { await loadPlatforms(); await load() } }
            .onChange(of: days) { _, _ in Task { await load() } }
            .onChange(of: platform) { _, _ in Task { await load() } }
            .overlay { if loading && overview == nil { ProgressView() } }
            .alert(notice?.title ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(notice?.detail ?? "") }
        }
    }

    // MARK: Sections

    private var filters: some View {
        Section {
            Picker("Range", selection: $days) {
                Text("7 days").tag(7)
                Text("30 days").tag(30)
                Text("90 days").tag(90)
            }
            .pickerStyle(.segmented)
            if platforms.count > 1 {
                Picker("Platform", selection: $platform) {
                    Text("All platforms").tag(String?.none)
                    ForEach(platforms, id: \.self) { p in Text(Platform(raw: p).displayName).tag(String?.some(p)) }
                }
            }
        } footer: {
            Text("Covers posts published through PostAutomation.")
        }
    }

    private func healthBanner(_ h: InsightsHealthSummary) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                if h.needsReconnectCount > 0 {
                    Label("\(h.needsReconnectCount) channel\(h.needsReconnectCount == 1 ? "" : "s") can't report insights — reconnect \(h.needsReconnectCount == 1 ? "it" : "them") on the web.",
                          systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                if h.expiringSoonCount > 0 {
                    Label("\(h.expiringSoonCount) channel\(h.expiringSoonCount == 1 ? "" : "s") will stop reporting insights soon — reconnect before then.",
                          systemImage: "clock.badge.exclamationmark")
                        .foregroundStyle(.secondary)
                }
                let names = h.channels.prefix(5).map(\.name)
                if !names.isEmpty {
                    Text(names.joined(separator: ", ") + (h.channels.count > 5 ? "…" : "")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
        }
    }

    private func overviewSection(_ o: InsightsOverview) -> some View {
        Section {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                tile("Posts created", value: o.totalPosts.formatted(), note: "Each post, once")
                tile("Channel deliveries", value: o.published.formatted(), note: "One per channel a post reached")
                tile("Failed", value: o.failed.formatted(), note: "Deliveries that didn't publish", tint: o.failed > 0 ? .red : nil)
            }
        }
    }

    private func engagementSection(_ e: InsightsEngagement) -> some View {
        Section("Engagement") {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(metrics, id: \.self) { m in
                    tile(InsightsRules.metricLabel(m, aggregate: true), value: InsightsRules.compact(e.values[m] ?? 0))
                }
                let rate = InsightsRules.rateCell(rate: e.engagementRate, basis: e.basis, flags: e.flags)
                tile("Engagement rate", value: rate.text ?? "—", note: rate.basis ?? (rate.lowBase ? "Low base" : nil))
                    .onTapGesture { notice = ("Engagement rate", rate.explanation) }
            }
        }
    }

    private var channelSection: some View {
        Section {
            if channels.isEmpty && !loading {
                Text("No channels yet.").foregroundStyle(.secondary)
            }
            ForEach(channels) { ch in
                NavigationLink { ChannelInsightsDetail(stat: ch, metrics: metrics) } label: { channelRow(ch) }
            }
        } header: {
            Text("Channel performance")
        } footer: {
            if !channels.isEmpty { Text("“—” means the platform doesn't report that number. Tap a channel for every metric.") }
        }
    }

    private func channelRow(_ ch: ChannelStat) -> some View {
        let primary: MetricKey = ch.unavailable.contains(.impressions) ? .views : .impressions
        let rate = InsightsRules.rateCell(rate: ch.engagementRate, basis: ch.basis, flags: ch.flags)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(ch.name).lineLimit(1)
                if ch.channelStatus == "disconnected" { badge("Disconnected") }
                if ch.channelStatus == "paused" { badge("Paused") }
                if ch.healthStatus == "needs_reconnect" { badge("Insights off", tint: .orange) }
                Spacer()
                Text(Platform(raw: ch.platform).displayName).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 14) {
                stat("Posts", ch.postCount.formatted())
                stat(InsightsRules.metricLabel(primary, aggregate: true), InsightsRules.cellValue(primary, ch).map(InsightsRules.compact) ?? "—")
                stat(InsightsRules.likeLabel(ch.likeKind), InsightsRules.cellValue(.likes, ch).map(InsightsRules.compact) ?? "—")
                stat("Eng.", rate.text ?? "—")
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: Pieces

    private func tile(_ title: String, value: String, note: String? = nil, tint: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).foregroundStyle(tint ?? .primary)
            if let note { Text(note).font(.caption2).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.subheadline.weight(.semibold))
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func badge(_ text: String, tint: Color = .secondary) -> some View {
        Text(text).font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(Capsule().stroke(tint.opacity(0.6))).foregroundStyle(tint)
    }

    // MARK: Loading

    private struct RangeInput: Encodable { let from: String; let to: String; var platform: String? }
    private struct SyncInput: Encodable { let days: Int }

    private func loadPlatforms() async {
        platforms = (try? await TRPCClient.shared.query("analytics.platformsInWindow")) ?? []
    }

    private func load() async {
        loading = true
        defer { loading = false }
        let r = InsightsRules.range(days: days)
        let input = RangeInput(from: r.from, to: r.to, platform: platform)
        do {
            async let o: InsightsOverview = TRPCClient.shared.query("analytics.overview", input: RangeInput(from: r.from, to: r.to))
            async let e: InsightsEngagement = TRPCClient.shared.query("analytics.engagement", input: input)
            async let c: [ChannelStat] = TRPCClient.shared.query("analytics.perChannelStats", input: input)
            (overview, engagement, channels) = try await (o, e, c)
            health = try? await TRPCClient.shared.query("analytics.insightsHealth")
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func sync() async {
        syncing = true
        defer { syncing = false }
        do {
            let r: SyncResult = try await TRPCClient.shared.mutate("analytics.triggerSync", input: SyncInput(days: max(days, 1)))
            if r.queued == 0 && r.accountsQueued == 0 {
                notice = ("Nothing to sync", "No posts were published from \(session.currentOrganizationName ?? "this workspace") in this range.")
            } else {
                notice = ("Sync started", "Refreshing \(r.queued.formatted()) post\(r.queued == 1 ? "" : "s"). New numbers appear in a few minutes — pull down to refresh.")
            }
        } catch {
            notice = ("Couldn't sync", error.localizedDescription)
        }
    }
}

/// Every metric for one channel, with "—" where the platform doesn't report it.
struct ChannelInsightsDetail: View {
    let stat: ChannelStat
    let metrics: [MetricKey]
    var body: some View {
        List {
            Section {
                LabeledContent("Platform", value: Platform(raw: stat.platform).displayName)
                if let u = stat.username { LabeledContent("Handle", value: u.hasPrefix("@") ? u : "@\(u)") }
                LabeledContent("Posts sent", value: stat.postCount.formatted())
            }
            Section {
                ForEach(metrics, id: \.self) { m in
                    LabeledContent(m == .likes ? InsightsRules.likeLabel(stat.likeKind) : InsightsRules.metricLabel(m, aggregate: true),
                                   value: InsightsRules.cellValue(m, stat).map { $0.formatted() } ?? "—")
                }
                let rate = InsightsRules.rateCell(rate: stat.engagementRate, basis: stat.basis, flags: stat.flags)
                LabeledContent("Engagement rate", value: [rate.text ?? "—", rate.basis].compactMap { $0 }.joined(separator: " "))
            } header: {
                Text("Metrics")
            } footer: {
                Text(InsightsRules.rateCell(rate: stat.engagementRate, basis: stat.basis, flags: stat.flags).explanation)
            }
        }
        .navigationTitle(stat.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
