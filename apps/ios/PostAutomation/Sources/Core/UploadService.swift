import Foundation

// Direct-to-S3 presigned multipart uploader — the iOS counterpart of
// apps/web/lib/upload-multipart.ts, against the SAME three tRPC mutations
// (packages/api/src/routers/upload.router.ts: initiate / signPart / complete /
// abort). The bytes never pass through the web container: each part is PUT
// straight to the presigned URL, which is what lets a phone send a multi-GB
// video without the proxied /api/upload route buffering it in Node.
//
// No backend change was needed; every wire shape below was read off the
// router's zod schemas.

// MARK: - Plan

/// One part of a multipart upload: the 1-based S3 part number and the byte
/// window of the source file it carries.
struct UploadPart: Equatable, Sendable {
    let number: Int
    let offset: Int64
    let length: Int
}

/// Pure planning rules — part sizing, ETag normalisation, the server's
/// allow-list and size caps, retry backoff. Deliberately free of I/O so the
/// unit tests can pin them without a network or a file on disk.
enum UploadPlanner {
    /// S3's minimum part size is 5 MiB (except for the last part). 8 MiB matches
    /// the web client: few enough parts to keep request overhead low, small
    /// enough that a retry after a Wi-Fi blip costs seconds, not minutes.
    static let partSize = 8 * 1024 * 1024
    /// The web uses 4. A phone uplink is narrower, and three in-flight parts
    /// already saturate it while bounding memory at 3 × 8 MiB.
    static let maxParallelParts = 3
    /// 1 initial + 5 retries per part. A multi-GB upload spans long enough that
    /// one transient blip is near-certain, and a lost part costs only 8 MiB —
    /// each attempt gets a FRESH presigned URL, so URL expiry can never fail a retry.
    static let partAttempts = 6
    /// `upload.complete` turns the whole transfer into a Media row, so it gets
    /// its own budget — but it is retried ONLY on transport failures: a
    /// structured tRPC rejection (oversize, wrong org) is deterministic.
    static let completeAttempts = 5
    /// Backoff ceiling: 1s → 3s → 9s → 27s → 30s → 30s (plus up to 0.5s jitter).
    /// Long enough to ride out a router hiccup, short enough that a genuinely
    /// dead link surfaces an error in about a minute.
    static let maxRetryDelay: Double = 30

    // Mirrors MAX_IMAGE_SIZE / MAX_VIDEO_SIZE / ALLOWED_TYPES in upload.router.ts.
    // The server re-checks all of this; validating here just saves a round-trip
    // and gives the user the answer before any bytes move.
    static let maxImageBytes: Int64 = 50 * 1024 * 1024
    static let maxVideoBytes: Int64 = 4 * 1024 * 1024 * 1024
    static let imageTypes: Set<String> = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]
    static let videoTypes: Set<String> = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"]

    /// Splits a file into contiguous parts; the last one carries the remainder.
    /// An empty file yields no parts (the server rejects a zero `fileSize` anyway).
    static func parts(forFileSize fileSize: Int64) -> [UploadPart] {
        guard fileSize > 0 else { return [] }
        let chunk = Int64(partSize)
        let count = Int((fileSize + chunk - 1) / chunk)
        var result: [UploadPart] = []
        result.reserveCapacity(count)
        for index in 0..<count {
            let offset = Int64(index) * chunk
            let length = Int(min(chunk, fileSize - offset))
            result.append(UploadPart(number: index + 1, offset: offset, length: length))
        }
        return result
    }

    /// S3 returns the part ETag as a quoted string (`"d41d8cd9..."`); the
    /// complete call wants the bare value, exactly as the web client sends it.
    static func normalizeETag(_ raw: String) -> String {
        raw.replacingOccurrences(of: "\"", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Same allow-list and caps as `upload.initiate`, checked in the same order
    /// (type first, then size), with the server's own wording.
    static func validate(mimeType: String, fileSize: Int64) throws {
        guard imageTypes.contains(mimeType) || videoTypes.contains(mimeType) else {
            throw UploadError.unsupportedType(mimeType)
        }
        guard fileSize > 0 else { throw UploadError.emptyFile }
        let isVideo = mimeType.hasPrefix("video/")
        let limit = isVideo ? maxVideoBytes : maxImageBytes
        if fileSize > limit {
            throw UploadError.tooLarge(isVideo ? "Videos must be under 4GB." : "Images must be under 50 MB.")
        }
    }

    /// Seconds to wait before retrying after the given 1-based attempt failed:
    /// `min(30, 1 × 3^(attempt-1))`. Jitter is added by the caller so this
    /// stays deterministic for tests.
    static func retryDelay(afterAttempt attempt: Int) -> Double {
        var delay = 1.0
        if attempt > 1 {
            for _ in 1..<attempt { delay *= 3 }
        }
        return min(maxRetryDelay, delay)
    }
}

// MARK: - Errors

/// Failures the uploader itself produces. `APIError`s from the tRPC calls are
/// rethrown UNTOUCHED (never wrapped) so the views' standard
/// `catch let e as APIError where e.isUnauthorized` pattern keeps working, and
/// a cancelled Task always surfaces as `CancellationError`.
enum UploadError: Error, LocalizedError, Equatable {
    /// The file could not be opened/sized/read (moved, permission lost, a
    /// security-scoped URL the caller stopped accessing, or it shrank mid-upload).
    case fileUnreadable
    case emptyFile
    /// Not in the server's allow-list (associated value = the MIME type).
    case unsupportedType(String)
    /// Over the per-kind cap (associated value = the server's detail sentence).
    case tooLarge(String)
    /// The storage server answered a part PUT with a non-2xx status.
    case partFailed(status: Int)
    /// A part PUT succeeded but carried no ETag — `complete` cannot be built
    /// without it (on S3/MinIO this means the bucket CORS/headers are wrong).
    case missingETag
    /// MinIO 507 (XMinioStorageFull): retrying only hammers an already-full box.
    case storageFull
    /// The API answered 2xx with something the uploader cannot act on.
    case api(String)

    var errorDescription: String? {
        switch self {
        case .fileUnreadable:
            return "The file couldn't be read. Please pick it again and retry."
        case .emptyFile:
            return "The file is empty."
        case .unsupportedType(let mime):
            if mime.hasPrefix("image/") {
                return "File type '\(mime)' is not supported. Photos must be JPEG, PNG, GIF, WebP or AVIF."
            }
            return "File type '\(mime)' is not supported. Videos must be MP4, MOV or WebM — convert the file (e.g. with HandBrake) and retry."
        case .tooLarge(let detail):
            return "File too large. \(detail)"
        case .partFailed(let status):
            return "The storage server rejected part of the upload (HTTP \(status)). Check your connection and try again."
        case .missingETag:
            return "The storage server didn't acknowledge an uploaded part. Please try again."
        case .storageFull:
            return "Upload storage is full. Please try again later or contact support."
        case .api(let message):
            return message
        }
    }
}

// MARK: - Wire shapes (upload.router.ts)

private struct InitiateInput: Encodable {
    let fileName: String
    let fileType: String
    let fileSize: Int64
    /// zod `.optional()` — omitted (not null) when nil, which synthesized
    /// Encodable does for us via encodeIfPresent.
    let category: String?
}

/// `{ uploadId, key, bucket }` — `bucket` is not needed client-side.
private struct InitiateResult: Decodable {
    let uploadId: String
    let key: String
}

private struct SignPartInput: Encodable {
    let key: String
    let uploadId: String
    let partNumber: Int
}

private struct SignPartResult: Decodable {
    let url: String
}

private struct CompletePart: Encodable {
    let partNumber: Int
    let etag: String
}

private struct CompleteInput: Encodable {
    let key: String
    let uploadId: String
    let parts: [CompletePart]
    let fileName: String
    let fileType: String
    let fileSize: Int64
    let category: String?
}

private struct AbortInput: Encodable {
    let key: String
    let uploadId: String
}

// MARK: - Service

/// Uploads one file to S3 via presigned multipart PUTs and returns the Media row
/// `upload.complete` created. Cancelling the calling Task cancels the in-flight
/// PUTs and aborts the upload server-side.
///
/// `progress` is called after every completed part (0…0.99) and once with 1.0
/// after `complete` — from an arbitrary thread, so hop to the main actor before
/// touching UI state.
///
/// For a URL from `.fileImporter` the caller must hold
/// `startAccessingSecurityScopedResource()` for the whole upload; a
/// `PhotosPicker` transfer that was copied into the app sandbox needs nothing.
final class UploadService: @unchecked Sendable {
    static let shared = UploadService()

    private let client: TRPCClient
    /// Dedicated session for the part PUTs — NOT the cookie-bearing one
    /// `TRPCClient` uses. The presigned URL may live on the API host
    /// (`https://postautomation.co.in/media/...`), and the NextAuth session
    /// cookie must never ride along to the storage server.
    private let uploadSession: URLSession

    init(client: TRPCClient = .shared, session: URLSession? = nil) {
        self.client = client
        if let session {
            self.uploadSession = session
        } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.httpShouldSetCookies = false
            cfg.httpCookieAcceptPolicy = .never
            // 8 MiB at even ~150 kbit/s fits in 10 minutes: catches a genuinely
            // hung socket without killing a slow-but-alive link.
            cfg.timeoutIntervalForRequest = 600
            cfg.timeoutIntervalForResource = 4 * 3600
            cfg.waitsForConnectivity = true
            self.uploadSession = URLSession(configuration: cfg)
        }
    }

    // MARK: Public API

    func upload(
        fileURL: URL,
        fileName: String,
        mimeType: String,
        category: String? = nil,
        progress: @escaping @Sendable (Double) -> Void = { _ in }
    ) async throws -> UploadedMedia {
        // 1. Validate before anything moves. The size is needed for the cap
        //    check, so it is read first; both answers come back instantly.
        let fileSize = try Self.measureFileSize(at: fileURL)
        try UploadPlanner.validate(mimeType: mimeType, fileSize: fileSize)
        try Task.checkCancellation()

        // 2. Initiate — the server mints the org-scoped key + S3 uploadId. No
        //    Media row exists yet; that only happens in `complete`.
        let initiated: InitiateResult = try await client.mutate(
            "upload.initiate",
            input: InitiateInput(fileName: fileName, fileType: mimeType, fileSize: fileSize, category: category)
        )
        let key = initiated.key
        let uploadId = initiated.uploadId

        // From here on, ANY exit other than a successful complete must free the
        // server-side multipart state, or the parts sit in the bucket until
        // MinIO's 24h stale-upload janitor sweeps them.
        do {
            let parts = try await uploadParts(
                UploadPlanner.parts(forFileSize: fileSize),
                fileURL: fileURL, mimeType: mimeType, key: key, uploadId: uploadId,
                totalBytes: fileSize, progress: progress
            )
            let media = try await complete(CompleteInput(
                key: key, uploadId: uploadId, parts: parts,
                fileName: fileName, fileType: mimeType, fileSize: fileSize, category: category
            ))
            progress(1.0)
            return media
        } catch {
            await abortQuietly(key: key, uploadId: uploadId)
            // An in-flight PUT cancelled with the Task throws URLError.cancelled,
            // not CancellationError — normalise so callers can rely on
            // `catch is CancellationError` meaning "the user cancelled".
            if Task.isCancelled { throw CancellationError() }
            throw error
        }
    }

    // MARK: Parts

    private struct PartOutcome: Sendable {
        let partNumber: Int
        let etag: String
        let length: Int
    }

    /// Uploads every part with at most `maxParallelParts` in flight: the group
    /// is primed with three tasks and one more is added each time one finishes.
    /// If a part exhausts its attempts the group cancels its siblings, so they
    /// stop retrying against an uploadId the caller is about to abort.
    private func uploadParts(
        _ parts: [UploadPart],
        fileURL: URL,
        mimeType: String,
        key: String,
        uploadId: String,
        totalBytes: Int64,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> [CompletePart] {
        let outcomes: [PartOutcome] = try await withThrowingTaskGroup(
            of: PartOutcome.self, returning: [PartOutcome].self
        ) { group in
            var collected: [PartOutcome] = []
            collected.reserveCapacity(parts.count)
            var completedBytes: Int64 = 0
            var nextIndex = 0

            while nextIndex < parts.count && nextIndex < UploadPlanner.maxParallelParts {
                let part = parts[nextIndex]
                nextIndex += 1
                group.addTask {
                    try await self.uploadPart(part, fileURL: fileURL, mimeType: mimeType, key: key, uploadId: uploadId)
                }
            }

            while let outcome = try await group.next() {
                collected.append(outcome)
                completedBytes += Int64(outcome.length)
                // 1.0 is reserved for a successful `complete` — a bar that reads
                // 100% while the Media row does not exist yet would be a lie.
                let fraction = totalBytes > 0 ? Double(completedBytes) / Double(totalBytes) : 0
                progress(min(0.99, fraction))

                if nextIndex < parts.count {
                    let part = parts[nextIndex]
                    nextIndex += 1
                    group.addTask {
                        try await self.uploadPart(part, fileURL: fileURL, mimeType: mimeType, key: key, uploadId: uploadId)
                    }
                }
            }
            return collected
        }

        return outcomes
            .sorted { $0.partNumber < $1.partNumber }
            .map { CompletePart(partNumber: $0.partNumber, etag: $0.etag) }
    }

    /// One part, retried up to `partAttempts` times. Every attempt signs a fresh
    /// URL and re-reads the bytes from disk, so neither an expired URL nor a
    /// half-consumed buffer can poison the retry.
    private func uploadPart(
        _ part: UploadPart,
        fileURL: URL,
        mimeType: String,
        key: String,
        uploadId: String
    ) async throws -> PartOutcome {
        var lastError: Error = UploadError.partFailed(status: 0)
        for attempt in 1...UploadPlanner.partAttempts {
            try Task.checkCancellation()
            do {
                let signed: SignPartResult = try await client.mutate(
                    "upload.signPart",
                    input: SignPartInput(key: key, uploadId: uploadId, partNumber: part.number)
                )
                guard let url = URL(string: signed.url) else {
                    throw UploadError.api("The server returned an invalid upload address.")
                }
                let bytes = try Self.readPart(part, from: fileURL)
                let etag = try await put(bytes, to: url, mimeType: mimeType)
                return PartOutcome(partNumber: part.number, etag: etag, length: part.length)
            } catch {
                if Task.isCancelled { throw CancellationError() }
                guard Self.isRetryablePartError(error) else { throw error }
                lastError = error
                if attempt < UploadPlanner.partAttempts {
                    try await Self.backoff(afterAttempt: attempt)
                }
            }
        }
        throw lastError
    }

    /// PUTs the bytes to the presigned URL and returns the normalised ETag.
    private func put(_ bytes: Data, to url: URL, mimeType: String) async throws -> String {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.httpShouldHandleCookies = false
        req.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await uploadSession.upload(for: req, from: bytes)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // MinIO disk-full. Unambiguously terminal — burning the retry ladder
        // just hammers an already-stressed box (same rule as the web client).
        if http.statusCode == 507 { throw UploadError.storageFull }
        guard (200..<300).contains(http.statusCode) else {
            throw UploadError.partFailed(status: http.statusCode)
        }
        guard let raw = http.value(forHTTPHeaderField: "ETag") else { throw UploadError.missingETag }
        let etag = UploadPlanner.normalizeETag(raw)
        guard !etag.isEmpty else { throw UploadError.missingETag }
        return etag
    }

    /// Reads exactly one part's bytes through a fresh handle each time; a short
    /// read means the file changed underneath us and the upload must not
    /// continue with a corrupt tail.
    private static func readPart(_ part: UploadPart, from fileURL: URL) throws -> Data {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: fileURL)
        } catch {
            throw UploadError.fileUnreadable
        }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: UInt64(part.offset))
            guard let data = try handle.read(upToCount: part.length), data.count == part.length else {
                throw UploadError.fileUnreadable
            }
            return data
        } catch let e as UploadError {
            throw e
        } catch {
            throw UploadError.fileUnreadable
        }
    }

    // MARK: Complete / abort

    /// Retried only on transport failures: a tRPC rejection here (oversize
    /// BAD_REQUEST, org-scope FORBIDDEN, "Failed to finalize") is deterministic
    /// and re-asking just burns the budget.
    private func complete(_ input: CompleteInput) async throws -> UploadedMedia {
        var lastError: Error = APIError.invalidResponse
        for attempt in 1...UploadPlanner.completeAttempts {
            try Task.checkCancellation()
            do {
                let media: UploadedMedia = try await client.mutate("upload.complete", input: input)
                return media
            } catch {
                if Task.isCancelled { throw CancellationError() }
                guard Self.isTransportFailure(error) else { throw error }
                lastError = error
                if attempt < UploadPlanner.completeAttempts {
                    try await Self.backoff(afterAttempt: attempt)
                }
            }
        }
        throw lastError
    }

    /// Best-effort `upload.abort`; its own errors are ignored. It runs in an
    /// unstructured Task because that is the one thing that does NOT inherit
    /// the caller's cancellation — otherwise a user-cancelled upload could never
    /// tell the server to drop its parts. A plain failure waits for it so the
    /// server-side state is settled before the error reaches the UI; a cancel
    /// returns immediately.
    private func abortQuietly(key: String, uploadId: String) async {
        let client = self.client
        let cleanup = Task {
            do {
                let _: Ack = try await client.mutate("upload.abort", input: AbortInput(key: key, uploadId: uploadId))
            } catch {
                // Nothing useful to do: MinIO's stale-upload janitor is the backstop.
            }
        }
        if !Task.isCancelled {
            _ = await cleanup.value
        }
    }

    // MARK: Helpers

    private static func measureFileSize(at url: URL) throws -> Int64 {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attributes[.size] as? NSNumber)?.int64Value else {
            throw UploadError.fileUnreadable
        }
        return size
    }

    /// Transport-level failures that a later attempt can genuinely fix.
    private static func isTransportFailure(_ error: Error) -> Bool {
        if error is URLError { return true }
        if let api = error as? APIError, case .http(let status, _) = api {
            return status == 429 || status >= 500
        }
        return false
    }

    /// A rejected part PUT is retried with a fresh URL (403 = expired/consumed
    /// URL, 5xx = storage hiccup); 507, a missing ETag, an unreadable file and
    /// every structured tRPC error are terminal.
    private static func isRetryablePartError(_ error: Error) -> Bool {
        if let e = error as? UploadError, case .partFailed = e { return true }
        return isTransportFailure(error)
    }

    private static func backoff(afterAttempt attempt: Int) async throws {
        let seconds = UploadPlanner.retryDelay(afterAttempt: attempt) + Double.random(in: 0..<0.5)
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}
