import SwiftUI

/// Comments inbox — the web's /dashboard/comments: pick a Facebook Page or
/// Instagram account, then one of its posts published through PostAutomation,
/// then read and answer the live thread (CommentThreadView).
struct CommentsInboxView: View {
    @Environment(SessionStore.self) private var session
    @State private var accounts: [CommentAccount] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if accounts.isEmpty && !loading && error == nil {
                ContentUnavailableView("No Facebook or Instagram accounts", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Connect one on the web to answer comments here."))
            }
            ForEach(accounts) { a in
                NavigationLink { CommentPostsView(account: a) } label: {
                    HStack(spacing: 12) {
                        AvatarCircle(url: a.avatar, name: a.name, platform: a.platform)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(a.name).lineLimit(1)
                                if a.commentAccess?.known == true && a.commentAccess?.canReply == false {
                                    Text("Reconnect").font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .overlay(Capsule().stroke(.orange)).foregroundStyle(.orange)
                                }
                            }
                            Text("\(Platform(raw: a.platform).displayName) · \(a.publishedPosts) post\(a.publishedPosts == 1 ? "" : "s")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Comments")
        .refreshable { await load() }
        .task { if accounts.isEmpty { await load() } }
        .overlay { if loading && accounts.isEmpty { ProgressView() } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            accounts = try await TRPCClient.shared.query("comment.accounts")
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One account's published posts (comment.posts), newest first.
struct CommentPostsView: View {
    let account: CommentAccount
    @State private var items: [CommentPostItem] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if items.isEmpty && !loading && error == nil {
                Text("No posts published through PostAutomation on this account yet.").foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                NavigationLink { CommentThreadView(targetId: item.targetId, title: account.name) } label: {
                    HStack(spacing: 10) {
                        PostThumb(url: item.thumbnailUrl, isVideo: item.mediaKind == "video")
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.caption.isEmpty ? "(no caption)" : item.caption).font(.subheadline).lineLimit(2)
                            if let at = item.publishedAt {
                                Text(at, format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if nextCursor != nil {
                HStack { Spacer(); ProgressView(); Spacer() }.onAppear { Task { await load(more: true) } }
            }
        }
        .navigationTitle(account.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load(more: false) }
        .task { if items.isEmpty { await load(more: false) } }
    }

    private struct Input: Encodable { let channelId: String; var cursor: String?; let limit = 20 }

    private func load(more: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page: CommentPostsPage = try await TRPCClient.shared.query(
                "comment.posts", input: Input(channelId: account.id, cursor: more ? nextCursor : nil)
            )
            items = more ? items + page.items : page.items
            nextCursor = page.nextCursor
            error = nil
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }
}

struct AvatarCircle: View {
    let url: String?
    let name: String
    let platform: String
    var body: some View {
        ZStack {
            Circle().fill(Platform(raw: platform).tint.opacity(0.15))
            if let u = url.flatMap(URL.init(string:)) {
                AsyncImage(url: u) { p in
                    if case .success(let img) = p { img.resizable().scaledToFill() } else { initials }
                }
                .clipShape(Circle())
            } else { initials }
        }
        .frame(width: 36, height: 36)
    }
    private var initials: some View {
        Text(String(name.prefix(1)).uppercased()).font(.caption.weight(.bold)).foregroundStyle(Platform(raw: platform).tint)
    }
}

struct PostThumb: View {
    let url: String?
    let isVideo: Bool
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.15))
            if let u = url.flatMap(URL.init(string:)) {
                AsyncImage(url: u) { p in if case .success(let img) = p { img.resizable().scaledToFill() } }
            } else if isVideo {
                Image(systemName: "play.rectangle").foregroundStyle(.secondary)
            } else {
                Image(systemName: "text.alignleft").foregroundStyle(.secondary)
            }
        }
        .frame(width: 48, height: 48)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
