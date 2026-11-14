import Foundation

/// What `upload.complete` returns — the Media row `post.create` takes as `mediaIds`.
struct UploadedMedia: Decodable, Equatable {
    let id: String
    let url: String
    let fileName: String
    let fileType: String
}

enum UploadError: Error, LocalizedError, Equatable {
    case unsupportedType(String)
    case tooLarge(isVideo: Bool)
    case emptyFile
    case partFailed(Int, String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .unsupportedType(let ext):
            return "'.\(ext)' files aren't supported. Use a JPEG, PNG, GIF or WebP photo, or an MP4 or MOV video."
        case .tooLarge(let isVideo):
            return isVideo ? "Videos must be under 4 GB." : "Photos must be under 50 MB."
        case .emptyFile:
            return "That file is empty."
        case .partFailed(let n, let detail):
            return "The upload stopped at part \(n) (\(detail)). Check your connection and try again."
        case .cancelled:
            return "Upload cancelled."
        }
    }
}

/// Pure helpers, kept separate so they can be unit-tested without a network.
enum MediaUploadPlan {
    /// 8 MiB, the same as the web (S3's minimum part size is 5 MiB except the last part).
    static let partSize: Int64 = 8 * 1024 * 1024
    static let maxImageBytes: Int64 = 50 * 1024 * 1024
    static let maxVideoBytes: Int64 = 4 * 1024 * 1024 * 1024

    struct Part: Equatable {
        let number: Int
        let offset: Int64
        let length: Int
    }

    /// 1-based parts covering `fileSize` bytes; the last part carries the remainder.
    static func parts(fileSize: Int64, partSize: Int64 = partSize) -> [Part] {
        guard fileSize > 0 else { return [] }
        var out: [Part] = []
        var offset: Int64 = 0
        var n = 1
        while offset < fileSize {
            let len = min(partSize, fileSize - offset)
            out.append(Part(number: n, offset: offset, length: Int(len)))
            offset += len
            n += 1
        }
        return out
    }

    /// The MIME type the server accepts for a file extension, or nil when it
    /// would refuse it. `.m4v` is sent as `video/mp4` (the same container), as
    /// the web does; HEIC never reaches here — photos are converted to JPEG first.
    static func mimeType(forExtension ext: String) -> String? {
        switch ext.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "webm": return "video/webm"
        default: return nil
        }
    }

    static func sizeProblem(bytes: Int64, mimeType: String) -> UploadError? {
        if bytes <= 0 { return .emptyFile }
        let isVideo = mimeType.hasPrefix("video/")
        return bytes > (isVideo ? maxVideoBytes : maxImageBytes) ? .tooLarge(isVideo: isVideo) : nil
    }

    /// Delay before retry `attempt` (1-based): 1s, 3s, 9s, … capped at 30s.
    static func retryDelay(attempt: Int) -> TimeInterval {
        min(30, pow(3, Double(attempt - 1)))
    }
}

/// Uploads a local file straight to media storage using the same presigned
/// multipart flow as the web (`upload.initiate` → `signPart` per part → PUT →
/// `upload.complete`). Nothing passes through the web server, so videos up to
/// 4 GB work. Each part retries with a FRESH presigned URL; if a part runs out
/// of attempts the upload is aborted so storage doesn't keep the partial parts.
final class MediaUploader {
    static let partAttempts = 4
    static let completeAttempts = 6

    private let client: TRPCClient
    private let session: URLSession

    init(client: TRPCClient = .shared) {
        self.client = client
        let cfg = URLSessionConfiguration.default
        // Presigned URLs carry their own auth; no cookies needed.
        cfg.httpShouldSetCookies = false
        cfg.timeoutIntervalForRequest = 10 * 60
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg)
    }

    private struct InitiateInput: Encodable { let fileName: String; let fileType: String; let fileSize: Int64 }
    private struct InitiateOutput: Decodable { let uploadId: String; let key: String }
    private struct SignInput: Encodable { let key: String; let uploadId: String; let partNumber: Int }
    private struct SignOutput: Decodable { let url: String }
    private struct DonePart: Encodable { let partNumber: Int; let etag: String }
    private struct CompleteInput: Encodable {
        let key: String; let uploadId: String; let parts: [DonePart]
        let fileName: String; let fileType: String; let fileSize: Int64
    }
    private struct AbortInput: Encodable { let key: String; let uploadId: String }
    private struct AbortOutput: Decodable { let success: Bool }

    /// `progress` is called with 0…1 after each part.
    func upload(
        fileURL: URL,
        fileName: String,
        mimeType: String,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> UploadedMedia {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        if let problem = MediaUploadPlan.sizeProblem(bytes: size, mimeType: mimeType) { throw problem }

        let started: InitiateOutput = try await client.mutate(
            "upload.initiate", input: InitiateInput(fileName: fileName, fileType: mimeType, fileSize: size)
        )
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        var done: [DonePart] = []
        do {
            let parts = MediaUploadPlan.parts(fileSize: size)
            var sent: Int64 = 0
            for part in parts {
                try Task.checkCancellation()
                try handle.seek(toOffset: UInt64(part.offset))
                guard let bytes = try handle.read(upToCount: part.length), bytes.count == part.length else {
                    throw UploadError.partFailed(part.number, "the file couldn't be read")
                }
                let etag = try await putPart(bytes, number: part.number, key: started.key, uploadId: started.uploadId)
                done.append(DonePart(partNumber: part.number, etag: etag))
                sent += Int64(part.length)
                progress(Double(sent) / Double(size))
            }
        } catch {
            // Free the partial parts. Best effort — storage also expires them in 24h.
            let _: AbortOutput? = try? await client.mutate("upload.abort", input: AbortInput(key: started.key, uploadId: started.uploadId))
            if error is CancellationError { throw UploadError.cancelled }
            throw error
        }

        // A lost finalize costs the whole file, so it gets more patience than a part.
        let input = CompleteInput(key: started.key, uploadId: started.uploadId, parts: done,
                                  fileName: fileName, fileType: mimeType, fileSize: size)
        var attempt = 1
        while true {
            do {
                return try await client.mutate("upload.complete", input: input)
            } catch let e as APIError {
                // A refusal (bad type/size, wrong org) will never succeed on retry.
                if case .trpc = e { throw e }
                if attempt >= Self.completeAttempts { throw e }
            } catch {
                if attempt >= Self.completeAttempts { throw error }
            }
            try await Task.sleep(nanoseconds: UInt64(MediaUploadPlan.retryDelay(attempt: attempt) * 1_000_000_000))
            attempt += 1
        }
    }

    private func putPart(_ bytes: Data, number: Int, key: String, uploadId: String) async throws -> String {
        var lastDetail = "network error"
        for attempt in 1...Self.partAttempts {
            try Task.checkCancellation()
            do {
                let signed: SignOutput = try await client.mutate(
                    "upload.signPart", input: SignInput(key: key, uploadId: uploadId, partNumber: number)
                )
                guard let url = URL(string: signed.url) else { throw UploadError.partFailed(number, "bad upload URL") }
                var req = URLRequest(url: url)
                req.httpMethod = "PUT"
                let (_, response) = try await session.upload(for: req, from: bytes)
                guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
                if (200..<300).contains(http.statusCode), let etag = http.value(forHTTPHeaderField: "ETag"), !etag.isEmpty {
                    return etag
                }
                // Storage full: retrying can't help.
                if http.statusCode == 507 { throw UploadError.partFailed(number, "storage is full") }
                lastDetail = "HTTP \(http.statusCode)"
            } catch let e as UploadError {
                throw e
            } catch is CancellationError {
                throw CancellationError()
            } catch let e as APIError {
                if case .trpc = e { throw e }
                lastDetail = e.localizedDescription
            } catch {
                lastDetail = error.localizedDescription
            }
            if attempt < Self.partAttempts {
                try await Task.sleep(nanoseconds: UInt64(MediaUploadPlan.retryDelay(attempt: attempt) * 1_000_000_000))
            }
        }
        throw UploadError.partFailed(number, lastDetail)
    }
}
