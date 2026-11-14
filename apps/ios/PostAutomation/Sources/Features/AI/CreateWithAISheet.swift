import SwiftUI

/// Compose's "Write with AI": draft a caption from a prompt, improve the
/// current caption, or suggest hashtags (`ai.generateContent`,
/// `ai.optimizeContent`, `ai.suggestHashtags`). Nothing is applied until the
/// user taps "Use".
struct CreateWithAISheet: View {
    let current: String
    let platforms: [String]
    let onUse: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    enum Task: String, CaseIterable, Identifiable { case write, improve, hashtags; var id: String { rawValue } }
    @State private var task: Task = .write
    @State private var prompt = ""
    @State private var tone = "professional"
    @State private var goal = "engagement"
    @State private var platform = "INSTAGRAM"
    @State private var result = ""
    @State private var hashtags: [String] = []
    @State private var chosenTags: Set<String> = []
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Task", selection: $task) {
                        Text("Write").tag(Task.write)
                        Text("Improve").tag(Task.improve).disabled(current.isEmpty)
                        Text("Hashtags").tag(Task.hashtags).disabled(current.isEmpty)
                    }
                    .pickerStyle(.segmented)
                    Picker("Platform", selection: $platform) {
                        ForEach(platformChoices, id: \.self) { Text(Platform(raw: $0).displayName).tag($0) }
                    }
                }
                switch task {
                case .write:
                    Section("What should the post say?") {
                        TextField("e.g. Announce our Diwali sale, 30% off all week", text: $prompt, axis: .vertical)
                            .lineLimit(3...6)
                            .accessibilityIdentifier("ai.prompt")
                        Picker("Tone", selection: $tone) {
                            ForEach(AIRules.tones, id: \.self) { Text($0.capitalized).tag($0) }
                        }
                    }
                case .improve:
                    Section {
                        Picker("Optimise for", selection: $goal) {
                            ForEach(["engagement", "reach", "clicks", "conversions"], id: \.self) { Text($0.capitalized).tag($0) }
                        }
                    } footer: { Text("Rewrites your current caption.") }
                case .hashtags:
                    Section { Text(current).font(.footnote).foregroundStyle(.secondary).lineLimit(4) } header: { Text("For your caption") }
                }
                Section {
                    Button { Swift.Task { await run() } } label: {
                        HStack {
                            if working { ProgressView().padding(.trailing, 4) }
                            Text(working ? "Working…" : (result.isEmpty && hashtags.isEmpty ? "Generate" : "Try again"))
                        }
                    }
                    .disabled(working || (task == .write && prompt.trimmingCharacters(in: .whitespaces).isEmpty))
                    .accessibilityIdentifier("ai.generate")
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
                if !result.isEmpty {
                    Section("Result") {
                        TextEditor(text: $result).frame(minHeight: 140).accessibilityIdentifier("ai.result")
                    }
                }
                if !hashtags.isEmpty {
                    Section("Tap to choose") {
                        FlowTags(tags: hashtags, chosen: $chosenTags)
                    }
                }
            }
            .navigationTitle("Write with AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use") { use() }.fontWeight(.semibold).disabled(useText == nil)
                        .accessibilityIdentifier("ai.use")
                }
            }
            .onAppear { if let p = platforms.first { platform = p } }
            .onChange(of: task) { _, _ in result = ""; hashtags = []; chosenTags = []; error = nil }
        }
    }

    private var platformChoices: [String] {
        let list = Array(Set(platforms)).sorted()
        return list.isEmpty ? ["INSTAGRAM", "FACEBOOK", "TWITTER", "LINKEDIN", "YOUTUBE", "TIKTOK"] : list
    }

    /// What "Use" puts in the caption, or nil when there's nothing to use.
    private var useText: String? {
        switch task {
        case .write, .improve:
            let t = result.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        case .hashtags:
            guard !chosenTags.isEmpty else { return nil }
            let tags = hashtags.filter(chosenTags.contains).map { $0.hasPrefix("#") ? $0 : "#" + $0 }
            return current.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n" + tags.joined(separator: " ")
        }
    }

    private func use() {
        guard let text = useText else { return }
        onUse(text)
        dismiss()
    }

    private struct GenInput: Encodable { let prompt: String; let platform: String; let tone: String }
    private struct GenOutput: Decodable { let content: String }
    private struct OptInput: Encodable { let content: String; let platform: String; let goal: String }
    private struct OptOutput: Decodable { let optimized: String }
    private struct TagInput: Encodable { let content: String; let platform: String }
    private struct TagOutput: Decodable { let hashtags: [String] }

    private func run() async {
        working = true
        defer { working = false }
        error = nil
        do {
            switch task {
            case .write:
                let o: GenOutput = try await TRPCClient.shared.mutate("ai.generateContent",
                    input: GenInput(prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines), platform: platform, tone: tone), long: true)
                result = o.content
            case .improve:
                let o: OptOutput = try await TRPCClient.shared.mutate("ai.optimizeContent",
                    input: OptInput(content: current, platform: platform, goal: goal), long: true)
                result = o.optimized
            case .hashtags:
                let o: TagOutput = try await TRPCClient.shared.mutate("ai.suggestHashtags",
                    input: TagInput(content: current, platform: platform), long: true)
                hashtags = o.hashtags
                chosenTags = Set(o.hashtags)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Wrapping tag chips.
struct FlowTags: View {
    let tags: [String]
    @Binding var chosen: Set<String>
    var body: some View {
        WrapLayout(spacing: 6) {
            ForEach(tags, id: \.self) { t in
                let on = chosen.contains(t)
                Button {
                    if on { chosen.remove(t) } else { chosen.insert(t) }
                } label: {
                    Text(t.hasPrefix("#") ? t : "#" + t).font(.subheadline)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(on ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground), in: Capsule())
                        .overlay(Capsule().stroke(on ? Color.accentColor : .clear))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct WrapLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > width, x > 0 { x = 0; y += row + spacing; row = 0 }
            x += s.width + spacing; row = max(row, s.height)
        }
        return CGSize(width: width, height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += row + spacing; row = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing; row = max(row, s.height)
        }
    }
}
