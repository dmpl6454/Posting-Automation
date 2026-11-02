import SwiftUI

/// Home tab — the four lifetime stat cards from `analytics.dashboardStats`,
/// each with the server's 6-point cumulative sparkline, plus the bell that
/// leads to the in-app notifications list.
///
/// Stats are loaded once per WORKSPACE (the shared `.task(id:)` pattern): coming
/// back to the tab never refetches, switching workspaces always does. The unread
/// count, by contrast, is re-read every time Home appears — the worker writes
/// publish outcomes while the user is elsewhere, and the bell is the only thing
/// on this screen that would otherwise go stale.
struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @State private var stats: DashboardStats?
    @State private var error: String?
    @State private var loading = false
    /// Workspace the stats were loaded for — see the doc comment above.
    @State private var loadedForOrg: String?

    private var unreadLabel: String {
        "Notifications, \(session.unreadNotifications) unread"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let user = session.user {
                        Text("Hi, \(user.firstName)")
                            .font(.title2.weight(.semibold))
                        if let org = session.currentOrganizationName {
                            Text(org).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }

                    if let error {
                        ErrorBanner(message: error) { Task { await load() } }
                    }

                    if let stats {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                            StatCard(title: "Total Posts", value: stats.totalPosts, series: stats.trends.totalPosts, tint: .blue, icon: "doc.text")
                            StatCard(title: "Published", value: stats.published, series: stats.trends.published, tint: .green, icon: "checkmark.circle")
                            StatCard(title: "Channels", value: stats.connectedChannels, series: stats.trends.connectedChannels, tint: .purple, icon: "antenna.radiowaves.left.and.right")
                            StatCard(title: "AI Generated", value: stats.aiGenerated, series: stats.trends.aiGenerated, tint: .orange, icon: "sparkles")
                        }
                    } else if loading {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding()
            }
            .navigationTitle("PostAutomation")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        NotificationsView()
                    } label: {
                        // `bell.badge.fill` renders its badge red in multicolor mode;
                        // the plain `bell` has no multicolor layers, so the mode is
                        // a no-op for it.
                        Image(systemName: session.unreadNotifications > 0 ? "bell.badge.fill" : "bell")
                            .symbolRenderingMode(.multicolor)
                    }
                    .accessibilityIdentifier("home.notifications")
                    .accessibilityLabel(unreadLabel)
                }
            }
            .refreshable { await load() }
            .task(id: session.activeOrganizationId) {
                if loadedForOrg != session.activeOrganizationId {
                    loadedForOrg = session.activeOrganizationId
                    // The cards on screen belong to the previous workspace; show
                    // the spinner rather than another org's numbers while loading.
                    stats = nil
                    error = nil
                    await load()
                }
                await session.refreshUnreadCount()
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            stats = try await TRPCClient.shared.query("analytics.dashboardStats")
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Components

struct StatCard: View {
    let title: String
    let value: Int
    let series: [Int]
    let tint: Color
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon).foregroundStyle(tint)
                Text(title).font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            Text(value.formatted())
                .font(.title.weight(.bold))
                .monospacedDigit()
            Sparkline(values: series, tint: tint)
                .frame(height: 28)
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value)")
    }
}

/// Tiny cumulative sparkline — the server series is "how this number grew".
struct Sparkline: View {
    let values: [Int]
    let tint: Color

    var body: some View {
        GeometryReader { geo in
            let pts = points(in: geo.size)
            if pts.count > 1 {
                Path { p in
                    p.move(to: pts[0])
                    for pt in pts.dropFirst() { p.addLine(to: pt) }
                }
                .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
    }

    private func points(in size: CGSize) -> [CGPoint] {
        guard values.count > 1 else { return [] }
        let maxV = max(values.max() ?? 1, 1)
        let minV = values.min() ?? 0
        let range = max(maxV - minV, 1)
        return values.enumerated().map { i, v in
            let x = size.width * CGFloat(i) / CGFloat(values.count - 1)
            let y = size.height - size.height * CGFloat(v - minV) / CGFloat(range)
            return CGPoint(x: x, y: y)
        }
    }
}

struct ErrorBanner: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.footnote)
            Spacer()
            Button("Retry", action: retry).font(.footnote.weight(.semibold))
        }
        .padding(12)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}
