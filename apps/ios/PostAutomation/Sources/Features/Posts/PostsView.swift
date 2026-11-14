import SwiftUI

/// Posts tab — the web's Posts list and Calendar: status filter, sort,
/// archived view, cursor pagination; tap a post for its page (PostDetailView).
struct PostsView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case list, calendar
        var id: String { rawValue }
    }

    @Environment(SessionStore.self) private var session
    @State private var mode: Mode = .list
    @State private var filter: PostStatus? = nil
    @State private var archived = false
    @State private var sort = "newest"
    @State private var posts: [Post] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var loadingMore = false
    @State private var error: String?
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            Group {
                if mode == .calendar {
                    PostsCalendarView(filter: filter)
                } else {
                    list
                }
            }
            .navigationTitle(archived && mode == .list ? "Archived" : "Posts")
            .navigationDestination(for: Post.self) { p in
                PostDetailView(post: p) { Task { await reload() } }
            }
            .safeAreaInset(edge: .top, spacing: 0) { filterBar }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Picker("View", selection: $mode) {
                        Image(systemName: "list.bullet").tag(Mode.list).accessibilityLabel("List")
                        Image(systemName: "calendar").tag(Mode.calendar).accessibilityLabel("Calendar")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 110)
                }
                if mode == .list {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Picker("Sort", selection: $sort) {
                                Text("Newest").tag("newest")
                                Text("Oldest").tag("oldest")
                                Text("Recently updated").tag("recently_updated")
                            }
                            Toggle("Show archived", isOn: $archived)
                        } label: {
                            Image(systemName: "line.3.horizontal.decrease.circle")
                        }
                        .accessibilityLabel("Sort and archived")
                    }
                }
            }
            .onChange(of: sort) { _, _ in Task { await reload() } }
            .onChange(of: archived) { _, _ in Task { await reload() } }
            .task { if posts.isEmpty { await reload() } }
            .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                Button("OK", role: .cancel) {}
            }
        }
    }

    @ViewBuilder
    private var list: some View {
        if posts.isEmpty && loading {
            ProgressView("Loading posts…")
        } else if posts.isEmpty, let error {
            ContentUnavailableView {
                Label("Couldn't load posts", systemImage: "exclamationmark.triangle")
            } description: { Text(error) } actions: {
                Button("Retry") { Task { await reload() } }
            }
        } else if posts.isEmpty {
            ContentUnavailableView(
                archived ? "No archived posts" : (filter == nil ? "No posts yet" : "No \(filter!.label.lowercased()) posts"),
                systemImage: archived ? "archivebox" : "doc.text",
                description: Text(archived ? "Posts you archive show up here." : "Posts you create will show up here.")
            )
        } else {
            List {
                ForEach(posts) { post in
                    NavigationLink(value: post) { PostRow(post: post) }
                        .swipeActions {
                            if post.archivedAt != nil {
                                Button("Unarchive") { Task { await setArchived(post, false) } }.tint(.blue)
                            } else if post.status != .SCHEDULED && post.status != .PUBLISHING {
                                // The server refuses archiving a post that is still due to publish.
                                Button("Archive") { Task { await setArchived(post, true) } }.tint(.gray)
                            }
                        }
                }
                if nextCursor != nil {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .onAppear { Task { await loadMore() } }
                }
            }
            .listStyle(.plain)
            .refreshable { await reload() }
        }
    }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                FilterChip(title: "All", selected: filter == nil) { setFilter(nil) }
                ForEach([PostStatus.SCHEDULED, .PUBLISHED, .FAILED, .DRAFT, .PUBLISHING]) { s in
                    FilterChip(title: s.label, selected: filter == s) { setFilter(s) }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private func setFilter(_ s: PostStatus?) {
        guard filter != s else { return }
        filter = s
        Task { await reload() }
    }

    private func input(cursor: String? = nil) -> PostListInput {
        PostListInput(status: filter?.rawValue, limit: 20, cursor: cursor, archived: archived, sort: sort)
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            let page: PostListPage = try await TRPCClient.shared.query("post.list", input: input())
            posts = page.posts
            nextCursor = page.nextCursor
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page: PostListPage = try await TRPCClient.shared.query("post.list", input: input(cursor: cursor))
            let known = Set(posts.map(\.id))
            posts += page.posts.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor
        } catch {
            nextCursor = nil // stop the spinner; pull-to-refresh recovers
        }
    }

    private struct IdInput: Encodable { let id: String }
    private struct Ignored: Decodable {}

    private func setArchived(_ post: Post, _ value: Bool) async {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate(value ? "post.archive" : "post.unarchive", input: IdInput(id: post.id))
            posts.removeAll { $0.id == post.id }
        } catch {
            notice = error.localizedDescription
        }
    }
}

struct FilterChip: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.footnote.weight(.medium))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(selected ? Color.accentColor : Color(.secondarySystemBackground), in: Capsule())
                .foregroundStyle(selected ? .white : .primary)
        }
        .buttonStyle(.plain)
    }
}

struct PostRow: View {
    let post: Post
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                StatusBadge(status: post.status)
                if post.aiGenerated {
                    Image(systemName: "sparkles").font(.caption2).foregroundStyle(.orange)
                        .accessibilityLabel("AI generated")
                }
                Spacer()
                Text(post.displayDate, format: .relative(presentation: .named))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(post.content)
                .font(.subheadline)
                .lineLimit(3)
            if !post.targets.isEmpty {
                HStack(spacing: 4) {
                    ForEach(post.targets.prefix(6)) { t in
                        Image(systemName: t.channel.platform.systemImage)
                            .font(.caption2)
                            .foregroundStyle(t.status == .FAILED ? .red : t.channel.platform.tint)
                    }
                    if post.targets.count > 6 {
                        Text("+\(post.targets.count - 6)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct StatusBadge: View {
    let status: PostStatus
    var body: some View {
        Label(status.label, systemImage: status.systemImage)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(status.color.opacity(0.15), in: Capsule())
            .foregroundStyle(status.color)
    }
}
