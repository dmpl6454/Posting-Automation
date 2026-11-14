import SwiftUI

/// Post page — the mobile counterpart of /dashboard/posts/[id]. Loads the
/// post fresh (post.getById) and offers what the web offers:
/// edit (drafts/scheduled), publish all / retry per channel, "It didn't
/// publish" for a channel the platform never confirmed, per-channel caption,
/// delete from Facebook/Instagram, archive, delete. Rules live in PostRules.
struct PostDetailView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let postId: String
    var onChange: () -> Void = {}

    @State private var post: Post?
    @State private var loading = false
    @State private var error: String?
    @State private var busy = false
    @State private var notice: (title: String, detail: String)?
    @State private var showEdit = false
    @State private var confirm: Confirm?
    @State private var captionTarget: PostTarget?

    enum Confirm: Identifiable {
        case publishAll([PostTarget])
        case retry(PostTarget)
        case clearCheck(PostTarget)
        case deleteFromPlatforms(targets: [PostTarget]?, label: String)
        case deletePost
        case cancelSchedule
        var id: String {
            switch self {
            case .publishAll: return "publishAll"
            case .retry(let t): return "retry-\(t.id)"
            case .clearCheck(let t): return "clear-\(t.id)"
            case .deleteFromPlatforms(let ts, _): return "pdel-\(ts?.map(\.id).joined() ?? "all")"
            case .deletePost: return "delete"
            case .cancelSchedule: return "cancel"
            }
        }
    }

    init(postId: String, onChange: @escaping () -> Void = {}) {
        self.postId = postId
        self.onChange = onChange
    }

    /// Kept for existing call sites that pass a listed post.
    init(post: Post, onChange: @escaping () -> Void = {}) {
        self.postId = post.id
        self.onChange = onChange
        _post = State(initialValue: post)
    }

    var body: some View {
        Group {
            if let post {
                content(post)
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't load the post", systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: {
                    Button("Retry") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Post")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if let post { toolbar(post) } }
        .task { await load() }
        .refreshable { await load() }
        .overlay { if busy { ProgressView().controlSize(.large) } }
        .alert(notice?.title ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(notice?.detail ?? "") }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
                            titleVisibility: .visible, presenting: confirm) { c in
            confirmButtons(c)
        } message: { c in Text(confirmMessage(c)) }
        .sheet(isPresented: $showEdit) {
            if let post { EditPostSheet(post: post) { Task { await load(); onChange() } } }
        }
        .sheet(item: $captionTarget) { t in
            ChannelCaptionSheet(target: t, sharedCaption: post?.content ?? "") { Task { await load() } }
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ post: Post) -> some View {
        List {
            Section {
                if post.content.isEmpty {
                    Text("No caption").foregroundStyle(.secondary)
                } else {
                    Text(post.content).textSelection(.enabled)
                }
                if let media = post.mediaAttachments, !media.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(media, id: \.media.id) { m in MediaThumb(attachment: m) }
                        }
                    }
                }
            }

            Section("Status") {
                LabeledContent("State") { StatusBadge(status: post.status) }
                if let s = post.scheduledAt { LabeledContent("Scheduled", value: s.formatted(date: .abbreviated, time: .shortened)) }
                if let p = post.publishedAt { LabeledContent("Published", value: p.formatted(date: .abbreviated, time: .shortened)) }
                LabeledContent("Created", value: post.createdAt.formatted(date: .abbreviated, time: .shortened))
                if let label = post.campaignLabel, !label.isEmpty { LabeledContent("Campaign", value: label) }
                if post.archivedAt != nil { Label("Archived", systemImage: "archivebox").foregroundStyle(.secondary) }
            }

            if post.targets.isEmpty {
                Section("Channels") {
                    Text("No channels yet. Add them from the web post page, then publish.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                Section("Channels (\(post.targets.count))") {
                    ForEach(post.targets) { t in targetRow(t, post: post) }
                }
            }

            let parked = post.targets.filter(\.needsCheck)
            if !parked.isEmpty {
                // Deliberately not styled as a failure: the post may be live.
                Section {
                    ForEach(parked) { t in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(t.channel.name) (\(t.channel.platform.displayName)) — may already be published")
                                .font(.footnote.weight(.semibold))
                            Text(t.ambiguousReason ?? "The platform did not confirm this post. Nothing was re-sent, so there is no duplicate.")
                                .font(.footnote)
                            Text("Open the account and check. If the post is there, no action is needed. If it is not, use \u{201C}It didn't publish\u{201D} to allow a retry.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func targetRow(_ t: PostTarget, post: Post) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                ChannelAvatar(channel: t.channel)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.channel.name).lineLimit(1)
                    HStack(spacing: 4) {
                        Text(t.channel.platform.displayName)
                        if t.format == "STORY" { Text("· Story") }
                        if t.contentOverride != nil { Text("· Own caption") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if t.needsCheck {
                    Text("Needs check").font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .overlay(Capsule().stroke(.orange))
                        .foregroundStyle(.orange)
                } else if t.platformDeletedAt != nil {
                    Text("Deleted").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                } else {
                    StatusBadge(status: t.status)
                }
            }

            if t.status == .FAILED, !t.needsCheck, let err = t.errorMessage {
                Text(err).font(.caption).foregroundStyle(.red).lineLimit(6)
                if let n = t.retryCount, n > 0 {
                    Text("Retried \(n) time\(n == 1 ? "" : "s")").font(.caption2).foregroundStyle(.secondary)
                }
            }
            if let line = PostRules.firstCommentLine(t.metadata?.firstComment) {
                Text(line.text).font(.caption).foregroundStyle(color(line.tone))
            }
            let del = PostRules.deleteState(t)
            if let line = PostRules.deleteLine(del, platform: t.channel.platform.raw) {
                Text(line.text).font(.caption).foregroundStyle(color(line.tone))
            }

            HStack(spacing: 14) {
                if t.needsCheck {
                    Button("It didn't publish") { confirm = .clearCheck(t) }
                } else if PostRules.canRetry(t) {
                    Button(t.status == .FAILED ? "Retry" : "Publish") { confirm = .retry(t) }
                }
                if let url = t.publishedURL, t.platformDeletedAt == nil {
                    Link("View", destination: url)
                }
                if t.status != .PUBLISHED && t.status != .PUBLISHING && post.status != .PUBLISHING {
                    Button(t.contentOverride == nil ? "Own caption" : "Edit caption") { captionTarget = t }
                }
                if PostRules.canRequestDelete(del) {
                    Button("Delete from \(PostRules.platformName(t.channel.platform.raw))", role: .destructive) {
                        confirm = .deleteFromPlatforms(targets: [t], label: "\(t.channel.name) on \(PostRules.platformName(t.channel.platform.raw))")
                    }
                }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    private func color(_ tone: PostRules.Tone) -> Color {
        switch tone {
        case .muted: return .secondary
        case .ok: return .green
        case .warn: return .orange
        case .error: return .red
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private func toolbar(_ post: Post) -> some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if post.isEditable {
                    Button { showEdit = true } label: { Label("Edit", systemImage: "pencil") }
                }
                if post.status == .SCHEDULED {
                    Button { confirm = .cancelSchedule } label: { Label("Cancel schedule", systemImage: "calendar.badge.minus") }
                }
                if post.targets.contains(where: { [.FAILED, .DRAFT, .SCHEDULED].contains($0.status) }) {
                    Button { publishAll(post) } label: { Label("Publish now", systemImage: "paperplane") }
                }
                let deletable = post.targets.filter { PostRules.canRequestDelete(PostRules.deleteState($0)) }
                if !deletable.isEmpty {
                    Button(role: .destructive) {
                        confirm = .deleteFromPlatforms(targets: nil, label: "\(deletable.count) channel\(deletable.count == 1 ? "" : "s")")
                    } label: { Label("Delete from Facebook/Instagram", systemImage: "trash.slash") }
                }
                if post.archivedAt == nil {
                    if post.status != .SCHEDULED && post.status != .PUBLISHING {
                        Button { Task { await run("post.archive", IdInput(id: post.id), done: "Archived") } } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
                } else {
                    Button { Task { await run("post.unarchive", IdInput(id: post.id), done: "Moved back to Posts") } } label: {
                        Label("Unarchive", systemImage: "tray.and.arrow.up")
                    }
                }
                Button(role: .destructive) { confirm = .deletePost } label: { Label("Delete post", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("Post actions")
        }
    }

    // MARK: Confirmations

    private var confirmTitle: String {
        switch confirm {
        case .publishAll(let ts): return "Publish to \(ts.count) channel\(ts.count == 1 ? "" : "s")?"
        case .retry(let t): return "\(t.status == .FAILED ? "Retry" : "Publish") on \(t.channel.name)?"
        case .clearCheck(let t): return "Did it really not publish on \(t.channel.name)?"
        case .deleteFromPlatforms(_, let label): return "Delete the live post from \(label)?"
        case .deletePost: return "Delete this post?"
        case .cancelSchedule: return "Cancel the schedule?"
        case nil: return ""
        }
    }

    private func confirmMessage(_ c: Confirm) -> String {
        switch c {
        case .publishAll, .retry: return "It goes live right away."
        case .clearCheck: return "Only do this after checking the account: if the post IS there, retrying publishes it a second time."
        case .deleteFromPlatforms: return "It is removed from Facebook/Instagram. The post and its history stay here. This can't be undone."
        case .deletePost: return "The post is removed from PostAutomation. Posts already live on the platforms stay there. This can't be undone."
        case .cancelSchedule: return "It goes back to drafts and won't publish."
        }
    }

    @ViewBuilder
    private func confirmButtons(_ c: Confirm) -> some View {
        switch c {
        case .publishAll(let ts):
            Button("Publish now") { Task { await run("post.publishNow", PublishNowInput(id: postId, targetIds: ts.map(\.id)), done: "Publishing") } }
        case .retry(let t):
            Button(t.status == .FAILED ? "Retry" : "Publish") {
                Task { await run("post.publishNow", PublishNowInput(id: postId, targetIds: [t.id]), done: "Publishing on \(t.channel.name)") }
            }
        case .clearCheck(let t):
            Button("It didn't publish — allow retry") {
                Task { await run("post.clearPublishAmbiguity", ClearCheckInput(id: postId, targetIds: [t.id]), done: "Retry unlocked for \(t.channel.name)") }
            }
        case .deleteFromPlatforms(let ts, _):
            Button("Delete from the platform", role: .destructive) { Task { await deleteFromPlatforms(ts) } }
        case .deletePost:
            Button("Delete post", role: .destructive) { Task { await deletePost() } }
        case .cancelSchedule:
            Button("Cancel schedule") { Task { await run("post.update", CancelScheduleInput(id: postId), done: "Moved to drafts") } }
        }
        Button("Keep", role: .cancel) {}
    }

    // MARK: Actions

    private struct IdInput: Encodable { let id: String }
    private struct PublishNowInput: Encodable { let id: String; let targetIds: [String] }
    private struct ClearCheckInput: Encodable { let id: String; let targetIds: [String] }
    private struct PlatformDeleteInput: Encodable { let postId: String; let targetIds: [String]? }
    /// `scheduledAt: null` (explicitly) cancels a schedule.
    private struct CancelScheduleInput: Encodable {
        let id: String
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(id, forKey: .id)
            try c.encodeNil(forKey: .scheduledAt)
        }
        enum Keys: String, CodingKey { case id, scheduledAt }
    }
    private struct Ignored: Decodable {}

    private func publishAll(_ post: Post) {
        let plan = PostRules.publishAllPlan(post.targets)
        if plan.eligible.isEmpty {
            notice = PostRules.nothingToPublishMessage(parked: plan.parked)
        } else {
            confirm = .publishAll(plan.eligible)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            post = try await TRPCClient.shared.query("post.getById", input: IdInput(id: postId))
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            if post == nil { self.error = error.localizedDescription }
        }
    }

    private func run<I: Encodable>(_ path: String, _ input: I, done: String) async {
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate(path, input: input)
            notice = (done, "")
            await load()
            onChange()
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            notice = ("Couldn't do that", error.localizedDescription)
        }
    }

    private func deleteFromPlatforms(_ targets: [PostTarget]?) async {
        busy = true
        defer { busy = false }
        do {
            let summary: PostRules.DeleteRequestSummary = try await TRPCClient.shared.mutate(
                "post.deleteFromPlatforms", input: PlatformDeleteInput(postId: postId, targetIds: targets?.map(\.id))
            )
            notice = PostRules.deleteRequestMessage(summary)
            await load()
        } catch {
            notice = ("Couldn't start the delete", error.localizedDescription)
        }
    }

    private func deletePost() async {
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("post.delete", input: IdInput(id: postId))
            onChange()
            dismiss()
        } catch {
            notice = ("Couldn't delete the post", error.localizedDescription)
        }
    }
}

/// A thumbnail for a post's photo or video.
struct MediaThumb: View {
    let attachment: PostMediaAttachment
    var body: some View {
        ZStack {
            if attachment.isVideo {
                RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.2))
                Image(systemName: "play.circle.fill").font(.title2).foregroundStyle(.secondary)
            } else {
                AsyncImage(url: URL(string: attachment.media.url)) { phase in
                    if case .success(let img) = phase { img.resizable().scaledToFill() } else { Color.secondary.opacity(0.15) }
                }
            }
        }
        .frame(width: 72, height: 72)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
