import SwiftUI
import PhotosUI

/// Compose tab — write a caption, attach photos/videos, pick channels, save as
/// draft or schedule. Media uploads straight to storage as soon as it is picked
/// (MediaUploader) and is attached to `post.create` as `mediaIds`.
/// Calls `post.create`; the server enforces "scheduling needs ≥1 channel" with a
/// friendly message, and rejects past dates (60s clock-skew allowance).
struct ComposeView: View {
    @Environment(SessionStore.self) private var session
    @State private var content = ""
    @State private var channels: [Channel] = []
    @State private var selected: Set<String> = []
    @State private var schedule = false
    @State private var scheduledAt = Date().addingTimeInterval(3600)
    @State private var submitting = false
    @State private var error: String?
    @State private var successMessage: String?
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var attachments: [ComposeAttachment] = []

    /// The same ceiling as the web's carousel (Instagram allows 10).
    private let maxAttachments = 10
    private var uploading: Bool { attachments.contains(where: \.isBusy) }
    private var hasFailedUpload: Bool { attachments.contains { $0.failure != nil } }

    private var activeChannels: [Channel] { channels.filter(\.isActive) }
    private var canSubmit: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !submitting
        && !uploading
        && !hasFailedUpload
        && (!schedule || !selected.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Caption") {
                    TextEditor(text: $content)
                        .frame(minHeight: 140)
                        .accessibilityLabel("Post caption")
                    HStack {
                        Spacer()
                        Text("\(content.count) characters").font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section {
                    if !attachments.isEmpty {
                        AttachmentStrip(
                            attachments: attachments,
                            onRemove: remove,
                            onRetry: { a in startUpload(a) }
                        )
                    }
                    PhotosPicker(
                        selection: $pickerItems,
                        maxSelectionCount: max(1, maxAttachments - attachments.count),
                        matching: .any(of: [.images, .videos])
                    ) {
                        Label(attachments.isEmpty ? "Add photos or videos" : "Add more", systemImage: "photo.on.rectangle.angled")
                    }
                    .disabled(attachments.count >= maxAttachments)
                    .onChange(of: pickerItems) { _, items in
                        guard !items.isEmpty else { return }
                        pickerItems = []
                        add(items)
                    }
                } header: {
                    HStack {
                        Text("Media")
                        Spacer()
                        if !attachments.isEmpty { Text("\(attachments.count)/\(maxAttachments)").font(.caption) }
                    }
                } footer: {
                    if uploading {
                        Text("Uploading — keep the app open until it finishes.")
                    } else if hasFailedUpload {
                        Text("Retry or remove the failed upload to continue.").foregroundStyle(.orange)
                    } else if !attachments.isEmpty {
                        Text("Instagram and TikTok need media; several photos post as a carousel where the platform supports it.")
                    }
                }

                Section {
                    if activeChannels.isEmpty {
                        Text("No active channels. Connect one from the web dashboard.")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(activeChannels) { ch in
                            Button {
                                if selected.contains(ch.id) { selected.remove(ch.id) } else { selected.insert(ch.id) }
                            } label: {
                                HStack(spacing: 12) {
                                    ChannelAvatar(channel: ch)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(ch.name).foregroundStyle(.primary).lineLimit(1)
                                        Text(ch.platform.displayName).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: selected.contains(ch.id) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selected.contains(ch.id) ? Color.accentColor : .secondary)
                                        .imageScale(.large)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } header: {
                    HStack {
                        Text("Channels")
                        Spacer()
                        if !selected.isEmpty { Text("\(selected.count) selected").font(.caption) }
                    }
                }

                Section("Timing") {
                    Toggle("Schedule for later", isOn: $schedule.animation())
                    if schedule {
                        DatePicker("Publish at", selection: $scheduledAt, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                        if selected.isEmpty {
                            Text("Pick at least one channel to schedule.")
                                .font(.footnote).foregroundStyle(.orange)
                        }
                    } else {
                        Text("Saved as a draft you can schedule later from the dashboard.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                if let successMessage {
                    Section {
                        Label(successMessage, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                }
            }
            .navigationTitle("Compose")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(schedule ? "Schedule" : "Save Draft") { Task { await submit() } }
                        .disabled(!canSubmit)
                        .fontWeight(.semibold)
                }
            }
            .overlay { if submitting { ProgressView().controlSize(.large) } }
            .task { if channels.isEmpty { await loadChannels() } }
        }
    }

    private func loadChannels() async {
        do {
            channels = try await TRPCClient.shared.query("channel.list")
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func submit() async {
        submitting = true
        error = nil
        successMessage = nil
        defer { submitting = false }
        let mediaIds = attachments.compactMap(\.mediaId)
        let input = CreatePostInput(
            content: content.trimmingCharacters(in: .whitespacesAndNewlines),
            channelIds: Array(selected),
            scheduledAt: schedule ? TRPCClient.isoWithFraction.string(from: scheduledAt) : nil,
            mediaIds: mediaIds.isEmpty ? nil : mediaIds
        )
        do {
            let created: CreatedPost = try await TRPCClient.shared.mutate("post.create", input: input)
            successMessage = schedule
                ? "Scheduled for \(scheduledAt.formatted(date: .abbreviated, time: .shortened))"
                : "Draft saved"
            _ = created
            content = ""
            selected = []
            schedule = false
            attachments.forEach { $0.deleteLocalFile() }
            attachments = []
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Media

    private func add(_ items: [PhotosPickerItem]) {
        for item in items.prefix(maxAttachments - attachments.count) {
            let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
            let a = ComposeAttachment(kind: isVideo ? .video : .image)
            attachments.append(a)
            a.task = Task {
                do {
                    let prepared = try await AttachmentPreparer.prepare(item)
                    a.kind = prepared.kind
                    a.thumbnail = prepared.thumbnail
                    a.localFile = prepared.url
                    a.fileName = prepared.fileName
                    a.mimeType = prepared.mimeType
                    startUpload(a)
                } catch {
                    a.state = .failed(error.localizedDescription)
                }
            }
        }
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
            if !attachments.contains(where: \.isBusy) { UIApplication.shared.isIdleTimerDisabled = false }
        }
    }

    private func remove(_ a: ComposeAttachment) {
        a.task?.cancel()
        a.deleteLocalFile()
        attachments.removeAll { $0.id == a.id }
        if !uploading { UIApplication.shared.isIdleTimerDisabled = false }
    }
}
