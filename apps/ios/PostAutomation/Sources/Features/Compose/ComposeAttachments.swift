import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

/// One photo or video picked in Compose. It uploads as soon as it is picked
/// (like the web), so by the time the user taps Schedule it is usually ready.
@Observable
final class ComposeAttachment: Identifiable {
    enum Kind { case image, video }
    enum State: Equatable {
        case preparing
        case uploading(Double)
        case uploaded(mediaId: String)
        case failed(String)
    }

    let id = UUID()
    var kind: Kind
    var thumbnail: UIImage?
    var state: State = .preparing
    var task: Task<Void, Never>?
    /// The temp copy we upload from — kept until the upload succeeds so Retry works.
    var localFile: URL?
    var fileName = ""
    var mimeType = ""

    init(kind: Kind) { self.kind = kind }

    func deleteLocalFile() {
        if let localFile { try? FileManager.default.removeItem(at: localFile) }
        localFile = nil
    }

    var mediaId: String? {
        if case .uploaded(let id) = state { return id }
        return nil
    }
    var isBusy: Bool {
        switch state {
        case .preparing, .uploading: return true
        default: return false
        }
    }
    var failure: String? {
        if case .failed(let msg) = state { return msg }
        return nil
    }
}

/// A picked video, copied out of the Photos library into a temp file we own.
struct PickedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent("compose-\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: dest)
            return PickedMovie(url: dest)
        }
    }
}

enum AttachmentPreparer {
    /// Turns a Photos item into a local file + MIME type the server accepts.
    /// Photos are always re-encoded as JPEG (iPhone photos are HEIC, which the
    /// server and Instagram reject); videos are uploaded as-is.
    static func prepare(_ item: PhotosPickerItem) async throws -> (url: URL, fileName: String, mimeType: String, kind: ComposeAttachment.Kind, thumbnail: UIImage?) {
        let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
        if isVideo {
            guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                throw UploadError.emptyFile
            }
            let ext = movie.url.pathExtension.lowercased()
            guard let mime = MediaUploadPlan.mimeType(forExtension: ext) else {
                try? FileManager.default.removeItem(at: movie.url)
                throw UploadError.unsupportedType(ext)
            }
            return (movie.url, "video-\(Int(Date().timeIntervalSince1970)).\(ext)", mime, .video, await videoThumbnail(movie.url))
        }

        guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
            throw UploadError.emptyFile
        }
        let jpeg = image.jpegData(compressionQuality: 0.9) ?? data
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("compose-\(UUID().uuidString).jpg")
        try jpeg.write(to: url)
        return (url, "photo-\(Int(Date().timeIntervalSince1970)).jpg", "image/jpeg", .image, image.preparingThumbnail(of: CGSize(width: 240, height: 240)) ?? image)
    }

    static func videoThumbnail(_ url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 240, height: 240)
        guard let cg = try? await generator.image(at: .zero).image else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// The horizontal strip of picked media in Compose.
struct AttachmentStrip: View {
    let attachments: [ComposeAttachment]
    let onRemove: (ComposeAttachment) -> Void
    let onRetry: (ComposeAttachment) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(attachments) { a in
                    tile(a)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func tile(_ a: ComposeAttachment) -> some View {
        ZStack {
            Group {
                if let thumb = a.thumbnail {
                    Image(uiImage: thumb).resizable().scaledToFill()
                } else {
                    Color.secondary.opacity(0.15)
                }
            }
            .frame(width: 84, height: 84)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            if a.kind == .video {
                Image(systemName: "play.circle.fill")
                    .font(.title2).foregroundStyle(.white).shadow(radius: 2)
            }

            switch a.state {
            case .preparing:
                ProgressView().tint(.white)
                    .frame(width: 84, height: 84)
                    .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
            case .uploading(let p):
                VStack(spacing: 4) {
                    ProgressView(value: p).tint(.white).frame(width: 60)
                    Text("\(Int(p * 100))%").font(.caption2.bold()).foregroundStyle(.white)
                }
                .frame(width: 84, height: 84)
                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
            case .failed:
                Button { onRetry(a) } label: {
                    VStack(spacing: 2) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text("Retry").font(.caption2.bold())
                    }
                    .foregroundStyle(.white)
                    .frame(width: 84, height: 84)
                    .background(.red.opacity(0.65), in: RoundedRectangle(cornerRadius: 10))
                }
                .accessibilityLabel("Upload failed. Retry")
            case .uploaded:
                EmptyView()
            }
        }
        .overlay(alignment: .topTrailing) {
            Button { onRemove(a) } label: {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.6))
                    .font(.title3)
            }
            .offset(x: 6, y: -6)
            .accessibilityLabel("Remove attachment")
        }
    }
}
