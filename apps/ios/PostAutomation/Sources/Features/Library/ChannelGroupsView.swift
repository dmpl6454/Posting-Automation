import SwiftUI

/// Channel groups — the web's groups on /dashboard/channels. A group is a
/// named set of channels you can select in one tap when composing.
struct ChannelGroupsView: View {
    @Environment(SessionStore.self) private var session
    @State private var groups: [ChannelGroup] = []
    @State private var loading = false
    @State private var error: String?
    @State private var creating = false
    @State private var newName = ""
    @State private var notice: String?

    var body: some View {
        List {
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if groups.isEmpty && !loading && error == nil {
                ContentUnavailableView("No groups yet", systemImage: "square.stack.3d.up",
                                       description: Text("Group channels to select them together in Compose."))
            }
            ForEach(groups) { g in
                NavigationLink { ChannelGroupDetailView(group: g) { await load() } } label: {
                    HStack {
                        Circle().fill(Color(hex: g.color) ?? .accentColor).frame(width: 10, height: 10)
                        Text(g.name)
                        Spacer()
                        Text("\(g.channels.count)").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Channel groups")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newName = ""; creating = true } label: { Label("New group", systemImage: "plus") }
            }
        }
        .alert("New group", isPresented: $creating) {
            TextField("Name", text: $newName)
            Button("Create") { Task { await create() } }
            Button("Cancel", role: .cancel) {}
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        }
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && groups.isEmpty { ProgressView() } }
    }

    private struct CreateInput: Encodable { let name: String; let color: String }
    private struct Ignored: Decodable {}

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            groups = try await TRPCClient.shared.query("channelGroup.list")
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func create() async {
        let name = String(newName.trimmingCharacters(in: .whitespaces).prefix(50))
        guard !name.isEmpty else { return }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("channelGroup.create", input: CreateInput(name: name, color: "#6366f1"))
            await load()
        } catch {
            notice = "Couldn't create the group: \(error.localizedDescription)"
        }
    }
}

struct ChannelGroupDetailView: View {
    let group: ChannelGroup
    let onChange: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var members: Set<String>
    @State private var channels: [Channel] = []
    @State private var picking = false
    @State private var saving = false
    @State private var confirmingDelete = false
    @State private var notice: String?

    init(group: ChannelGroup, onChange: @escaping () async -> Void) {
        self.group = group
        self.onChange = onChange
        _name = State(initialValue: group.name)
        _members = State(initialValue: Set(group.channels.map(\.id)))
    }

    private var memberRows: [ChannelGroup.Member] {
        // Members come from the group itself, so a paused channel still shows.
        let known = Dictionary(uniqueKeysWithValues: group.channels.map { ($0.id, $0) })
        let fromList = channels.filter { members.contains($0.id) && known[$0.id] == nil }
            .map { ChannelGroup.Member(id: $0.id, name: $0.name, platform: $0.platform.raw, isActive: $0.isActive) }
        return group.channels.filter { members.contains($0.id) } + fromList
    }

    private var dirty: Bool {
        name.trimmingCharacters(in: .whitespaces) != group.name || members != Set(group.channels.map(\.id))
    }

    var body: some View {
        Form {
            Section("Name") { TextField("Name", text: $name) }
            Section {
                ForEach(memberRows) { m in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(m.name).lineLimit(1)
                            Text(Platform(raw: m.platform).displayName + (m.isActive == false ? " · paused" : ""))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { idx in
                    let rows = memberRows
                    for i in idx { members.remove(rows[i].id) }
                }
                Button("Choose channels…") { picking = true }
            } header: {
                Text("\(members.count) channels")
            }
            Section {
                Button("Delete group", role: .destructive) { confirmingDelete = true }
            }
        }
        .navigationTitle(group.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }.disabled(!dirty || saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .sheet(isPresented: $picking) {
            ChannelPickerSheet(channels: channels, selected: $members, showGroups: false)
        }
        .task { channels = (try? await TRPCClient.shared.query("channel.list")) ?? [] }
        .confirmationDialog("Delete \(group.name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete group", role: .destructive) { Task { await deleteGroup() } }
        } message: {
            Text("Only the group is deleted. Its channels stay connected.")
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    private struct UpdateInput: Encodable { let id: String; let name: String }
    private struct SetInput: Encodable { let groupId: String; let channelIds: [String]; let mode: String }
    private struct IdInput: Encodable { let id: String }
    private struct Ignored: Decodable {}

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let trimmed = String(name.trimmingCharacters(in: .whitespaces).prefix(50))
            if trimmed != group.name {
                let _: Ignored = try await TRPCClient.shared.mutate("channelGroup.update", input: UpdateInput(id: group.id, name: trimmed))
            }
            let diff = LibraryRules.groupDiff(current: Set(group.channels.map(\.id)), wanted: members)
            for chunk in diff.add.chunked(500) {
                let _: Ignored = try await TRPCClient.shared.mutate("channelGroup.setChannels", input: SetInput(groupId: group.id, channelIds: chunk, mode: "add"))
            }
            for chunk in diff.remove.chunked(500) {
                let _: Ignored = try await TRPCClient.shared.mutate("channelGroup.setChannels", input: SetInput(groupId: group.id, channelIds: chunk, mode: "remove"))
            }
            await onChange()
            dismiss()
        } catch {
            notice = "Couldn't save: \(error.localizedDescription)"
        }
    }

    private func deleteGroup() async {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("channelGroup.delete", input: IdInput(id: group.id))
            await onChange()
            dismiss()
        } catch {
            notice = "Couldn't delete: \(error.localizedDescription)"
        }
    }
}

extension Array {
    func chunked(_ size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

extension Color {
    /// `#rrggbb` → Color; anything else → nil.
    init?(hex: String?) {
        guard let hex, hex.count == 7, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
