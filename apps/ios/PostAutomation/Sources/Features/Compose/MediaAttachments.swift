import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import Observation
import UIKit

// Media attachments for Compose: pick photos/videos from the Photos library,
// copy each into a temp file the app owns, upload it IMMEDIATELY through
// `UploadService` (presigned multipart → `upload.complete` → `Media` row), and
// hand the resulting `Media.id`s to `post.create` as `mediaIds`.
//
// Composition rule (mirrors what the platforms accept — an Instagram carousel
// caps at 10 images, and an 11-image post once orphaned 60 targets): a post
// carries EITHER up to 10 images OR exactly one video. Anything else is refused
// with an inline message, never silently dropped.
//
// ⚠️ A video file URL is never handed to `Image` / `AsyncImage`. Thumbnails for
// videos come from `AVAssetImageGenerator`; feeding a video into an image view
// is a documented memory-kill in this repo (the web `<img src={video}>` class).

// MARK: - Attachment model

struct ComposeAttachment: Identifiable {
    enum Kind { case image, video }

    enum State: Equatable {
        case queued
        case uploading(Double)
        case uploaded(UploadedMedia)
        case failed(String)
    }

    let id: UUID
    let kind: Kind
    /// A copy inside `FileManager.default.temporaryDirectory` that the app owns.
    /// The Photos-provided file is deleted the moment the import closure
    /// returns, so the copy is what the upload reads.
    let fileURL: URL
    let fileName: String
    /// Empty when the file is a video in a container the server refuses
    /// (`upload.initiate` allows only MOV / MP4 / M4V / WebM) — such an
    /// attachment is shown failed and can only be removed, not retried.
    let mimeType: String
    var thumbnail: UIImage?
    var state: State

    var isVideo: Bool { kind == .video }
    var isRetryable: Bool { !mimeType.isEmpty }
}

// MARK: - Movie transfer (Photos → owned temp copy)

/// `PhotosPickerItem.loadTransferable(type:)` for a movie hands us a file URL
/// that is deleted after the import closure returns — so the closure MUST copy
/// it somewhere we own. Keeping the received extension (default `mov`) is what
/// lets the MIME type be derived from it afterwards.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let destination = try AttachmentImporter.makeTempURL(prefix: "VID", ext: ext)
            try FileManager.default.copyItem(at: received.file, to: destination)
            return PickedMovie(url: destination)
        }
    }
}

// MARK: - Import helpers (nonisolated, file-private)

/// What an import produced: the owned temp file plus the metadata the upload
/// needs. `mimeType` is nil for a video container the server would refuse.
private struct ImportedFile {
    let url: URL
    let fileName: String
    let mimeType: String?
    let thumbnail: UIImage?
}

private enum AttachmentImportError: Error, LocalizedError {
    case unreadable
    case undecodable

    var errorDescription: String? {
        switch self {
        case .unreadable: return "Couldn't read that item from your photo library."
        case .undecodable: return "That image format couldn't be converted."
        }
    }
}

/// Image container detection. The bytes decide — not the picker's declared
/// types — because a HEIC item can advertise JPEG as an *alternative* encoding
/// while `Data` loads the native HEIC bytes, and the server validates the real
/// container against `fileType`. The declared types are only a fallback.
private enum ImageFormat {
    case jpeg, png, gif, webp

    var ext: String {
        switch self {
        case .jpeg: return "jpg"
        case .png: return "png"
        case .gif: return "gif"
        case .webp: return "webp"
        }
    }

    var mime: String {
        switch self {
        case .jpeg: return "image/jpeg"
        case .png: return "image/png"
        case .gif: return "image/gif"
        case .webp: return "image/webp"
        }
    }

    static func detect(data: Data) -> ImageFormat? {
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return .jpeg }
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return .png }
        if data.starts(with: Array("GIF8".utf8)) { return .gif }
        if data.starts(with: Array("RIFF".utf8)), data.dropFirst(8).prefix(4).elementsEqual(Array("WEBP".utf8)) { return .webp }
        return nil
    }

    /// The FIRST declared type is the representation `Data` actually loads as.
    static func declared(by types: [UTType]) -> ImageFormat? {
        guard let primary = types.first else { return nil }
        if primary.conforms(to: .jpeg) { return .jpeg }
        if primary.conforms(to: .png) { return .png }
        if primary.conforms(to: .gif) { return .gif }
        if primary.conforms(to: .webP) { return .webp }
        return nil
    }
}

private enum AttachmentImporter {
    /// One folder under tmp so every owned copy is easy to find and remove.
    static let directory: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("ComposeAttachments", isDirectory: true)

    static let thumbnailSize = CGSize(width: 320, height: 320)

    /// `IMG_<8 hex>.<ext>` / `VID_<8 hex>.<ext>` — the hex comes from a UUID, so
    /// two imports in the same session can never collide.
    static func makeTempURL(prefix: String, ext: String) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let token = String(UUID().uuidString.prefix(8))
        return directory.appendingPathComponent("\(prefix)_\(token).\(ext)")
    }

    static func delete(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    /// The server's video allowlist, keyed by the extension Photos gave the file.
    static func videoMimeType(forExtension ext: String) -> String? {
        switch ext.lowercased() {
        case "mov": return "video/quicktime"
        case "mp4": return "video/mp4"
        case "m4v": return "video/x-m4v"
        case "webm": return "video/webm"
        default: return nil
        }
    }

    /// CPU-bound (decode + possible re-encode + thumbnail) — call off the main
    /// actor. Known containers are written byte-for-byte; anything else (HEIC
    /// and friends) is re-encoded as JPEG, which every platform accepts.
    static func writeImage(data: Data, declaredTypes: [UTType]) throws -> ImportedFile {
        let format = ImageFormat.detect(data: data) ?? ImageFormat.declared(by: declaredTypes)
        let bytes: Data
        let ext: String
        let mime: String
        if let format {
            bytes = data
            ext = format.ext
            mime = format.mime
        } else {
            guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else {
                throw AttachmentImportError.undecodable
            }
            bytes = jpeg
            ext = "jpg"
            mime = "image/jpeg"
        }
        let url = try makeTempURL(prefix: "IMG", ext: ext)
        try bytes.write(to: url, options: .atomic)
        let full = UIImage(data: bytes)
        let thumbnail = full?.preparingThumbnail(of: thumbnailSize) ?? full
        return ImportedFile(url: url, fileName: url.lastPathComponent, mimeType: mime, thumbnail: thumbnail)
    }

    /// First frame, display-oriented (`appliesPreferredTrackTransform` honours a
    /// phone's rotation tag). Any failure → nil → the tile shows a film icon.
    static func videoThumbnail(url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = thumbnailSize
        do {
            let result = try await generator.image(at: .zero)
            return UIImage(cgImage: result.image)
        } catch {
            return nil
        }
    }
}

// MARK: - Store

/// Owns the attachments of ONE compose session: imports, immediate uploads,
/// retries, removal and the composition rule. Lives in `ComposeView` as
/// `@State`, so it survives tab switches like the caption does.
@MainActor
@Observable
final class AttachmentStore {
    private(set) var attachments: [ComposeAttachment] = []
    /// Inline message for a refused pick (rule violation) or a failed import.
    /// Cleared on the next pick, remove or reset.
    private(set) var ruleMessage: String?
    /// Items still being copied out of Photos (a 4K video copy takes seconds).
    /// Counted into `isBusy` so a post can never be submitted mid-import.
    private(set) var importingCount = 0
    /// Called when an upload comes back UNAUTHORIZED — `ComposeView` wires it
    /// to `SessionStore.handleUnauthorized()` like every other tRPC caller.
    var onUnauthorized: (@MainActor () async -> Void)?

    /// Running upload per attachment id. Replaced on retry, cancelled on remove.
    private var uploadTasks: [UUID: Task<Void, Never>] = [:]
    /// Bumped by `reset()` so an import that was in flight discards its result
    /// (and deletes its file) instead of resurrecting a cleared strip.
    private var generation = 0

    static let maxImages = 10

    // MARK: Derived

    var isBusy: Bool {
        importingCount > 0 || attachments.contains { (attachment: ComposeAttachment) -> Bool in
            switch attachment.state {
            case .queued, .uploading: return true
            case .uploaded, .failed: return false
            }
        }
    }

    var hasFailures: Bool {
        attachments.contains { if case .failed = $0.state { return true } else { return false } }
    }

    /// The first failure's message, for the inline line under the strip.
    var failureMessage: String? {
        for attachment in attachments {
            if case .failed(let message) = attachment.state { return message }
        }
        return nil
    }

    /// `Media.id`s in attachment (display) order — complete once `isBusy` is
    /// false and `hasFailures` is false, which is what `canSubmit` requires.
    var uploadedMediaIds: [String] {
        attachments.compactMap { (attachment: ComposeAttachment) -> String? in
            if case .uploaded(let media) = attachment.state { return media.id }
            return nil
        }
    }

    private var imageCount: Int { attachments.filter { !$0.isVideo }.count }
    private var videoCount: Int { attachments.filter(\.isVideo).count }

    // MARK: Composition rule

    /// nil when `kind` may be added right now; otherwise the message to show.
    /// Failed attachments still count — they occupy the strip until removed.
    private func refusalReason(adding kind: ComposeAttachment.Kind) -> String? {
        switch kind {
        case .video:
            if videoCount > 0 { return "Only one video per post." }
            if imageCount > 0 { return "A post can have either one video or up to \(Self.maxImages) photos. Remove the photos first to add a video." }
            return nil
        case .image:
            if videoCount > 0 { return "Photos can't be added to a post that has a video. Remove the video first." }
            if imageCount >= Self.maxImages { return "Up to \(Self.maxImages) photos per post." }
            return nil
        }
    }

    // MARK: Adding

    /// Imports each picked item in order, appends it and starts its upload.
    /// A refused item sets `ruleMessage` and is skipped; the rest still import.
    func add(items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        ruleMessage = nil
        let batchGeneration = generation

        for item in items {
            let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
            let kind: ComposeAttachment.Kind = isVideo ? .video : .image
            if let refusal = refusalReason(adding: kind) {
                ruleMessage = refusal
                continue
            }

            importingCount += 1
            defer { importingCount -= 1 }

            let imported: ImportedFile
            do {
                if isVideo {
                    imported = try await importVideo(item)
                } else {
                    imported = try await importImage(item)
                }
            } catch {
                ruleMessage = "Couldn't import one of the selected items. \(error.localizedDescription)"
                continue
            }

            // The strip was reset while this item was being copied: drop it.
            guard generation == batchGeneration else {
                AttachmentImporter.delete(imported.url)
                return
            }
            // Re-check: the counts may have moved while the copy was in flight.
            if let refusal = refusalReason(adding: kind) {
                AttachmentImporter.delete(imported.url)
                ruleMessage = refusal
                continue
            }

            var attachment = ComposeAttachment(
                id: UUID(),
                kind: kind,
                fileURL: imported.url,
                fileName: imported.fileName,
                mimeType: imported.mimeType ?? "",
                thumbnail: imported.thumbnail,
                state: .queued
            )
            if imported.mimeType == nil {
                attachment.state = .failed("Unsupported video format")
            }
            attachments.append(attachment)
            if attachment.isRetryable {
                startUpload(id: attachment.id)
            }
        }
    }

    private func importVideo(_ item: PhotosPickerItem) async throws -> ImportedFile {
        guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
            throw AttachmentImportError.unreadable
        }
        let mime = AttachmentImporter.videoMimeType(forExtension: movie.url.pathExtension)
        let thumbnail = await AttachmentImporter.videoThumbnail(url: movie.url)
        return ImportedFile(url: movie.url, fileName: movie.url.lastPathComponent, mimeType: mime, thumbnail: thumbnail)
    }

    private func importImage(_ item: PhotosPickerItem) async throws -> ImportedFile {
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw AttachmentImportError.unreadable
        }
        let declaredTypes = item.supportedContentTypes
        // Decode / re-encode / thumbnail off the main actor — a 50MB photo would
        // otherwise freeze the form for the duration.
        return try await Task.detached(priority: .userInitiated) {
            try AttachmentImporter.writeImage(data: data, declaredTypes: declaredTypes)
        }.value
    }

    // MARK: Uploading

    private func startUpload(id: UUID) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        let attachment = attachments[index]
        guard attachment.isRetryable else { return }
        attachments[index].state = .uploading(0)
        uploadTasks[id]?.cancel()

        let task = Task { @MainActor [weak self] in
            do {
                let media = try await UploadService.shared.upload(
                    fileURL: attachment.fileURL,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                    progress: { fraction in
                        // The progress closure is @Sendable (any thread) — hop
                        // to the main actor before touching the store.
                        Task { @MainActor [weak self] in
                            self?.updateProgress(id: id, fraction: fraction)
                        }
                    }
                )
                guard !Task.isCancelled else { return }
                self?.setState(id: id, state: .uploaded(media))
            } catch {
                // Remove / reset cancel the task; a cancelled upload is not a
                // failure and must never be rendered as one.
                if Task.isCancelled || error is CancellationError { return }
                self?.setState(id: id, state: .failed(error.localizedDescription))
                if let api = error as? APIError, api.isUnauthorized {
                    await self?.onUnauthorized?()
                }
            }
        }
        uploadTasks[id] = task
    }

    private func updateProgress(id: UUID, fraction: Double) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        let clamped = min(max(fraction, 0), 1)
        switch attachments[index].state {
        case .queued:
            attachments[index].state = .uploading(clamped)
        case .uploading(let current):
            // Only re-render when the shown percentage changes — a fast uplink
            // reports progress many times per second.
            if Int(current * 100) != Int(clamped * 100) {
                attachments[index].state = .uploading(clamped)
            }
        case .uploaded, .failed:
            break
        }
    }

    private func setState(id: UUID, state: ComposeAttachment.State) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[index].state = state
    }

    // MARK: Actions

    func retry(id: UUID) {
        guard let attachment = attachments.first(where: { $0.id == id }) else { return }
        guard case .failed = attachment.state, attachment.isRetryable else { return }
        startUpload(id: id)
    }

    /// Cancels the upload (the service aborts it server-side), deletes the
    /// owned temp copy and drops the tile.
    func remove(id: UUID) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        uploadTasks[id]?.cancel()
        uploadTasks[id] = nil
        AttachmentImporter.delete(attachments[index].fileURL)
        attachments.remove(at: index)
        ruleMessage = nil
    }

    /// After a successful `post.create`, or when the workspace changes (an
    /// uploaded `Media` row belongs to the org it was uploaded to — reusing it
    /// in another workspace would be refused by `assertMediaOwned`).
    func reset() {
        generation += 1
        for task in uploadTasks.values { task.cancel() }
        uploadTasks = [:]
        for attachment in attachments { AttachmentImporter.delete(attachment.fileURL) }
        attachments = []
        ruleMessage = nil
    }
}

// MARK: - Views

/// Horizontal strip of 84×84 tiles, one per attachment, plus a spinner tile
/// while an item is still being copied out of Photos.
struct AttachmentStrip: View {
    let store: AttachmentStore

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(store.attachments) { attachment in
                    AttachmentTile(
                        attachment: attachment,
                        onRetry: { store.retry(id: attachment.id) },
                        onRemove: { store.remove(id: attachment.id) }
                    )
                }
                if store.importingCount > 0 {
                    ProgressView()
                        .frame(width: 84, height: 84)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("Importing")
                }
            }
            .padding(.vertical, 4)
        }
    }
}

private struct AttachmentTile: View {
    let attachment: ComposeAttachment
    let onRetry: () -> Void
    let onRemove: () -> Void

    private let side: CGFloat = 84

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground))
            if let thumbnail = attachment.thumbnail {
                // Only ever a UIImage thumbnail — never the video file itself.
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: side, height: side)
                    .clipped()
            } else {
                Image(systemName: attachment.isVideo ? "film" : "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
            stateOverlay
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .bottomLeading) {
            if attachment.isVideo {
                Image(systemName: "play.fill")
                    .font(.system(size: 9, weight: .bold))
                    .padding(4)
                    .background(.black.opacity(0.6), in: Circle())
                    .foregroundStyle(.white)
                    .padding(4)
                    .accessibilityLabel("Video")
            }
        }
        .overlay(alignment: .topTrailing) {
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.65))
                    .font(.system(size: 18))
            }
            .buttonStyle(.plain)
            .padding(3)
            .accessibilityLabel("Remove")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("compose.attachment")
    }

    @ViewBuilder
    private var stateOverlay: some View {
        switch attachment.state {
        case .queued:
            Color.black.opacity(0.35)
            ProgressView().tint(.white)
        case .uploading(let fraction):
            Color.black.opacity(0.35)
            ZStack {
                Circle().stroke(.white.opacity(0.3), lineWidth: 3)
                Circle()
                    .trim(from: 0, to: CGFloat(min(max(fraction, 0), 1)))
                    .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
            }
            .frame(width: 46, height: 46)
            .accessibilityLabel("Uploading \(Int((fraction * 100).rounded())) percent")
        case .uploaded:
            EmptyView()
        case .failed(let message):
            Color.red.opacity(0.55)
            VStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.white)
                if attachment.isRetryable {
                    Button("Retry", action: onRetry)
                        .buttonStyle(.plain)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(.black.opacity(0.45), in: Capsule())
                        .accessibilityLabel("Retry upload")
                }
            }
            .accessibilityLabel("Upload failed: \(message)")
        }
    }
}

/// The "Add photos or videos" control. The binding is cleared right after a
/// pick is handed to the store, so the same photo can be picked again later
/// (the picker would otherwise treat it as already selected and ignore it).
struct AttachmentPickerButton: View {
    let store: AttachmentStore
    @State private var selection: [PhotosPickerItem] = []

    var body: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: AttachmentStore.maxImages,
            matching: .any(of: [.images, .videos]),
            photoLibrary: .shared()
        ) {
            Label("Add photos or videos", systemImage: "photo.on.rectangle.angled")
        }
        .accessibilityIdentifier("compose.addMedia")
        .onChange(of: selection) { _, newValue in
            guard !newValue.isEmpty else { return }
            let items = newValue
            selection = []
            Task { await store.add(items: items) }
        }
    }
}
