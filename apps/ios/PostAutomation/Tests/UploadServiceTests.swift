import XCTest
@testable import PostAutomation

/// Pure tests for the upload planner — part geometry, ETag normalisation, the
/// server's allow-list/caps and the retry ladder. No network, no file I/O: these
/// pin the rules that must stay in step with apps/web/lib/upload-multipart.ts
/// and packages/api/src/routers/upload.router.ts.
final class UploadServiceTests: XCTestCase {

    private let mib: Int64 = 1024 * 1024
    private let gib: Int64 = 1024 * 1024 * 1024
    private var partSize: Int64 { Int64(UploadPlanner.partSize) }

    // MARK: - Constants shared with the web client

    func testPlannerConstantsMatchTheWebUploader() {
        XCTAssertEqual(UploadPlanner.partSize, 8 * 1024 * 1024)
        XCTAssertEqual(UploadPlanner.maxParallelParts, 3)
        XCTAssertEqual(UploadPlanner.partAttempts, 6)
        XCTAssertEqual(UploadPlanner.completeAttempts, 5)
    }

    // MARK: - parts(forFileSize:)

    func testEmptyFileHasNoParts() {
        XCTAssertEqual(UploadPlanner.parts(forFileSize: 0), [])
    }

    func testOneByteIsASinglePart() {
        XCTAssertEqual(UploadPlanner.parts(forFileSize: 1), [UploadPart(number: 1, offset: 0, length: 1)])
    }

    func testExactlyOnePartSizeIsASinglePart() {
        let parts = UploadPlanner.parts(forFileSize: 8 * mib)
        XCTAssertEqual(parts, [UploadPart(number: 1, offset: 0, length: UploadPlanner.partSize)])
    }

    func testOneByteOverPartSizeSpillsIntoASecondPart() {
        let parts = UploadPlanner.parts(forFileSize: 8 * mib + 1)
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts[0], UploadPart(number: 1, offset: 0, length: UploadPlanner.partSize))
        XCTAssertEqual(parts[1], UploadPart(number: 2, offset: partSize, length: 1))
    }

    func testHundredMegabyteFile() {
        let size: Int64 = 100_000_000
        let parts = UploadPlanner.parts(forFileSize: size)
        // ceil(100_000_000 / 8_388_608) = 12 parts; the last carries the remainder.
        XCTAssertEqual(parts.count, 12)
        for (index, part) in parts.enumerated() {
            XCTAssertEqual(part.number, index + 1, "part numbers are 1-based and ascending")
            XCTAssertEqual(part.offset, Int64(index) * partSize)
            if index < parts.count - 1 {
                XCTAssertEqual(part.length, UploadPlanner.partSize)
            }
        }
        XCTAssertEqual(parts.last?.length, 7_725_312)
        XCTAssertEqual(parts.last?.offset, 11 * partSize)
        XCTAssertEqual(parts.reduce(Int64(0)) { $0 + Int64($1.length) }, size)
    }

    func testPartsAreContiguousAndCoverTheWholeFile() {
        for size: Int64 in [5, 8 * mib - 1, 8 * mib + 7, 3 * 8 * mib, 1 * gib + 12_345] {
            let parts = UploadPlanner.parts(forFileSize: size)
            XCTAssertFalse(parts.isEmpty)
            var expectedOffset: Int64 = 0
            for part in parts {
                XCTAssertEqual(part.offset, expectedOffset, "size \(size)")
                XCTAssertGreaterThan(part.length, 0)
                XCTAssertLessThanOrEqual(part.length, UploadPlanner.partSize)
                expectedOffset += Int64(part.length)
            }
            XCTAssertEqual(expectedOffset, size, "size \(size)")
        }
    }

    func testFourGigabyteVideoStaysUnderTheS3PartLimit() {
        // S3 allows at most 10,000 parts; the server caps partNumber the same way.
        XCTAssertLessThanOrEqual(UploadPlanner.parts(forFileSize: UploadPlanner.maxVideoBytes).count, 10_000)
    }

    // MARK: - normalizeETag

    func testNormalizeETagStripsQuotesAndWhitespace() {
        XCTAssertEqual(UploadPlanner.normalizeETag("\"d41d8cd98f00b204e9800998ecf8427e\""), "d41d8cd98f00b204e9800998ecf8427e")
        XCTAssertEqual(UploadPlanner.normalizeETag("  \"abc-2\"\n"), "abc-2")
        XCTAssertEqual(UploadPlanner.normalizeETag("plain"), "plain")
        XCTAssertEqual(UploadPlanner.normalizeETag("\"\""), "")
    }

    // MARK: - validate(mimeType:fileSize:)

    func testValidateAcceptsSupportedTypesWithinTheCaps() {
        XCTAssertNoThrow(try UploadPlanner.validate(mimeType: "image/jpeg", fileSize: 10 * mib))
        XCTAssertNoThrow(try UploadPlanner.validate(mimeType: "video/quicktime", fileSize: 1 * gib))
        // Exactly at the cap is still allowed (the server checks `>`).
        XCTAssertNoThrow(try UploadPlanner.validate(mimeType: "image/png", fileSize: UploadPlanner.maxImageBytes))
        XCTAssertNoThrow(try UploadPlanner.validate(mimeType: "video/mp4", fileSize: UploadPlanner.maxVideoBytes))
    }

    func testValidateRejectsUnsupportedType() {
        XCTAssertThrowsError(try UploadPlanner.validate(mimeType: "image/heic", fileSize: 1 * mib)) { error in
            XCTAssertEqual(error as? UploadError, .unsupportedType("image/heic"))
            XCTAssertTrue((error as? UploadError)?.errorDescription?.contains("image/heic") == true)
        }
        XCTAssertThrowsError(try UploadPlanner.validate(mimeType: "video/x-matroska", fileSize: 1 * mib)) { error in
            XCTAssertEqual(error as? UploadError, .unsupportedType("video/x-matroska"))
        }
    }

    func testValidateRejectsOversizedImage() {
        XCTAssertThrowsError(try UploadPlanner.validate(mimeType: "image/jpeg", fileSize: 51 * mib)) { error in
            XCTAssertEqual(error as? UploadError, .tooLarge("Images must be under 50 MB."))
            XCTAssertEqual((error as? UploadError)?.errorDescription, "File too large. Images must be under 50 MB.")
        }
    }

    func testValidateRejectsOversizedVideo() {
        XCTAssertThrowsError(try UploadPlanner.validate(mimeType: "video/mp4", fileSize: 5 * gib)) { error in
            XCTAssertEqual(error as? UploadError, .tooLarge("Videos must be under 4GB."))
            XCTAssertEqual((error as? UploadError)?.errorDescription, "File too large. Videos must be under 4GB.")
        }
    }

    func testValidateRejectsEmptyFile() {
        XCTAssertThrowsError(try UploadPlanner.validate(mimeType: "image/jpeg", fileSize: 0)) { error in
            XCTAssertEqual(error as? UploadError, .emptyFile)
        }
    }

    // MARK: - Retry ladder

    func testRetryDelayIsCappedExponential() {
        XCTAssertEqual(UploadPlanner.retryDelay(afterAttempt: 1), 1, accuracy: 0.0001)
        XCTAssertEqual(UploadPlanner.retryDelay(afterAttempt: 2), 3, accuracy: 0.0001)
        XCTAssertEqual(UploadPlanner.retryDelay(afterAttempt: 3), 9, accuracy: 0.0001)
        XCTAssertEqual(UploadPlanner.retryDelay(afterAttempt: 4), 27, accuracy: 0.0001)
        XCTAssertEqual(UploadPlanner.retryDelay(afterAttempt: 5), 30, accuracy: 0.0001)
        XCTAssertEqual(UploadPlanner.retryDelay(afterAttempt: 6), 30, accuracy: 0.0001)
        // Defensive: a nonsensical attempt number never yields a zero/negative wait.
        XCTAssertEqual(UploadPlanner.retryDelay(afterAttempt: 0), 1, accuracy: 0.0001)
    }

    // MARK: - UploadError

    func testEveryUploadErrorHasAUserFacingDescription() {
        let cases: [UploadError] = [
            .fileUnreadable,
            .emptyFile,
            .unsupportedType("image/heic"),
            .unsupportedType("video/x-matroska"),
            .tooLarge("Images must be under 50 MB."),
            .partFailed(status: 503),
            .missingETag,
            .storageFull,
            .api("The server returned an invalid upload address."),
        ]
        for error in cases {
            let description = error.errorDescription ?? ""
            XCTAssertFalse(description.isEmpty, "\(error) has no errorDescription")
            // LocalizedError plumbing: localizedDescription must surface the same text.
            XCTAssertEqual(error.localizedDescription, description, "\(error)")
        }
        XCTAssertEqual(UploadError.storageFull.errorDescription, "Upload storage is full. Please try again later or contact support.")
        XCTAssertTrue(UploadError.partFailed(status: 503).errorDescription?.contains("503") == true)
    }
}
