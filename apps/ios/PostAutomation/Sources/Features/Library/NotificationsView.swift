import SwiftUI

/// Notifications — the web's bell: publish results, approvals, alerts.
struct NotificationsView: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [AppNotification] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var openPost: String?

    private var unread: Int { items.filter { !$0.isRead }.count }

    var body: some View {
        List {
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if items.isEmpty && !loading && error == nil {
                ContentUnavailableView("No notifications", systemImage: "bell")
            }
            ForEach(items) { n in
                Button { Task { await open(n) } } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Circle().fill(n.isRead ? Color.clear : Color.accentColor).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(n.title).font(.subheadline.weight(n.isRead ? .regular : .semibold)).foregroundStyle(.primary)
                            if !n.body.isEmpty { Text(n.body).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                            if let at = n.createdAt { Text(at, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(.secondary) }
                        }
                        Spacer(minLength: 0)
                        if LibraryRules.postId(fromLink: n.link) != nil {
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("notification.row")
            }
            if nextCursor != nil {
                HStack { Spacer(); ProgressView(); Spacer() }.onAppear { Task { await load(more: true) } }
            }
        }
        .navigationTitle(unread > 0 ? "Notifications (\(unread))" : "Notifications")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Mark all read") { Task { await markAllRead() } }.disabled(unread == 0)
            }
        }
        .navigationDestination(item: $openPost) { id in PostDetailView(postId: id) }
        .refreshable { await load(more: false) }
        .task { if items.isEmpty { await load(more: false) } }
        .overlay { if loading && items.isEmpty { ProgressView() } }
    }

    private struct ListInput: Encodable { let limit: Int; var cursor: String? }
    private struct IdInput: Encodable { let id: String }
    private struct NoInput: Encodable {}
    private struct Ignored: Decodable {}

    private func load(more: Bool) async {
        if more && loading { return }
        loading = true
        defer { loading = false }
        do {
            let p: NotificationsPage = try await TRPCClient.shared.query("notification.list", input: ListInput(limit: 30, cursor: more ? nextCursor : nil))
            items = more ? items + p.notifications : p.notifications
            nextCursor = p.nextCursor
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }

    private func open(_ n: AppNotification) async {
        if !n.isRead {
            if let i = items.firstIndex(where: { $0.id == n.id }) { items[i].isRead = true }
            let _: Ignored? = try? await TRPCClient.shared.mutate("notification.markRead", input: IdInput(id: n.id))
        }
        if let id = LibraryRules.postId(fromLink: n.link) { openPost = id }
    }

    private func markAllRead() async {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("notification.markAllRead", input: NoInput())
            for i in items.indices { items[i].isRead = true }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

