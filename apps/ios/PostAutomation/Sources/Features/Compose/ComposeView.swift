import SwiftUI
import PhotosUI

/// Compose tab — the mobile counterpart of the web Compose. Post or Story mode,
/// caption, photos/videos (uploaded as soon as they're picked, see
/// MediaUploader), channels, per-channel captions, first comments, TikTok and
/// YouTube settings, video cover, campaign label, then Save draft / Publish now
/// / Schedule. The request is built by ComposeRules (ComposePayload.swift).
struct ComposeView: View {
    enum When: String, CaseIterable, Identifiable {
        case draft, now, later
        var id: String { rawValue }
        var label: String {
            switch self {
            case .draft: return "Draft"
            case .now: return "Now"
            case .later: return "Schedule"
            }
        }
    }

    @Environment(SessionStore.self) private var session
    @State private var content = ""
    @State private var mode: ComposeMode = .post
    @State private var channels: [Channel] = []
    @State private var selected: Set<String> = []
    @State private var when: When = .draft
    @State private var scheduledAt = Date().addingTimeInterval(3600)
    @State private var submitting = false
    @State private var error: String?
    @State private var successMessage: String?
    @State private var confirmPublish = false
    @State private var showChannelPicker = false
    @State private var showAI = false

    // Media
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var attachments: [ComposeAttachment] = []
    @State private var coverItem: PhotosPickerItem?
    @State private var cover: ComposeAttachment?

    // Features
    @State private var storyTagsText = ""
    @State private var firstComments: [String] = [""]
    @State private var firstCommentDelay = 0
    @State private var customCaptions = false
    @State private var captionOverrides: [String: String] = [:]
    @State private var campaignLabel = ""
    @State private var tiktokDrafts: [String: TikTokDraft] = [:]
    @State private var tiktokCreators: [String: TikTokCreatorInfoResult] = [:]
    @State private var tiktokErrors: [String: String] = [:]
    @State private var youtubeTitle = ""
    @State private var youtubePrivacy = "public"

    private let maxAttachments = 10

    // MARK: Derived

    private var activeChannels: [Channel] {
        let live = channels.filter(\.isActive)
        return mode == .story ? live.filter { ComposeRules.storyPlatforms.contains($0.platform.raw) } : live
    }
    private var selectedChannels: [Channel] { activeChannels.filter { selected.contains($0.id) } }
    private func has(_ platform: String) -> Bool { selectedChannels.contains { $0.platform.raw == platform } }
    private var storyCapable: Bool { channels.contains { $0.isActive && ComposeRules.storyPlatforms.contains($0.platform.raw) } }
    private var uploading: Bool { attachments.contains(where: \.isBusy) || cover?.isBusy == true }
    private var hasFailedUpload: Bool { attachments.contains { $0.failure != nil } || cover?.failure != nil }
    private var tiktokChannels: [Channel] { mode == .post ? selectedChannels.filter { $0.platform.raw == "TIKTOK" } : [] }
    private var storyMentions: (valid: [String], invalid: [String]) { ComposeRules.parseMentions(storyTagsText) }

    private var action: SubmitAction {
        switch when {
        case .draft: return .draft
        case .now: return .publishNow
        case .later: return .schedule(scheduledAt)
        }
    }

    private var draft: ComposeDraft {
        var d = ComposeDraft()
        d.content = content
        d.mode = mode
        d.channels = selectedChannels
        d.mediaIds = attachments.compactMap(\.mediaId)
        d.mediaKinds = attachments.filter { $0.mediaId != nil }.map(\.kind)
        d.mediaBusy = uploading || hasFailedUpload
        d.storyMentions = storyMentions.valid
        d.firstComments = firstComments
        d.firstCommentDelayMinutes = firstCommentDelay
        d.customCaptions = customCaptions
        d.captionOverrides = captionOverrides
        d.campaignLabel = campaignLabel
        d.tiktokDrafts = tiktokDrafts
        d.tiktokCreators = tiktokCreators
        d.youtubeTitle = youtubeTitle
        d.youtubePrivacy = youtubePrivacy
        d.videoCoverMediaId = cover?.mediaId
        return d
    }

    private var blockReason: String? {
        if mode == .story && !storyMentions.invalid.isEmpty {
            return "Not valid Instagram usernames: \(storyMentions.invalid.joined(separator: ", "))."
        }
        return ComposeRules.blockReason(draft, action: action)
    }

    private var buttonTitle: String {
        switch when {
        case .draft: return "Save Draft"
        case .now: return "Publish"
        case .later: return "Schedule"
        }
    }

    // MARK: Body

    var body: some View {
        NavigationStack {
            Form {
                if storyCapable {
                    Section {
                        Picker("Type", selection: $mode.animation()) {
                            ForEach(ComposeMode.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    } footer: {
                        if mode == .story {
                            Text("One photo or video, posted as a story to Instagram and Facebook. Stories disappear after 24 hours.")
                        }
                    }
                }

                captionSection
                mediaSection
                channelSection

                if mode == .story && has("INSTAGRAM") { storyTagsSection }
                if mode == .post && selectedChannels.count > 1 { perChannelCaptionSection }
                if mode == .post && selectedChannels.contains(where: { ComposeRules.firstCommentPlatforms.contains($0.platform.raw) }) {
                    firstCommentsSection
                }
                ForEach(tiktokChannels) { ch in
                    TikTokChannelSettings(
                        channel: ch,
                        result: tiktokCreators[ch.id],
                        loadError: tiktokErrors[ch.id],
                        draft: Binding(get: { tiktokDrafts[ch.id] ?? TikTokDraft() }, set: { tiktokDrafts[ch.id] = $0 }),
                        onRetry: { Task { await loadCreator(ch) } }
                    )
                    .task(id: ch.id) { if tiktokCreators[ch.id] == nil { await loadCreator(ch) } }
                }
                if mode == .post && has("YOUTUBE") { youtubeSection }
                if mode == .post && attachments.contains(where: { $0.kind == .video }) { coverSection }
                campaignSection
                timingSection

                if !tiktokChannels.isEmpty {
                    Section {
                        Text(TikTokText.consent(branded: tiktokChannels.contains { (tiktokDrafts[$0.id]?.discloseCommercial ?? false) && (tiktokDrafts[$0.id]?.brandContent ?? false) }))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let blockReason, !content.isEmpty || !selected.isEmpty || !attachments.isEmpty {
                    Section { Label(blockReason, systemImage: "info.circle").font(.footnote).foregroundStyle(.orange) }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                if let successMessage {
                    Section { Label(successMessage, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Compose")
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        // Whichever field is active — a shared focus flag is unreliable across many fields.
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(buttonTitle) {
                        if when == .now { confirmPublish = true } else { Task { await submit() } }
                    }
                    .disabled(blockReason != nil || submitting)
                    .fontWeight(.semibold)
                }
            }
            .confirmationDialog(
                "Publish now to \(selectedChannels.count) channel\(selectedChannels.count == 1 ? "" : "s")?",
                isPresented: $confirmPublish, titleVisibility: .visible
            ) {
                Button("Publish now") { Task { await submit() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("It goes live right away.")
            }
            .overlay { if submitting { ProgressView().controlSize(.large) } }
            // At screen level: a sheet attached to content inside a Form didn't open.
            .sheet(isPresented: $showChannelPicker) {
                ChannelPickerSheet(channels: activeChannels, selected: $selected)
            }
            .sheet(isPresented: $showAI) {
                CreateWithAISheet(current: content, platforms: selectedChannels.map(\.platform.raw)) { content = $0 }
            }
            .task { if channels.isEmpty { await loadChannels() } }
            .onChange(of: mode) { _, newMode in
                // Hidden channels must not stay selected.
                if newMode == .story { selected = selected.filter { id in activeChannels.contains { $0.id == id } } }
            }
        }
    }

    // MARK: Sections

    private var captionSection: some View {
        Section {
            TextEditor(text: $content)
                .frame(minHeight: 120)
                .accessibilityLabel(mode == .story ? "Story note" : "Post caption")
                .accessibilityIdentifier("compose.caption")
            HStack {
                if mode == .post {
                    Button { showAI = true } label: { Label("Write with AI", systemImage: "sparkles") }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("compose.ai")
                }
                Spacer()
                Text("\(content.count) characters").font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text(mode == .story ? "Note (optional)" : "Caption")
        } footer: {
            if mode == .story { Text("Stories show no caption. The note is only for you.") }
        }
    }

    private var mediaSection: some View {
        Section {
            if !attachments.isEmpty {
                AttachmentStrip(attachments: attachments, onRemove: remove, onRetry: { startUpload($0) })
            }
            let limit = mode == .story ? 1 : maxAttachments
            PhotosPicker(
                selection: $pickerItems,
                maxSelectionCount: max(1, limit - attachments.count),
                matching: .any(of: [.images, .videos])
            ) {
                Label(attachments.isEmpty ? "Add photos or videos" : "Add more", systemImage: "photo.on.rectangle.angled")
            }
            .disabled(attachments.count >= limit)
            .onChange(of: pickerItems) { _, items in
                guard !items.isEmpty else { return }
                pickerItems = []
                add(items, limit: limit)
            }
        } header: {
            HStack {
                Text("Media")
                Spacer()
                if !attachments.isEmpty { Text("\(attachments.count)/\(mode == .story ? 1 : maxAttachments)").font(.caption) }
            }
        } footer: {
            if uploading {
                Text("Uploading — keep the app open until it finishes.")
            } else if hasFailedUpload {
                Text("Retry or remove the failed upload to continue.").foregroundStyle(.orange)
            } else if mode == .story && attachments.count > 1 {
                Text("A story takes one photo or video — remove the others.").foregroundStyle(.orange)
            }
        }
    }

    private var channelSection: some View {
        Section {
            if activeChannels.isEmpty {
                Text(mode == .story ? "No Instagram or Facebook channels connected." : "No active channels. Connect one from the web dashboard.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                ForEach(selectedChannels) { ch in
                    HStack(spacing: 12) {
                        ChannelAvatar(channel: ch)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ch.name).lineLimit(1)
                            Text(ch.platform.displayName).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions { Button("Remove", role: .destructive) { selected.remove(ch.id) } }
                }
                Button {
                    showChannelPicker = true
                } label: {
                    Label(selected.isEmpty ? "Choose channels" : "Change channels", systemImage: "plus.circle")
                }
                .accessibilityIdentifier("compose.chooseChannels")
            }
        } header: {
            HStack {
                Text("Channels")
                Spacer()
                if !selected.isEmpty { Text("\(selectedChannels.count) selected").font(.caption) }
            }
        } footer: {
            if !selectedChannels.isEmpty { Text("Swipe a channel left to remove it.") }
        }
    }

    private var storyTagsSection: some View {
        Section {
            TextField("@username, @another", text: $storyTagsText, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !storyMentions.valid.isEmpty {
                Text(storyMentions.valid.map { "@\($0)" }.joined(separator: "  ")).font(.caption)
            }
        } header: {
            Text("Tag people (Instagram)")
        } footer: {
            Text("Up to 20 accounts. Instagram decides whether they're notified. Facebook stories can't tag people.")
        }
    }

    private var perChannelCaptionSection: some View {
        Section {
            Toggle("Different caption per channel", isOn: $customCaptions.animation())
            if customCaptions {
                ForEach(selectedChannels) { ch in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ch.name).font(.caption.weight(.semibold))
                        TextField("Blank = the shared caption", text: Binding(
                            get: { captionOverrides[ch.id] ?? "" },
                            set: { captionOverrides[ch.id] = $0 }
                        ), axis: .vertical)
                        .lineLimit(2...6)
                    }
                }
            }
        } footer: {
            if customCaptions { Text("Channels left blank use the caption above.") }
        }
    }

    private var firstCommentsSection: some View {
        Section {
            ForEach(firstComments.indices, id: \.self) { i in
                HStack(alignment: .top) {
                    TextField(i == 0 ? "#hashtags #go #here" : "Another comment", text: Binding(
                        get: { i < firstComments.count ? firstComments[i] : "" },
                        set: { if i < firstComments.count { firstComments[i] = String($0.prefix(ComposeRules.firstCommentMaxLength)) } }
                    ), axis: .vertical)
                    .lineLimit(1...5)
                    if firstComments.count > 1 {
                        Button { firstComments.remove(at: i) } label: { Image(systemName: "minus.circle.fill").foregroundStyle(.red) }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Remove comment \(i + 1)")
                    }
                }
            }
            if firstComments.count < ComposeRules.firstCommentsMax {
                Button("Add another comment") { firstComments.append("") }
            }
            Picker("Post them", selection: $firstCommentDelay) {
                ForEach(ComposeRules.firstCommentDelays, id: \.minutes) { Text($0.label).tag($0.minutes) }
            }
        } header: {
            Text("First comments")
        } footer: {
            Text("Posted on each Instagram and Facebook post as your account or Page after it goes live, in order. Other channels don't get them.")
        }
    }

    private var youtubeSection: some View {
        Section("YouTube") {
            TextField("Video title (defaults to the start of the caption)", text: $youtubeTitle)
            Picker("Visibility", selection: $youtubePrivacy) {
                Text("Public").tag("public")
                Text("Unlisted").tag("unlisted")
                Text("Private").tag("private")
            }
        }
    }

    private var coverSection: some View {
        Section {
            HStack(spacing: 12) {
                if let thumb = cover?.thumbnail {
                    Image(uiImage: thumb).resizable().scaledToFill().frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 8))
                }
                VStack(alignment: .leading, spacing: 2) {
                    if let cover {
                        switch cover.state {
                        case .uploading(let p): Text("Uploading cover… \(Int(p * 100))%").font(.footnote)
                        case .preparing: Text("Preparing cover…").font(.footnote)
                        case .failed(let msg): Text(msg).font(.footnote).foregroundStyle(.red)
                        case .uploaded: Text("Cover set").font(.footnote)
                        }
                    }
                    PhotosPicker(selection: $coverItem, matching: .images) {
                        Text(cover == nil ? "Choose a cover image" : "Change cover")
                    }
                    .onChange(of: coverItem) { _, item in
                        guard let item else { return }
                        coverItem = nil
                        setCover(item)
                    }
                }
                Spacer()
                if cover != nil {
                    Button(role: .destructive) { removeCover() } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove cover")
                }
            }
        } header: {
            Text("Video cover")
        } footer: {
            Text("Used for Instagram Reels, Facebook and YouTube videos. YouTube Shorts feeds ignore custom covers.")
        }
    }

    private var campaignSection: some View {
        Section {
            TextField("e.g. Diwali 2026", text: $campaignLabel)
        } header: {
            Text("Campaign (optional)")
        } footer: {
            Text("Internal only — never posted. Groups this post in Insights → Reports.")
        }
    }

    private var timingSection: some View {
        Section("When") {
            Picker("When", selection: $when.animation()) {
                ForEach(When.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            switch when {
            case .draft:
                Text("Saved as a draft you can schedule later.").font(.footnote).foregroundStyle(.secondary)
            case .now:
                Text("Publishes as soon as you tap Publish.").font(.footnote).foregroundStyle(.secondary)
            case .later:
                DatePicker("Publish at", selection: $scheduledAt, in: Date()..., displayedComponents: [.date, .hourAndMinute])
            }
            if !tiktokChannels.isEmpty && when != .draft {
                Text(TikTokText.processingNotice).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Loading

    private func loadChannels() async {
        do {
            channels = try await TRPCClient.shared.query("channel.list")
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private struct CreatorInfoInput: Encodable { let channelId: String }

    private func loadCreator(_ ch: Channel) async {
        tiktokErrors[ch.id] = nil
        tiktokCreators[ch.id] = nil
        do {
            tiktokCreators[ch.id] = try await TRPCClient.shared.query("tiktok.creatorInfo", input: CreatorInfoInput(channelId: ch.id))
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            tiktokErrors[ch.id] = error.localizedDescription
        }
    }

    // MARK: Submit

    private func submit() async {
        guard blockReason == nil else { return }
        submitting = true
        error = nil
        successMessage = nil
        defer { submitting = false }
        let current = action
        let input = ComposeRules.makeInput(draft, action: current)
        do {
            let _: CreatedPost = try await TRPCClient.shared.mutate("post.create", input: input)
            switch current {
            case .draft: successMessage = "Draft saved"
            case .publishNow: successMessage = "Publishing now — follow it in Posts"
            case .schedule(let date): successMessage = "Scheduled for \(date.formatted(date: .abbreviated, time: .shortened))"
            }
            reset()
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reset() {
        content = ""
        selected = []
        when = .draft
        attachments.forEach { $0.deleteLocalFile() }
        attachments = []
        removeCover()
        storyTagsText = ""
        firstComments = [""]
        firstCommentDelay = 0
        customCaptions = false
        captionOverrides = [:]
        campaignLabel = ""
        tiktokDrafts = [:]
        youtubeTitle = ""
        youtubePrivacy = "public"
    }

    // MARK: Media

    private func add(_ items: [PhotosPickerItem], limit: Int) {
        for item in items.prefix(max(0, limit - attachments.count)) {
            let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
            let a = ComposeAttachment(kind: isVideo ? .video : .image)
            attachments.append(a)
            a.task = Task {
                do {
                    try await prepare(a, from: item)
                    startUpload(a)
                } catch {
                    a.state = .failed(error.localizedDescription)
                }
            }
        }
    }

    private func prepare(_ a: ComposeAttachment, from item: PhotosPickerItem) async throws {
        let prepared = try await AttachmentPreparer.prepare(item)
        a.kind = prepared.kind
        a.thumbnail = prepared.thumbnail
        a.localFile = prepared.url
        a.fileName = prepared.fileName
        a.mimeType = prepared.mimeType
    }

    private func startUpload(_ a: ComposeAttachment) {
        guard let file = a.localFile else {
            a.state = .failed("The file is no longer available — remove it and pick it again.")
            return
        }
        a.state = .uploading(0)
        UIApplication.shared.isIdleTimerDisabled = true
        a.task = Task {
            do {
                let media = try await MediaUploader().upload(
                    fileURL: file, fileName: a.fileName, mimeType: a.mimeType,
                    progress: { p in Task { @MainActor in if a.isBusy { a.state = .uploading(p) } } }
                )
                a.state = .uploaded(mediaId: media.id)
                a.deleteLocalFile()
            } catch let e as APIError where e.isUnauthorized {
                a.state = .failed(e.localizedDescription)
                await session.handleUnauthorized()
            } catch {
                if !Task.isCancelled { a.state = .failed(error.localizedDescription) }
            }
            if !uploading { UIApplication.shared.isIdleTimerDisabled = false }
        }
    }

    private func remove(_ a: ComposeAttachment) {
        a.task?.cancel()
        a.deleteLocalFile()
        attachments.removeAll { $0.id == a.id }
        if !attachments.contains(where: { $0.kind == .video }) { removeCover() }
        if !uploading { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private func setCover(_ item: PhotosPickerItem) {
        removeCover()
        let a = ComposeAttachment(kind: .image)
        cover = a
        a.task = Task {
            do {
                try await prepare(a, from: item)
                guard a.kind == .image, let file = a.localFile else { throw UploadError.unsupportedType("video") }
                try AttachmentPreparer.fitCover(file)
                startUpload(a)
            } catch {
                a.state = .failed(error.localizedDescription)
            }
        }
    }

    private func removeCover() {
        cover?.task?.cancel()
        cover?.deleteLocalFile()
        cover = nil
    }
}
