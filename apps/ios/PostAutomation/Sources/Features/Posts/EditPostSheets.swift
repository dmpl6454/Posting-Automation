import SwiftUI

/// Edit a draft or scheduled post: caption, schedule, campaign label
/// (post.update). Channels and media are changed on the web for now.
struct EditPostSheet: View {
    let post: Post
    var onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var scheduled: Bool
    @State private var scheduledAt: Date
    @State private var campaign: String
    @State private var saving = false
    @State private var error: String?

    init(post: Post, onSaved: @escaping () -> Void) {
        self.post = post
        self.onSaved = onSaved
        _content = State(initialValue: post.content)
        _scheduled = State(initialValue: post.scheduledAt != nil)
        _scheduledAt = State(initialValue: post.scheduledAt ?? Date().addingTimeInterval(3600))
        _campaign = State(initialValue: post.campaignLabel ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Caption") {
                    TextEditor(text: $content).frame(minHeight: 140)
                }
                Section {
                    Toggle("Scheduled", isOn: $scheduled.animation())
                    if scheduled {
                        DatePicker("Publish at", selection: $scheduledAt, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    }
                } footer: {
                    if !scheduled && post.scheduledAt != nil { Text("Turning this off moves the post back to drafts.") }
                    if scheduled && post.targets.isEmpty { Text("Add channels on the web before scheduling.").foregroundStyle(.orange) }
                }
                Section("Campaign (optional)") {
                    TextField("e.g. Diwali 2026", text: $campaign)
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Edit post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(saving).fontWeight(.semibold)
                }
            }
            .overlay { if saving { ProgressView() } }
        }
    }

    private struct Ignored: Decodable {}

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        let input = PostRulesEdit.makeUpdate(
            post: post, content: content, scheduled: scheduled, scheduledAt: scheduledAt, campaign: campaign
        )
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("post.update", input: input)
            onSaved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// `post.update` input with explicit-null support: `scheduledAt: null` cancels
/// a schedule and `campaignLabel: null` clears the label, while an omitted key
/// leaves the field alone.
struct UpdatePostInput: Encodable, Equatable {
    enum Field<T: Equatable>: Equatable { case keep, clear, set(T) }
    let id: String
    var content: Field<String> = .keep
    var scheduledAt: Field<String> = .keep
    var campaignLabel: Field<String> = .keep

    enum Keys: String, CodingKey { case id, content, scheduledAt, campaignLabel }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        try put(content, .content, &c)
        try put(scheduledAt, .scheduledAt, &c)
        try put(campaignLabel, .campaignLabel, &c)
    }
    private func put(_ f: Field<String>, _ k: Keys, _ c: inout KeyedEncodingContainer<Keys>) throws {
        switch f {
        case .keep: break
        case .clear: try c.encodeNil(forKey: k)
        case .set(let v): try c.encode(v, forKey: k)
        }
    }
}

enum PostRulesEdit {
    /// Only what changed is sent.
    static func makeUpdate(post: Post, content: String, scheduled: Bool, scheduledAt: Date, campaign: String) -> UpdatePostInput {
        var input = UpdatePostInput(id: post.id)
        if content != post.content { input.content = .set(content) }
        if scheduled {
            let iso = TRPCClient.isoWithFraction.string(from: scheduledAt)
            if post.scheduledAt.map({ TRPCClient.isoWithFraction.string(from: $0) }) != iso { input.scheduledAt = .set(iso) }
        } else if post.scheduledAt != nil {
            input.scheduledAt = .clear
        }
        let label = campaign.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if label != (post.campaignLabel ?? "") { input.campaignLabel = label.isEmpty ? .clear : .set(label) }
        return input
    }
}

/// One channel's own caption (post.updateTargetContent). Blank = use the
/// shared caption again.
struct ChannelCaptionSheet: View {
    let target: PostTarget
    let sharedCaption: String
    var onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var saving = false
    @State private var error: String?

    init(target: PostTarget, sharedCaption: String, onSaved: @escaping () -> Void) {
        self.target = target
        self.sharedCaption = sharedCaption
        self.onSaved = onSaved
        _text = State(initialValue: target.contentOverride ?? sharedCaption)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text).frame(minHeight: 160)
                } header: {
                    Text("Caption for \(target.channel.name)")
                } footer: {
                    Text("Only this channel uses it. Clear it to use the shared caption again.")
                }
                if target.contentOverride != nil {
                    Section { Button("Use the shared caption", role: .destructive) { Task { await save(nil) } } }
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle(target.channel.platform.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        // Blank or identical to the shared caption ⇒ no override (the web's rule).
                        Task { await save(t.isEmpty || t == sharedCaption.trimmingCharacters(in: .whitespacesAndNewlines) ? nil : text) }
                    }
                    .disabled(saving).fontWeight(.semibold)
                }
            }
        }
    }

    private struct Input: Encodable {
        let targetId: String
        let contentOverride: String?
        enum Keys: String, CodingKey { case targetId, contentOverride }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(targetId, forKey: .targetId)
            // Explicit null clears the override — it must be sent, not omitted.
            if let contentOverride { try c.encode(contentOverride, forKey: .contentOverride) } else { try c.encodeNil(forKey: .contentOverride) }
        }
    }
    private struct Ignored: Decodable {}

    private func save(_ value: String?) async {
        saving = true
        error = nil
        defer { saving = false }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("post.updateTargetContent", input: Input(targetId: target.id, contentOverride: value))
            onSaved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
