import SwiftUI

/// Posts tab — `post.list` with a status filter and cursor pagination.
struct PostsView: View {
    @Environment(SessionStore.self) private var session
    @State private var filter: PostStatus? = nil
    @State private var posts: [Post] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var loadingMore = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
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
                        filter == nil ? "No posts yet" : "No \(filter!.label.lowercased()) posts",
                        systemImage: "doc.text",
                        description: Text("Posts you create will show up here.")
                    )
                } else {
                    List {
                        ForEach(posts) { post in
                            NavigationLink(value: post) { PostRow(post: post) }
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
            .navigationTitle("Posts")
            .navigationDestination(for: Post.self) { PostDetailView(post: $0) }
            .safeAreaInset(edge: .top, spacing: 0) { filterBar }
            .task { if posts.isEmpty { await reload() } }
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

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            let page: PostListPage = try await TRPCClient.shared.query(
                "post.list", input: PostListInput(status: filter?.rawValue, limit: 20)
            )
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
            let page: PostListPage = try await TRPCClient.shared.query(
                "post.list", input: PostListInput(status: filter?.rawValue, limit: 20, cursor: cursor)
            )
            let known = Set(posts.map(\.id))
            posts += page.posts.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor
        } catch {
            nextCursor = nil // stop the spinner; pull-to-refresh recovers
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

/// Read-only detail: full content + per-channel outcome.
struct PostDetailView: View {
    let post: Post
    var body: some View {
        List {
            Section {
                Text(post.content).font(.body).textSelection(.enabled)
            }
            Section("Status") {
                LabeledContent("State") { StatusBadge(status: post.status) }
                if let s = post.scheduledAt { LabeledContent("Scheduled", value: s.formatted(date: .abbreviated, time: .shortened)) }
                if let p = post.publishedAt { LabeledContent("Published", value: p.formatted(date: .abbreviated, time: .shortened)) }
                LabeledContent("Created", value: post.createdAt.formatted(date: .abbreviated, time: .shortened))
            }
            if !post.targets.isEmpty {
                Section("Channels (\(post.targets.count))") {
                    ForEach(post.targets) { t in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Label(t.channel.name, systemImage: t.channel.platform.systemImage)
                                    .foregroundStyle(t.channel.platform.tint)
                                Spacer()
                                StatusBadge(status: t.status)
                            }
                            if let url = t.publishedURL {
                                Link(destination: url) {
                                    Label("Open post", systemImage: "arrow.up.right.square").font(.caption)
                                }
                            }
                            if let err = t.errorMessage, t.status == .FAILED {
                                Text(err).font(.caption).foregroundStyle(.red).lineLimit(4)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .navigationTitle("Post")
        .navigationBarTitleDisplayMode(.inline)
    }
}
