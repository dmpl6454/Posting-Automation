import SwiftUI

/// Compose tab — write a caption, attach photos or a video, pick channels, save
/// as draft or schedule. Calls `post.create`; the server enforces "scheduling
/// needs ≥1 channel" with a friendly message, and rejects past dates (60s
/// clock-skew allowance). Media is uploaded the moment it is picked (see
/// `AttachmentStore`), so submit only ever sends finished `Media.id`s.
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
    @State private var store = AttachmentStore()
    /// Workspace the channel list was loaded for. Re-showing the tab must not
    /// refetch; switching workspaces must (the `.task(id:)` pattern every tab
    /// shares — see `SessionStore.activeOrganizationId`).
    @State private var loadedForOrg: String?

    private var activeChannels: [Channel] { channels.filter(\.isActive) }
    private var canSubmit: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !submitting
        && (!schedule || !selected.isEmpty)
        && !store.isBusy
        && !store.hasFailures
    }
    private var submitTitle: String {
        if store.isBusy { return "Uploading…" }
        return schedule ? "Schedule" : "Save Draft"
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
                    if !store.attachments.isEmpty || store.importingCount > 0 {
                        AttachmentStrip(store: store)
                    }
                    AttachmentPickerButton(store: store)
                    if let message = store.ruleMessage {
                        Text(message).font(.footnote).foregroundStyle(.orange)
                            .accessibilityIdentifier("compose.mediaRule")
                    }
                    if let failure = store.failureMessage {
                        Text(failure).font(.footnote).foregroundStyle(.red)
                            .accessibilityIdentifier("compose.mediaError")
                    }
                } header: {
                    Text("Media")
                } footer: {
                    Text("Up to 10 photos, or one video. Uploads start right away.")
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
                    Button(submitTitle) { Task { await submit() } }
                        .disabled(!canSubmit)
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("compose.submit")
                }
            }
            .overlay { if submitting { ProgressView().controlSize(.large) } }
            // Non-blocking pill while media is still uploading: the form stays
            // usable (the strip shows per-tile progress), the submit button is
            // what's held back.
            .overlay(alignment: .bottom) {
                if store.isBusy && !submitting {
                    Label("Uploading…", systemImage: "arrow.up.circle")
                        .font(.footnote.weight(.semibold))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.bottom, 12)
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("compose.uploading")
                }
            }
            .onAppear {
                store.onUnauthorized = { await session.handleUnauthorized() }
            }
            .task(id: session.activeOrganizationId) {
                if loadedForOrg != session.activeOrganizationId {
                    loadedForOrg = session.activeOrganizationId
                    // Per-workspace state goes first: channel ids belong to the
                    // old workspace, and so do uploaded Media rows (post.create
                    // runs assertMediaOwned against the active org).
                    selected = []
                    channels = []
                    store.reset()
                    await loadChannels()
                }
            }
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
        // canSubmit guarantees nothing is queued/uploading/failed, so this list
        // is complete and in display order.
        let mediaIds = store.uploadedMediaIds
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
            store.reset()
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
