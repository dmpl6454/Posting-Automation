import SwiftUI

/// Places where other Instagram accounts @mentioned yours — the web's Mentions
/// inbox. Reply (a second reply needs an explicit "again"), dismiss/restore,
/// open on Instagram. Mentions arrive only through Meta's webhook.
struct MentionsView: View {
    @Environment(SessionStore.self) private var session
    @State private var show = "open"
    @State private var mentions: [InstagramMention] = []
    @State private var nextCursor: String?
    @State private var openCount = 0
    @State private var loading = false
    @State private var error: String?
    @State private var notice: (title: String, detail: String)?
    @State private var replying: InstagramMention?

    var body: some View {
        List {
            Section {
                Picker("Show", selection: $show) {
                    Text("Open").tag("open"); Text("Replied").tag("replied"); Text("Dismissed").tag("dismissed"); Text("All").tag("all")
                }
                .pickerStyle(.segmented)
            } footer: {
                Text("Mentions appear when Meta reports them for your connected Instagram accounts.")
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if mentions.isEmpty && !loading && error == nil {
                Text(show == "open" ? "No open mentions." : "Nothing here.").foregroundStyle(.secondary)
            }
            ForEach(mentions) { m in row(m) }
            if nextCursor != nil {
                HStack { Spacer(); ProgressView(); Spacer() }.onAppear { Task { await load(more: true) } }
            }
        }
        .navigationTitle(openCount > 0 ? "Mentions (\(openCount))" : "Mentions")
        .refreshable { await load(more: false) }
        .task(id: show) { await load(more: false) }
        .sheet(item: $replying) { m in
            ReplySheet(title: "Reply to @\(m.username ?? "them")", quoted: m.text) { text in await reply(m, text: text) }
        }
        .alert(notice?.title ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(notice?.detail ?? "") }
    }

    private func row(_ m: InstagramMention) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("@\(m.username ?? "someone")").font(.subheadline.weight(.semibold))
                Text(m.kind == "comment" ? "in a comment" : "in a post").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if let at = m.mentionedAt ?? m.receivedAt { Text(at, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(.secondary) }
            }
            if let t = m.text, !t.isEmpty { Text(t).font(.subheadline).lineLimit(4) }
            if let e = m.detailsError { Text(e).font(.caption).foregroundStyle(.orange) }
            if let account = m.account?.name { Text("Mentioned \(account)").font(.caption).foregroundStyle(.secondary) }
            if m.replyStatus == "SENT" { Label("Replied: \(m.replyText ?? "")", systemImage: "arrowshape.turn.up.left").font(.caption).foregroundStyle(.green).lineLimit(2) }
            if m.replyStatus == "UNCONFIRMED" { Label("Reply not confirmed — it may already be posted. Check on Instagram.", systemImage: "questionmark.circle").font(.caption).foregroundStyle(.orange) }
            HStack(spacing: 16) {
                if m.account?.disconnected != true {
                    Button(m.replyStatus == nil ? "Reply" : "Reply again") { replying = m }
                        .disabled(m.account?.canReply == false)
                }
                Button(m.dismissedAt == nil ? "Dismiss" : "Restore") { Task { await dismiss(m, m.dismissedAt == nil) } }
                if let url = m.permalink.flatMap(URL.init(string:)) { Link("Open", destination: url) }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }

    private struct ListInput: Encodable { let show: String; var cursor: String? }
    private struct ReplyInput: Encodable { let mentionId: String; let message: String; var again: Bool? }
    private struct DismissInput: Encodable { let mentionId: String; let dismissed: Bool }
    private struct Ignored: Decodable {}

    private func load(more: Bool) async {
        loading = true
        defer { loading = false }
        do {
            let p: MentionsPage = try await TRPCClient.shared.query("comment.mentions", input: ListInput(show: show, cursor: more ? nextCursor : nil))
            mentions = more ? mentions + p.mentions : p.mentions
            nextCursor = p.nextCursor
            openCount = p.openCount
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }

    private func reply(_ m: InstagramMention, text: String) async -> ReplySheet.Outcome {
        do {
            // A mention that already has a reply needs `again`, so a second
            // reply is always a deliberate choice.
            let _: Ignored = try await TRPCClient.shared.mutate(
                "comment.replyMention", input: ReplyInput(mentionId: m.id, message: text, again: m.replyStatus != nil ? true : nil)
            )
            await load(more: false)
            return .sent
        } catch {
            if InboxRules.classify(error) == .unconfirmed { await load(more: false); return .unconfirmed }
            notice = ("Couldn't send the reply", error.localizedDescription)
            return .failed
        }
    }

    private func dismiss(_ m: InstagramMention, _ value: Bool) async {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("comment.dismissMention", input: DismissInput(mentionId: m.id, dismissed: value))
            await load(more: false)
        } catch {
            notice = ("Couldn't update the mention", error.localizedDescription)
        }
    }
}
