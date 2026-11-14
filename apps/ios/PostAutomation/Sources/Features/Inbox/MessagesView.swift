import SwiftUI

/// Messages — the web's /dashboard/messages: Facebook Page and Instagram
/// conversations, live from Meta. Sending respects Meta's reply window and,
/// like comments, never retries an unconfirmed send.
struct MessagesView: View {
    @Environment(SessionStore.self) private var session
    @State private var accounts: [MessagingAccount] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if accounts.isEmpty && !loading && error == nil {
                ContentUnavailableView("No Facebook or Instagram accounts", systemImage: "envelope",
                                       description: Text("Connect one on the web to read messages here."))
            }
            ForEach(accounts) { a in
                NavigationLink { ConversationsView(account: a) } label: {
                    HStack(spacing: 12) {
                        AvatarCircle(url: a.avatar, name: a.name, platform: a.platform)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.name).lineLimit(1)
                            Text(Platform(raw: a.platform).displayName).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if a.messageAccess?.known == true && a.messageAccess?.canUseInbox == false {
                            Text("Not enabled").font(.caption2).foregroundStyle(.orange)
                        }
                    }
                }
            }
        }
        .navigationTitle("Messages")
        .refreshable { await load() }
        .task { if accounts.isEmpty { await load() } }
        .overlay { if loading && accounts.isEmpty { ProgressView() } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            accounts = try await TRPCClient.shared.query("message.accounts")
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ConversationsView: View {
    let account: MessagingAccount
    @State private var conversations: [SocialConversation] = []
    @State private var nextCursor: String?
    @State private var blocked = false
    @State private var missing: [String] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if blocked {
                Section {
                    Text("Messages aren't enabled for this account" + (missing.isEmpty ? "." : " (missing: \(missing.joined(separator: ", ")))."
                         ) + " Reconnect it on the web Channels page.")
                        .font(.footnote).foregroundStyle(.orange)
                }
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if conversations.isEmpty && !loading && !blocked && error == nil {
                Text("No conversations.").foregroundStyle(.secondary)
            }
            ForEach(conversations) { c in
                NavigationLink { ChatView(account: account, conversation: c) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(c.participant?.display ?? "Conversation").font(.subheadline.weight(.semibold)).lineLimit(1)
                            if let n = c.unreadCount, n > 0 {
                                Text("\(n)").font(.caption2.bold()).padding(.horizontal, 6).background(Color.accentColor, in: Capsule()).foregroundStyle(.white)
                            }
                            Spacer()
                            Text(InboxRules.relative(c.updatedAt)).font(.caption2).foregroundStyle(.secondary)
                        }
                        Text((c.lastFromAccount == true ? "You: " : "") + c.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2)
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
        .task { if conversations.isEmpty { await load(more: false) } }
        .overlay { if loading && conversations.isEmpty { ProgressView() } }
    }

    private struct Input: Encodable { let channelId: String; var cursor: String? }

    private func load(more: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let p: ConversationsPage = try await TRPCClient.shared.query("message.conversations", input: Input(channelId: account.id, cursor: more ? nextCursor : nil))
            conversations = more ? conversations + p.conversations : p.conversations
            nextCursor = p.nextCursor
            blocked = p.blocked == true
            missing = p.capabilities?.missingForInbox ?? []
            error = nil
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }
}

struct ChatView: View {
    let account: MessagingAccount
    let conversation: SocialConversation
    @State private var thread: ConversationThread?
    @State private var text = ""
    @State private var sending = false
    @State private var unconfirmed = false
    @State private var error: String?
    @State private var notice: String?

    private var windowClosed: Bool { thread?.windowOpen == false }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        if let error { Text(error).font(.footnote).foregroundStyle(.red).padding() }
                        ForEach(thread?.messages ?? []) { m in bubble(m).id(m.id) }
                    }
                    .padding()
                }
                .onChange(of: thread?.messages.count) { _, _ in
                    if let last = thread?.messages.last?.id { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
            Divider()
            composer
        }
        .navigationTitle(conversation.participant?.display ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    private func bubble(_ m: SocialMessage) -> some View {
        HStack {
            if m.fromAccount { Spacer(minLength: 40) }
            VStack(alignment: m.fromAccount ? .trailing : .leading, spacing: 2) {
                if !m.text.isEmpty {
                    Text(m.text)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(m.fromAccount ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                        .foregroundStyle(m.fromAccount ? .white : .primary)
                }
                ForEach(Array((m.attachments ?? []).enumerated()), id: \.offset) { _, a in
                    if let u = (a.previewUrl ?? a.url).flatMap(URL.init(string:)), a.kind == "image" {
                        AsyncImage(url: u) { p in if case .success(let img) = p { img.resizable().scaledToFit() } else { Color.secondary.opacity(0.2) } }
                            .frame(maxWidth: 200, maxHeight: 200).clipShape(RoundedRectangle(cornerRadius: 12))
                    } else {
                        Label(a.name ?? a.kind.capitalized, systemImage: "paperclip").font(.caption)
                    }
                }
                Text(InboxRules.relative(m.createdAt)).font(.caption2).foregroundStyle(.secondary)
            }
            if !m.fromAccount { Spacer(minLength: 40) }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if windowClosed {
                Text("You can only reply within Meta's reply window after their last message. It has closed for this conversation.")
                    .font(.caption).foregroundStyle(.orange)
            } else if unconfirmed {
                Text("That message wasn't confirmed and may already have been sent. Check the conversation before sending again.")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack(alignment: .bottom) {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .disabled(windowClosed)
                Button(unconfirmed ? "Send again" : "Send") { Task { await send() } }
                    .disabled(windowClosed || sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .fontWeight(.semibold)
            }
        }
        .padding()
    }

    private struct ThreadInput: Encodable { let channelId: String; let conversationId: String }
    private struct SendInput: Encodable { let channelId: String; let conversationId: String; let text: String }
    private struct Ignored: Decodable {}

    private func load() async {
        do {
            thread = try await TRPCClient.shared.query("message.thread", input: ThreadInput(channelId: account.id, conversationId: conversation.id))
            error = nil
        } catch {
            if thread == nil { self.error = error.localizedDescription }
        }
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate(
                "message.send", input: SendInput(channelId: account.id, conversationId: conversation.id, text: text.trimmingCharacters(in: .whitespacesAndNewlines))
            )
            text = ""
            unconfirmed = false
            await load()
        } catch {
            if InboxRules.classify(error) == .unconfirmed {
                unconfirmed = true
                await load()
            } else {
                notice = error.localizedDescription
            }
        }
    }
}
