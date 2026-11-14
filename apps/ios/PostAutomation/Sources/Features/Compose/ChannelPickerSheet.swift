import SwiftUI

/// Full-screen channel picker for Compose: a plain List with the system search
/// bar, as in Contacts or Mail. With ~500 channels the list can't live inside
/// the Compose form — and a search field embedded in a Form swallowed the first
/// tap on a result row while the keyboard was up (caught by ComposeDraftUITests).
struct ChannelPickerSheet: View {
    let channels: [Channel]
    @Binding var selected: Set<String>
    /// Quick-select pills for channel groups (off when editing a group itself).
    var showGroups = true
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var groups: [ChannelGroup] = []

    private var available: Set<String> { Set(channels.map(\.id)) }

    private var filtered: [Channel] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return channels }
        return channels.filter { ch in
            ch.name.lowercased().contains(q)
                || (ch.username?.lowercased().contains(q) ?? false)
                || ch.platform.displayName.lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if showGroups && query.isEmpty, !groups.isEmpty {
                    Section("Groups") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(groups) { g in groupPill(g) }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
                Section {
                ForEach(filtered) { ch in
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
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected.contains(ch.id) ? .isSelected : [])
                .accessibilityIdentifier("compose.channel")
                }
                }
            }
            .listStyle(.plain)
            .task {
                guard showGroups else { return }
                let all: [ChannelGroup] = (try? await TRPCClient.shared.query("channelGroup.list")) ?? []
                // A group with no active member in this list can't select anything.
                groups = all.filter { !LibraryRules.selectableMembers($0, available: available).isEmpty }
            }
            .overlay {
                if filtered.isEmpty { ContentUnavailableView.search(text: query) }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search channels")
            // Keep Done/Clear visible while searching — by default iOS hides the
            // toolbar during search, so Done needed a Cancel first.
            .modifier(KeepToolbarWhileSearching())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle(selected.isEmpty ? "Channels" : "\(selected.count) selected")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !selected.isEmpty { Button("Clear") { selected = [] } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.fontWeight(.semibold).accessibilityIdentifier("channelPicker.done")
                }
            }
        }
    }
}

extension ChannelPickerSheet {
    /// Tap: select every active member; tap again when all are selected: clear them.
    fileprivate func groupPill(_ g: ChannelGroup) -> some View {
        let ids = LibraryRules.selectableMembers(g, available: available)
        let chosen = ids.filter { selected.contains($0) }.count
        let all = chosen == ids.count
        return Button {
            if all { selected.subtract(ids) } else { selected.formUnion(ids) }
        } label: {
            HStack(spacing: 6) {
                Circle().fill(Color(hex: g.color) ?? .accentColor).frame(width: 8, height: 8)
                Text(g.name).lineLimit(1)
                Text(chosen > 0 && !all ? "\(chosen)/\(ids.count)" : "\(ids.count)").foregroundStyle(.secondary)
            }
            .font(.subheadline)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(all ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground), in: Capsule())
            .overlay(Capsule().stroke(all ? Color.accentColor : .clear))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("compose.group")
    }
}

/// `searchPresentationToolbarBehavior` is iOS 17.1+; the app supports 17.0.
private struct KeepToolbarWhileSearching: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 17.1, *) {
            content.searchPresentationToolbarBehavior(.avoidHidingContent)
        } else {
            content
        }
    }
}
