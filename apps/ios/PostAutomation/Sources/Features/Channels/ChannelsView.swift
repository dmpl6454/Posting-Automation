import SwiftUI

/// Channels tab — `channel.list`, grouped by platform, with the insights-health
/// "Reconnect" affordance the web app shows.
struct ChannelsView: View {
    @Environment(SessionStore.self) private var session
    @State private var channels: [Channel] = []
    @State private var loading = false
    @State private var error: String?

    private var grouped: [(Platform, [Channel])] {
        let dict = Dictionary(grouping: channels, by: \.platform)
        return dict.keys.sorted { $0.displayName < $1.displayName }.map { ($0, dict[$0]!.sorted { $0.name < $1.name }) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if channels.isEmpty && loading {
                    ProgressView("Loading channels…")
                } else if channels.isEmpty, let error {
                    ContentUnavailableView {
                        Label("Couldn't load channels", systemImage: "exclamationmark.triangle")
                    } description: { Text(error) } actions: {
                        Button("Retry") { Task { await load() } }
                    }
                } else if channels.isEmpty {
                    ContentUnavailableView(
                        "No channels connected",
                        systemImage: "antenna.radiowaves.left.and.right",
                        description: Text("Connect Facebook, Instagram, X and more from the web dashboard.")
                    )
                } else {
                    List {
                        ForEach(grouped, id: \.0) { platform, items in
                            Section {
                                ForEach(items) { ChannelRow(channel: $0) }
                            } header: {
                                Label("\(platform.displayName) · \(items.count)", systemImage: platform.systemImage)
                            }
                        }
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Channels")
            .task { if channels.isEmpty { await load() } }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            channels = try await TRPCClient.shared.query("channel.list")
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ChannelRow: View {
    let channel: Channel
    var body: some View {
        HStack(spacing: 12) {
            ChannelAvatar(channel: channel)
            VStack(alignment: .leading, spacing: 2) {
                Text(channel.name).font(.subheadline.weight(.medium)).lineLimit(1)
                if let handle = channel.handle {
                    Text(handle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if channel.needsReconnect {
                Label("Reconnect", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.caption2.weight(.semibold))
                    .labelStyle(.titleAndIcon)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.orange.opacity(0.15), in: Capsule())
                    .foregroundStyle(.orange)
            } else if !channel.isActive {
                Text("Paused").font(.caption2.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.gray.opacity(0.15), in: Capsule())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Remote avatar with initials fallback (avatars are S3-cached by the worker,
/// but a stale platform CDN URL can still 404 — never show a broken image).
struct ChannelAvatar: View {
    let channel: Channel
    var body: some View {
        ZStack {
            Circle().fill(channel.platform.tint.opacity(0.15))
            if let url = channel.avatarURL {
                AsyncImage(url: url) { phase in
                    if case .success(let img) = phase {
                        img.resizable().scaledToFill()
                    } else {
                        initials
                    }
                }
                .clipShape(Circle())
            } else {
                initials
            }
        }
        .frame(width: 40, height: 40)
        .overlay(alignment: .bottomTrailing) {
            Image(systemName: channel.platform.systemImage)
                .font(.system(size: 9, weight: .bold))
                .padding(3)
                .background(.background, in: Circle())
                .foregroundStyle(channel.platform.tint)
        }
    }
    private var initials: some View {
        Text(channel.name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased())
            .font(.caption.weight(.bold))
            .foregroundStyle(channel.platform.tint)
    }
}
