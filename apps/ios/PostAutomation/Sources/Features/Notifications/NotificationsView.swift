import SwiftUI

/// In-app notifications — `notification.list` for the active workspace, newest
/// first, with cursor pagination. Pushed from the Home bell, so it deliberately
/// has NO `NavigationStack` of its own: it lives inside Home's, which is what
/// lets `navigationDestination(item:)` push the post a publish notification
/// points at.
///
/// Rows are the worker's publish outcomes (`post.published` / `post.failed`,
/// link `/dashboard/posts/<id>`), approvals (`/dashboard/approvals`) and the
/// caption / super-text degradations. Tapping a row marks it read, then either
/// opens the linked post in-app or — for any other same-site link — hands the
/// path to Safari on the canonical host. A `link` is stored data the server
/// never validated (see notification.router.ts), so an absolute or
/// protocol-relative URL from the server is never opened.
struct NotificationsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.openURL) private var openURL
    @State private var items: [AppNotification] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var loadingMore = false
    @State private var markingAll = false
    @State private var error: String?
    /// A failure while acting on one row (opening its post, mark all read). The
    /// list is still on screen then, so it is an alert rather than the empty state.
    @State private var actionError: String?
    @State private var showActionError = false
    /// Set once `post.getById` answers; `navigationDestination(item:)` pushes
    /// `PostDetailView` and clears it again when the user pops back.
    @State private var selectedPost: Post?
    /// The row being marked read / resolved: shows a spinner in place of its
    /// unread dot, and stops a second tap from opening two posts at once.
    @State private var openingId: String?
    /// Workspace the list was loaded for (the shared `.task(id:)` pattern):
    /// re-appearing after a pop must not refetch, a workspace switch must.
    @State private var loadedForOrg: String?

    private var hasUnread: Bool { items.contains { !$0.isRead } }

    var body: some View {
        Group {
            if items.isEmpty && loading {
                ProgressView("Loading notifications…")
            } else if items.isEmpty, let error {
                ContentUnavailableView {
                    Label("Couldn't load notifications", systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: {
                    Button("Retry") { Task { await load() } }
                }
            } else if items.isEmpty {
                // Inside a ScrollView so the empty state still pulls to refresh —
                // someone waiting on a publish result lands here most often.
                ScrollView {
                    ContentUnavailableView(
                        "No notifications yet",
                        systemImage: "bell",
                        description: Text("Publish results and approvals will show up here.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 80)
                }
                .refreshable { await load() }
            } else {
                List {
                    ForEach(items) { notification in
                        Button {
                            Task { await open(notification) }
                        } label: {
                            NotificationRow(notification: notification, opening: openingId == notification.id)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("notifications.row")
                    }
                    if nextCursor != nil {
                        HStack { Spacer(); ProgressView(); Spacer() }
                            .onAppear { Task { await loadMore() } }
                    }
                }
                .listStyle(.plain)
                .refreshable { await load() }
                .accessibilityIdentifier("notifications.list")
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Mark all read") { Task { await markAllRead() } }
                    .disabled(!hasUnread || markingAll)
                    .accessibilityIdentifier("notifications.markAllRead")
            }
        }
        .navigationDestination(item: $selectedPost) { PostDetailView(post: $0) }
        .alert("Something went wrong", isPresented: $showActionError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
        .task(id: session.activeOrganizationId) {
            if loadedForOrg != session.activeOrganizationId {
                loadedForOrg = session.activeOrganizationId
                // Per-workspace state first: these rows (and a post opened from
                // one of them) belong to the previous workspace.
                items = []
                nextCursor = nil
                selectedPost = nil
                await load()
            }
        }
    }

    // MARK: - Loading

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let page: NotificationListPage = try await TRPCClient.shared.query(
                "notification.list", input: NotificationListInput(limit: 30)
            )
            items = page.notifications
            nextCursor = page.nextCursor
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            // The `.task` is cancelled when the view is popped mid-request; that
            // is not a failure worth reporting on a screen that is gone.
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page: NotificationListPage = try await TRPCClient.shared.query(
                "notification.list", input: NotificationListInput(limit: 30, cursor: cursor)
            )
            let known = Set(items.map(\.id))
            items += page.notifications.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            nextCursor = nil // stop the spinner; pull-to-refresh recovers
        }
    }

    // MARK: - Actions

    private func open(_ notification: AppNotification) async {
        guard openingId == nil else { return }
        openingId = notification.id
        defer { openingId = nil }

        if !notification.isRead {
            // Optimistic: the row reads as read at once. The server write is
            // best-effort — a lost markRead only means the row comes back unread
            // on the next refresh — but the bell must agree with the SERVER, so
            // the unread count is re-queried rather than decremented locally.
            setRead(ids: [notification.id])
            do {
                let _: Ack = try await TRPCClient.shared.mutate("notification.markRead", input: IdInput(id: notification.id))
            } catch let e as APIError where e.isUnauthorized {
                await session.handleUnauthorized()
                return
            } catch {
                // Ignored by design (see above).
            }
            await session.refreshUnreadCount()
        }

        if let postId = notification.linkedPostId {
            await openPost(id: postId)
        } else if let url = NotificationLinkResolver.webURL(for: notification.link) {
            openURL(url)
        }
    }

    private func openPost(id: String) async {
        do {
            let post: Post = try await TRPCClient.shared.query("post.getById", input: IdInput(id: id))
            selectedPost = post
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch let e as APIError {
            // The post may have been deleted since the notification was written;
            // `post.getById` answers NOT_FOUND with no message worth showing.
            if case .trpc(let payload) = e, payload.code == "NOT_FOUND" {
                presentActionError("That post is no longer available — it may have been deleted.")
            } else {
                presentActionError(e.localizedDescription)
            }
        } catch {
            presentActionError(error.localizedDescription)
        }
    }

    private func markAllRead() async {
        markingAll = true
        defer { markingAll = false }
        do {
            let _: Ack = try await TRPCClient.shared.mutate("notification.markAllRead", input: NoInput())
            setRead(ids: Set(items.map(\.id)))
            await session.refreshUnreadCount()
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            presentActionError(error.localizedDescription)
        }
    }

    private func setRead(ids: Set<String>) {
        items = items.map { ids.contains($0.id) && !$0.isRead ? $0.markedRead : $0 }
    }

    private func presentActionError(_ message: String) {
        actionError = message
        showActionError = true
    }
}

// MARK: - Row

private struct NotificationRow: View {
    let notification: AppNotification
    let opening: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: notification.systemImage)
                .font(.body)
                .foregroundStyle(notification.tint)
                .frame(width: 34, height: 34)
                .background(notification.tint.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(notification.title)
                    .font(.subheadline.weight(notification.isRead ? .regular : .semibold))
                    .lineLimit(1)
                Text(notification.body)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(notification.createdAt, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 8)
            if opening {
                ProgressView()
            } else if !notification.isRead {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
                    .accessibilityLabel("Unread")
            }
        }
        .padding(.vertical, 4)
        // The Spacer is not hittable on its own: without this a tap on the empty
        // right half of the row would do nothing.
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Deep links

/// The web client's `isSafeInAppLink` rule, for links the app hands to Safari:
/// a notification's `link` is stored data, so only a path on OUR origin is ever
/// opened. `nil` for an absolute URL, a protocol-relative `//host` link, or
/// anything that does not resolve onto the API host.
enum NotificationLinkResolver {
    static func webURL(for link: String?, base: URL = APIConfig.baseURL) -> URL? {
        guard let link, link.hasPrefix("/"), !link.hasPrefix("//") else { return nil }
        guard let resolved = URL(string: link, relativeTo: base)?.absoluteURL,
              let host = resolved.host, let baseHost = base.host,
              host.caseInsensitiveCompare(baseHost) == .orderedSame,
              resolved.scheme?.lowercased() == base.scheme?.lowercased() else {
            return nil
        }
        return resolved
    }
}

private extension AppNotification {
    /// The same row flagged read — `isRead` is a `let`, mirroring the wire shape.
    var markedRead: AppNotification {
        AppNotification(id: id, type: type, title: title, body: body, link: link, isRead: true, createdAt: createdAt)
    }
}
