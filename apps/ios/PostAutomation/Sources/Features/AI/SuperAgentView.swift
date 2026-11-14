import SwiftUI
import PhotosUI

/// Super Agent — the web's chat assistant. Replies stream from
/// `/api/chat/stream`. Suggested actions run only when you tap them; anything
/// that creates or publishes a post asks first and can't run twice (the
/// server dedupes on the action's key).
struct SuperAgentView: View {
    @Environment(SessionStore.self) private var session
    @State private var threads: [ChatThreadSummary] = []
    @State private var loading = false
    @State private var error: String?
    @State private var openThread: String?
    @State private var creating = false

    var body: some View {
        List {
            Section {
                Button { Task { await newThread() } } label: { Label("New chat", systemImage: "square.and.pencil") }
                    .disabled(creating)
                    .accessibilityIdentifier("agent.new")
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            Section {
                if threads.isEmpty && !loading && error == nil {
                    Text("No chats yet. Ask the agent to draft, schedule or analyse posts.").foregroundStyle(.secondary)
                }
                ForEach(threads) { t in
                    Button { openThread = t.id } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(t.title).foregroundStyle(.primary).lineLimit(1)
                            if let p = t.preview, !p.isEmpty { Text(p).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                    }
                    .accessibilityIdentifier("agent.thread")
                }
                .onDelete { idx in
                    let ids = idx.map { threads[$0].id }
                    Task { for id in ids { await delete(id) } }
                }
            } header: { if !threads.isEmpty { Text("Chats") } }
        }
        .navigationTitle("Super Agent")
        .navigationDestination(item: $openThread) { id in AgentChatView(threadId: id) }
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && threads.isEmpty { ProgressView() } }
    }

    private struct CreateInput: Encodable { let title: String }
    private struct Created: Decodable { let id: String }
    private struct IdInput: Encodable { let id: String }
    private struct Ignored: Decodable {}

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            threads = try await TRPCClient.shared.query("chat.listThreads")
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func newThread() async {
        creating = true
        defer { creating = false }
        do {
            let t: Created = try await TRPCClient.shared.mutate("chat.createThread", input: CreateInput(title: "New Chat"))
            await load()
            openThread = t.id
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ id: String) async {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("chat.deleteThread", input: IdInput(id: id))
            threads.removeAll { $0.id == id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct AgentChatView: View {
    let threadId: String
    @State private var messages: [ChatMessageDTO] = []
    @State private var executed: Set<String> = []
    @State private var streaming: String?
    @State private var text = ""
    @State private var sending = false
    @State private var running: String?
    @State private var error: String?
    @State private var confirming: ChatMessageDTO?
    @State private var pick: PhotosPickerItem?
    @State private var attachments: [(id: String, thumb: UIImage?)] = []
    @State private var uploading = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if messages.isEmpty && streaming == nil {
                            Text("Ask for a caption, a schedule for next week, or how your posts did this month.")
                                .font(.footnote).foregroundStyle(.secondary).padding(.top, 24)
                        }
                        ForEach(messages) { m in bubble(m).id(m.id) }
                        if let streaming {
                            Text(streaming.isEmpty ? "…" : streaming)
                                .padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                                .id("streaming")
                        }
                        if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                    }
                    .padding()
                }
                .onChange(of: messages.count) { _, _ in if let last = messages.last?.id { proxy.scrollTo(last, anchor: .bottom) } }
                .onChange(of: streaming) { _, _ in proxy.scrollTo("streaming", anchor: .bottom) }
            }
            Divider()
            composer
        }
        .navigationTitle("Super Agent")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let m = confirming {
                Button(m.action?.type == "publish_now" ? "Publish now" : "Run", role: m.action?.type == "publish_now" ? .destructive : nil) {
                    Task { await run(m) }
                }
            }
        } message: { Text(confirmMessage) }
        .onChange(of: pick) { _, item in
            guard let item else { return }
            pick = nil
            Task { await attach(item) }
        }
    }

    private var confirmTitle: String { AIRules.actionTitle(confirming?.action?.type ?? "") + "?" }
    private var confirmMessage: String {
        switch confirming?.action?.type {
        case "publish_now": return "This publishes immediately to the selected channels. It can't be undone."
        case "schedule_post", "bulk_schedule": return "This schedules real posts to your channels."
        default: return "The agent will carry out this action."
        }
    }

    @ViewBuilder
    private func bubble(_ m: ChatMessageDTO) -> some View {
        let mine = m.role == "user"
        HStack {
            if mine { Spacer(minLength: 40) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                if !m.attachments.isEmpty {
                    HStack {
                        ForEach(m.attachments, id: \.media.id) { a in
                            if let u = (a.media.fileType?.hasPrefix("video/") == true ? a.media.thumbnailUrl : (a.media.thumbnailUrl ?? a.media.url)).flatMap(URL.init(string:)) {
                                AsyncImage(url: u) { p in if case .success(let i) = p { i.resizable().scaledToFill() } else { Color.secondary.opacity(0.2) } }
                                    .frame(width: 80, height: 80).clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                }
                if !m.content.isEmpty {
                    Text(LocalizedStringKey(m.content))
                        .textSelection(.enabled)
                        .padding(10)
                        .background(mine ? Color.accentColor : (m.role == "system" ? Color.orange.opacity(0.15) : Color(.secondarySystemBackground)),
                                    in: RoundedRectangle(cornerRadius: 14))
                        .foregroundStyle(mine ? .white : .primary)
                }
                if let action = m.action, m.role == "assistant" { actionCard(m, action) }
            }
            if !mine { Spacer(minLength: 40) }
        }
    }

    private func actionCard(_ m: ChatMessageDTO, _ action: ChatAction) -> some View {
        let key = AIRules.actionKey(m)
        return VStack(alignment: .leading, spacing: 6) {
            if action.type == "publish_now" && !executed.contains(key) {
                Label("Publishes immediately. It can't be undone.", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Text(AIRules.actionTitle(action.type)).font(.caption.weight(.semibold))
                Spacer()
                if executed.contains(key) {
                    Label("Done", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
                } else {
                    Button(action.type == "publish_now" ? "Publish now" : "Run") { confirming = m }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(running != nil)
                        .accessibilityIdentifier("agent.action")
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.3)))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !attachments.isEmpty || uploading {
                HStack {
                    ForEach(attachments, id: \.id) { a in
                        ZStack(alignment: .topTrailing) {
                            Image(uiImage: a.thumb ?? UIImage()).resizable().scaledToFill()
                                .frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 6))
                                .background(Color.secondary.opacity(0.2), in: RoundedRectangle(cornerRadius: 6))
                            Button { attachments.removeAll { $0.id == a.id } } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .offset(x: 6, y: -6)
                        }
                    }
                    if uploading { ProgressView() }
                }
            }
            HStack(alignment: .bottom) {
                PhotosPicker(selection: $pick, matching: .images) { Image(systemName: "paperclip") }
                    .disabled(uploading || sending || attachments.count >= 4)
                TextField("Message the agent", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("agent.input")
                Button("Send") { Task { await send() } }
                    .fontWeight(.semibold)
                    .disabled(sending || uploading || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("agent.send")
            }
        }
        .padding()
    }

    private struct ThreadInput: Encodable { let id: String; let limit: Int }
    private struct SendInput: Encodable { let threadId: String; let content: String; var attachmentMediaIds: [String]? }
    private struct ActionInput: Encodable { let threadId: String; let actionType: String; let payload: [String: JSONValue]; let clientActionId: String }
    private struct Ignored: Decodable {}

    private func load() async {
        do {
            let t: ChatThreadDetail = try await TRPCClient.shared.query("chat.getThread", input: ThreadInput(id: threadId, limit: 100))
            messages = t.messages
            executed.formUnion(AIRules.executedKeys(t.messages))
            error = nil
        } catch {
            if messages.isEmpty { self.error = error.localizedDescription }
        }
    }

    /// The thread's latest images, which post actions attach (as on the web).
    private var threadMediaIds: [String] {
        messages.last(where: { $0.role == "user" && !$0.attachments.isEmpty })?.attachments.map(\.media.id) ?? []
    }

    private func attach(_ item: PhotosPickerItem) async {
        uploading = true
        defer { uploading = false }
        do {
            let p = try await AttachmentPreparer.prepare(item)
            defer { try? FileManager.default.removeItem(at: p.url) }
            let up = try await MediaUploader().upload(fileURL: p.url, fileName: p.fileName, mimeType: p.mimeType) { _ in }
            attachments.append((up.id, p.thumbnail))
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() async {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        sending = true
        defer { sending = false }
        error = nil
        let ids = attachments.map(\.id)
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("chat.sendMessage",
                input: SendInput(threadId: threadId, content: content, attachmentMediaIds: ids.isEmpty ? nil : ids))
        } catch {
            self.error = "Couldn't send: \(error.localizedDescription)"
            return
        }
        text = ""
        attachments = []
        await load()
        streaming = ""
        do {
            for try await event in TRPCClient.shared.streamChat(threadId: threadId) {
                switch event {
                case .chunk(let c): streaming = (streaming ?? "") + c
                case .done: break
                case .error(let msg): error = msg
                }
            }
        } catch {
            self.error = "The reply was interrupted. Showing what the server saved."
        }
        streaming = nil
        // The server saved the reply (with its action key); show the saved copy.
        await load()
    }

    private func run(_ m: ChatMessageDTO) async {
        guard let action = m.action else { return }
        let key = AIRules.actionKey(m)
        guard !executed.contains(key) else { return }
        running = key
        defer { running = nil }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("chat.executeAction", input: ActionInput(
                threadId: threadId, actionType: action.type,
                payload: AIRules.payloadWithMedia(action, mediaIds: threadMediaIds), clientActionId: key
            ), long: true)
            executed.insert(key)
            await load()
        } catch {
            // Only a success locks the button. The key makes a retry safe:
            // the server returns "already done" instead of a second post.
            messages.append(ChatMessageDTO(id: "err-\(UUID().uuidString)", role: "system",
                                           content: "Action failed: \(error.localizedDescription)"))
        }
    }
}
