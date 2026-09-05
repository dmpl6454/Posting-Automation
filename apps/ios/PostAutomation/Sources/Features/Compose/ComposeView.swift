import SwiftUI

/// Compose tab — write a caption, pick channels, save as draft or schedule.
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

    private var activeChannels: [Channel] { channels.filter(\.isActive) }
    private var canSubmit: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !submitting
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
        let input = CreatePostInput(
            content: content.trimmingCharacters(in: .whitespacesAndNewlines),
            channelIds: Array(selected),
            scheduledAt: schedule ? TRPCClient.isoWithFraction.string(from: scheduledAt) : nil
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
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
