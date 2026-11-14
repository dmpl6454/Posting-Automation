import SwiftUI
import PhotosUI
import AVKit

/// Media library — the web's /dashboard/media: everything uploaded to this
/// workspace, filterable and searchable, with upload and delete.
struct MediaLibraryView: View {
    @Environment(SessionStore.self) private var session
    @State private var type = "all"
    @State private var search = ""
    @State private var items: [MediaItem] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var picks: [PhotosPickerItem] = []
    @State private var uploads: [String: Double] = [:]
    @State private var notice: String?
    @State private var opened: MediaItem?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 4)]

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                Picker("Type", selection: $type) {
                    Text("All").tag("all"); Text("Photos").tag("image"); Text("Videos").tag("video")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)

                ForEach(uploads.keys.sorted(), id: \.self) { name in
                    ProgressView(value: uploads[name] ?? 0) { Text("Uploading \(name)").font(.caption) }
                        .padding(.horizontal)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal) }
                if items.isEmpty && !loading && error == nil {
                    ContentUnavailableView(search.isEmpty ? "No media yet" : "No matches", systemImage: "photo.on.rectangle",
                                           description: Text(search.isEmpty ? "Upload photos and videos to reuse them in posts." : "Try a different search."))
                        .padding(.top, 40)
                }
                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(items) { m in
                        Button { opened = m } label: { MediaTile(item: m) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("media.tile")
                    }
                }
                .padding(.horizontal, 4)
                if nextCursor != nil {
                    ProgressView().padding().onAppear { Task { await load(more: true) } }
                }
            }
            .padding(.vertical)
        }
        .navigationTitle("Media library")
        .searchable(text: $search, prompt: "Search file names")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                PhotosPicker(selection: $picks, maxSelectionCount: 10, matching: .any(of: [.images, .videos])) {
                    Label("Upload", systemImage: "plus")
                }
                .accessibilityIdentifier("media.upload")
            }
        }
        .refreshable { await load(more: false) }
        .task(id: "\(type)|\(search)") {
            // Debounce typing so every keystroke isn't a request.
            if !search.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            if Task.isCancelled { return }
            await load(more: false)
        }
        .onChange(of: picks) { _, new in
            guard !new.isEmpty else { return }
            let batch = new
            picks = []
            Task { await upload(batch) }
        }
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .sheet(item: $opened) { m in
            MediaDetailSheet(item: m) { await delete(m) }
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    private struct ListInput: Encodable { let limit: Int; var cursor: String?; let type: String; var search: String? }
    private struct DeleteInput: Encodable { let id: String }
    private struct Ignored: Decodable {}

    private func load(more: Bool) async {
        if more && loading { return }
        loading = true
        defer { loading = false }
        let q = search.trimmingCharacters(in: .whitespaces)
        do {
            let p: MediaPage = try await TRPCClient.shared.query(
                "media.list", input: ListInput(limit: 40, cursor: more ? nextCursor : nil, type: type, search: q.isEmpty ? nil : q)
            )
            items = more ? items + p.items : p.items
            nextCursor = p.nextCursor
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }

    private func upload(_ batch: [PhotosPickerItem]) async {
        var failures: [String] = []
        for item in batch {
            do {
                let prepared = try await AttachmentPreparer.prepare(item)
                defer { try? FileManager.default.removeItem(at: prepared.url) }
                uploads[prepared.fileName] = 0
                defer { uploads[prepared.fileName] = nil }
                let name = prepared.fileName
                _ = try await MediaUploader().upload(fileURL: prepared.url, fileName: name, mimeType: prepared.mimeType) { p in
                    Task { @MainActor in uploads[name] = p }
                }
            } catch {
                failures.append(error.localizedDescription)
            }
        }
        if !failures.isEmpty { notice = "Some files didn't upload: " + failures.joined(separator: " ") }
        await load(more: false)
    }

    private func delete(_ m: MediaItem) async -> Bool {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("media.delete", input: DeleteInput(id: m.id))
            items.removeAll { $0.id == m.id }
            return true
        } catch {
            notice = "Couldn't delete: \(error.localizedDescription)"
            return false
        }
    }
}

private struct MediaTile: View {
    let item: MediaItem
    var body: some View {
        Color(.secondarySystemBackground)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                // Only ever an IMAGE url in an image view — a video file is
                // never handed to AsyncImage (the web's OOM rule).
                if let thumb = (item.isVideo ? item.thumbnailUrl : (item.thumbnailUrl ?? item.url)).flatMap(URL.init(string:)) {
                    AsyncImage(url: thumb) { p in
                        if case .success(let img) = p { img.resizable().scaledToFill() } else { Color.clear }
                    }
                } else if item.isVideo {
                    Image(systemName: "film").font(.title2).foregroundStyle(.secondary)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if item.isVideo {
                    Image(systemName: "play.fill").font(.caption2).padding(5)
                        .background(.black.opacity(0.55), in: Circle()).foregroundStyle(.white).padding(5)
                }
            }
            .clipped()
            .contentShape(Rectangle())
    }
}

private struct MediaDetailSheet: View {
    let item: MediaItem
    let onDelete: () async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var deleting = false
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if item.isVideo {
                    VideoPlayer(player: player).frame(maxHeight: 420)
                        .onAppear { if player == nil, let u = item.playbackURL { player = AVPlayer(url: u) } }
                        .onDisappear { player?.pause() }
                } else if let u = URL(string: item.url) {
                    AsyncImage(url: u) { p in
                        if case .success(let img) = p { img.resizable().scaledToFit() } else { ProgressView() }
                    }
                    .frame(maxHeight: 420)
                }
                VStack(spacing: 4) {
                    Text(item.fileName).font(.subheadline).lineLimit(2).multilineTextAlignment(.center)
                    Text([LibraryRules.sizeText(item.fileSize), item.createdAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""]
                        .filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                    if item.isVideo && item.optimizedUrl != nil {
                        Text("Playing the web-optimized copy.").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding()
            .navigationTitle(item.isVideo ? "Video" : "Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Delete", role: .destructive) { confirming = true }.disabled(deleting)
                }
            }
            .confirmationDialog("Delete this file?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        deleting = true
                        if await onDelete() { dismiss() }
                        deleting = false
                    }
                }
            } message: {
                Text("It is removed from the library and storage. This can't be undone. Posts already published are not affected.")
            }
        }
    }
}
