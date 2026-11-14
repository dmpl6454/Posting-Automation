import SwiftUI

/// The live comment thread for one published post — the web's comment-thread:
/// comment on the post, reply, like/unlike, hide/unhide, delete (confirmed),
/// edit the Page's own Facebook comment, like the Instagram post.
///
/// ⚠️ Creating a comment, reply or like is NOT idempotent. An unknown outcome
/// reads "may already be posted", refreshes the thread, and the next send is
/// labelled "Send again anyway" — the app never retries on its own.
struct CommentThreadView: View {
    let targetId: String
    let title: String
    @Environment(SessionStore.self) private var session

    @State private var page: CommentThreadPage?
    @State private var comments: [SocialComment] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var notice: (title: String, detail: String)?

    @State private var newComment = ""
    @State private var newCommentUnconfirmed = false
    @State private var replyingTo: SocialComment?
    @State private var editing: SocialComment?
    @State private var confirmDelete: SocialComment?
    @State private var busyIds: Set<String> = []
    /// Instagram can't report "liked by us"; remember likes made here.
    @State private var likedHere: [String: Bool] = [:]
    @State private var postLiked: Bool?

    private var caps: CommentCapabilities { page?.capabilities ?? CommentCapabilities() }
    private var platform: String { page?.platform ?? "" }
    private var writeBlocked: String? { InboxRules.writeBlockedReason(caps, platform: platform) }

    var body: some View {
        List {
            if let reason = writeBlocked {
                Section { Label(reason, systemImage: "lock").font(.footnote).foregroundStyle(.orange) }
            } else if caps.known && caps.canLike == false && platform == "INSTAGRAM" {
                Section { Text("Liking isn't enabled for this account yet.").font(.footnote).foregroundStyle(.secondary) }
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }

            if page != nil { composerSection }

            Section {
                if let page, comments.isEmpty {
                    Text(page.totalCount.map { $0 > 0 ? "Comments exist but none can be shown here (for example, only replies)." : "No comments yet." } ?? "No comments yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(comments) { c in
                    commentRow(c, isReply: false)
                    ForEach(c.replies) { r in commentRow(r, isReply: true) }
                    if c.replyCount > c.replies.count {
                        Text("\(c.replyCount - c.replies.count) more repl\(c.replyCount - c.replies.count == 1 ? "y" : "ies") — open the post to see all")
                            .font(.caption).foregroundStyle(.secondary).padding(.leading, 28)
                    }
                }
                if nextCursor != nil {
                    Button("Load more comments") { Task { await load(more: true) } }.disabled(loading)
                }
            } header: {
                Text(page?.totalCount.map { "\($0) comment\($0 == 1 ? "" : "s")" } ?? "Comments")
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let url = page?.publishedUrl.flatMap(URL.init(string:)) {
                ToolbarItem(placement: .primaryAction) { Link(destination: url) { Image(systemName: "arrow.up.right.square") } }
            }
        }
        .refreshable { await load(more: false) }
        .task { if page == nil { await load(more: false) } }
        .overlay { if loading && page == nil { ProgressView() } }
        .sheet(item: $replyingTo) { c in
            ReplySheet(title: "Reply to \(InboxRules.authorName(c, accountName: page?.account?.name, namesHidden: caps.namesHidden))",
                       quoted: c.text) { text in await reply(to: c, text: text) }
        }
        .sheet(item: $editing) { c in
            ReplySheet(title: "Edit comment", quoted: nil, initial: c.text, sendLabel: "Save") { text in
                await moderate(c, .edit, message: text) ? .sent : .failed
            }
        }
        .confirmationDialog("Delete this comment?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                            titleVisibility: .visible, presenting: confirmDelete) { c in
            Button("Delete", role: .destructive) { Task { _ = await moderate(c, .delete) } }
        } message: { _ in Text("It's removed from \(platform == "INSTAGRAM" ? "Instagram" : "Facebook"). This can't be undone.") }
        .alert(notice?.title ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(notice?.detail ?? "") }
    }

    // MARK: Composer

    private var composerSection: some View {
        Section {
            TextField("Comment on this post as \(page?.account?.name ?? "your account")", text: $newComment, axis: .vertical)
                .lineLimit(1...5)
                .disabled(writeBlocked != nil)
            if newCommentUnconfirmed {
                Text("The last attempt wasn't confirmed and may already be posted. Check the comments below before posting again.")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Button(newCommentUnconfirmed ? "Post again anyway" : "Post comment") { Task { await create() } }
                    .disabled(writeBlocked != nil || newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busyIds.contains("new"))
                Spacer()
                if platform == "INSTAGRAM" {
                    Button(postLiked == true ? "Unlike post" : "Like post") { Task { await likePost(!(postLiked ?? false)) } }
                        .disabled(caps.known && caps.canLike == false || busyIds.contains("post"))
                }
            }
            .buttonStyle(.borderless)
        }
    }

    // MARK: Rows

    private func commentRow(_ c: SocialComment, isReply: Bool) -> some View {
        let liked = likedHere[c.id] ?? c.likedByAccount ?? false
        let busy = busyIds.contains(c.id)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(InboxRules.authorName(c, accountName: page?.account?.name, namesHidden: caps.namesHidden))
                    .font(.subheadline.weight(.semibold)).lineLimit(1)
                if c.isOwn { Text("You").font(.caption2).padding(.horizontal, 5).background(Color.accentColor.opacity(0.15), in: Capsule()) }
                if c.hidden { Label("Hidden", systemImage: "eye.slash").font(.caption2).foregroundStyle(.secondary) }
                Spacer()
                Text(InboxRules.relative(c.createdAt)).font(.caption2).foregroundStyle(.secondary)
            }
            if !c.text.isEmpty {
                Text(c.text).font(.subheadline).foregroundStyle(c.hidden ? .secondary : .primary).textSelection(.enabled)
            } else if let a = c.attachmentType {
                Text("[\(a.replacingOccurrences(of: "_", with: " "))]").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                if c.likeCount > 0 { Label("\(c.likeCount)", systemImage: "heart").font(.caption).foregroundStyle(.secondary) }
                if !isReply && c.canReply {
                    Button("Reply") { replyingTo = c }.disabled(writeBlocked != nil)
                }
                if c.canLike {
                    Button(liked ? "Unlike" : "Like") { Task { _ = await moderate(c, liked ? .unlike : .like) } }
                        .disabled(caps.known && caps.canLike == false)
                }
                if c.canHide {
                    Button(c.hidden ? "Unhide" : "Hide") { Task { _ = await moderate(c, c.hidden ? .unhide : .hide) } }
                        .disabled(caps.known && caps.canModerate == false)
                }
                if c.canEdit { Button("Edit") { editing = c } }
                if c.canDelete {
                    Button("Delete", role: .destructive) { confirmDelete = c }
                        .disabled(caps.known && caps.canModerate == false)
                }
                if busy { ProgressView().controlSize(.mini) }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.borderless)
            .disabled(busy)
        }
        .padding(.leading, isReply ? 28 : 0)
        .padding(.vertical, 2)
    }

    // MARK: Network

    private struct ListInput: Encodable { let targetId: String; var cursor: String? }
    private struct CreateInput: Encodable { let targetId: String; let message: String }
    private struct ReplyInput: Encodable { let targetId: String; let commentId: String; let message: String }
    private struct ModerateInput: Encodable { let targetId: String; let commentId: String; let action: String; var message: String? }
    private struct LikePostInput: Encodable { let targetId: String; let liked: Bool }
    private struct Ignored: Decodable {}

    private func load(more: Bool) async {
        loading = true
        defer { loading = false }
        do {
            let p: CommentThreadPage = try await TRPCClient.shared.query(
                "comment.list", input: ListInput(targetId: targetId, cursor: more ? nextCursor : nil)
            )
            page = p
            comments = more ? comments + p.comments.filter { n in !comments.contains { $0.id == n.id } } : p.comments
            nextCursor = p.nextCursor
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            // A failed refresh keeps what's already loaded.
            if comments.isEmpty { self.error = error.localizedDescription } else { notice = ("Couldn't refresh", error.localizedDescription) }
        }
    }

    private func create() async {
        let text = newComment.trimmingCharacters(in: .whitespacesAndNewlines)
        busyIds.insert("new")
        defer { busyIds.remove("new") }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("comment.create", input: CreateInput(targetId: targetId, message: text))
            newComment = ""
            newCommentUnconfirmed = false
            await load(more: false)
        } catch {
            if InboxRules.classify(error) == .unconfirmed {
                newCommentUnconfirmed = true
                notice = ("Comment not confirmed", "It may already be posted — check the thread before posting it again.")
                await load(more: false)
            } else {
                notice = ("Couldn't post the comment", error.localizedDescription)
            }
        }
    }

    /// Returns how the sheet should react.
    private func reply(to c: SocialComment, text: String) async -> ReplySheet.Outcome {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("comment.reply", input: ReplyInput(targetId: targetId, commentId: c.id, message: text))
            await load(more: false)
            return .sent
        } catch {
            if InboxRules.classify(error) == .unconfirmed {
                await load(more: false)
                return .unconfirmed
            }
            notice = ("Couldn't send the reply", error.localizedDescription)
            return .failed
        }
    }

    @discardableResult
    private func moderate(_ c: SocialComment, _ action: InboxRules.ModerationAction, message: String? = nil) async -> Bool {
        busyIds.insert(c.id)
        defer { busyIds.remove(c.id) }
        do {
            let r: ModerateResult = try await TRPCClient.shared.mutate(
                "comment.moderate", input: ModerateInput(targetId: targetId, commentId: c.id, action: action.rawValue, message: message)
            )
            comments = InboxRules.apply(comments, id: c.id, action: action, message: message,
                                        likeCount: r.likeCountSent ? .some(r.likeCount) : nil)
            if action == .like || action == .unlike { likedHere[c.id] = action == .like }
            return true
        } catch {
            if InboxRules.classify(error) == .unconfirmed {
                notice = ("Change not confirmed", "Refreshing the comments so you can see what happened.")
                await load(more: false)
            } else {
                notice = ("Couldn't do that", error.localizedDescription)
            }
            return false
        }
    }

    private func likePost(_ liked: Bool) async {
        busyIds.insert("post")
        defer { busyIds.remove("post") }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("comment.likePost", input: LikePostInput(targetId: targetId, liked: liked))
            postLiked = liked
        } catch {
            notice = (InboxRules.classify(error) == .unconfirmed ? "Like not confirmed" : "Couldn't like the post", error.localizedDescription)
        }
    }
}

/// A text box for a reply, edit or message. The caller does the network work
/// and says what happened; an unconfirmed send keeps the sheet open with an
/// explicit "Send again anyway".
struct ReplySheet: View {
    enum Outcome { case sent, unconfirmed, failed }
    let title: String
    let quoted: String?
    var initial = ""
    var sendLabel = "Send"
    let send: (String) async -> Outcome

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var unconfirmed = false

    var body: some View {
        NavigationStack {
            Form {
                if let quoted, !quoted.isEmpty {
                    Section("Replying to") { Text(quoted).font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    TextEditor(text: $text).frame(minHeight: 120)
                }
                if unconfirmed {
                    Section {
                        Text("That wasn't confirmed and may already be posted. The thread was refreshed — check it before sending again.")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(unconfirmed ? "Send again anyway" : sendLabel) {
                        Task {
                            sending = true
                            let outcome = await send(text.trimmingCharacters(in: .whitespacesAndNewlines))
                            sending = false
                            switch outcome {
                            case .sent: dismiss()
                            case .unconfirmed: unconfirmed = true
                            case .failed: break
                            }
                        }
                    }
                    .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .fontWeight(.semibold)
                }
            }
            .overlay { if sending { ProgressView() } }
            .onAppear { if text.isEmpty { text = initial } }
        }
    }
}
