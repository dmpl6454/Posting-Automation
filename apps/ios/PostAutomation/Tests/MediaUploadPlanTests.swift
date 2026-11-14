import XCTest
@testable import PostAutomation

/// Photo/video posting (2026-11-14): the pure parts of the multipart upload.
final class MediaUploadPlanTests: XCTestCase {
    func testPartsCoverTheFileWithTheRemainderLast() {
        let mb: Int64 = 1024 * 1024
        let parts = MediaUploadPlan.parts(fileSize: 20 * mb)
        XCTAssertEqual(parts.map(\.number), [1, 2, 3])
        XCTAssertEqual(parts.map(\.length), [8 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024])
        XCTAssertEqual(parts.map(\.offset), [0, 8 * mb, 16 * mb])
    }

    func testSmallFileIsOnePartAndEmptyFileIsNone() {
        XCTAssertEqual(MediaUploadPlan.parts(fileSize: 1234), [.init(number: 1, offset: 0, length: 1234)])
        XCTAssertEqual(MediaUploadPlan.parts(fileSize: 0), [])
    }

    func testExactMultipleHasNoEmptyTrailingPart() {
        let parts = MediaUploadPlan.parts(fileSize: 16 * 1024 * 1024)
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts.last?.length, 8 * 1024 * 1024)
    }

    func testMimeTypesMatchWhatTheServerAccepts() {
        XCTAssertEqual(MediaUploadPlan.mimeType(forExtension: "JPG"), "image/jpeg")
        XCTAssertEqual(MediaUploadPlan.mimeType(forExtension: "mov"), "video/quicktime")
        XCTAssertEqual(MediaUploadPlan.mimeType(forExtension: "m4v"), "video/mp4")
        XCTAssertEqual(MediaUploadPlan.mimeType(forExtension: "mp4"), "video/mp4")
        // HEIC is converted to JPEG before upload; anything else is refused up front.
        XCTAssertNil(MediaUploadPlan.mimeType(forExtension: "heic"))
        XCTAssertNil(MediaUploadPlan.mimeType(forExtension: "mkv"))
    }

    func testSizeLimitsMatchTheServer() {
        XCTAssertEqual(MediaUploadPlan.sizeProblem(bytes: 0, mimeType: "image/jpeg"), .emptyFile)
        XCTAssertEqual(MediaUploadPlan.sizeProblem(bytes: 51 * 1024 * 1024, mimeType: "image/jpeg"), .tooLarge(isVideo: false))
        XCTAssertNil(MediaUploadPlan.sizeProblem(bytes: 51 * 1024 * 1024, mimeType: "video/mp4"))
        XCTAssertEqual(MediaUploadPlan.sizeProblem(bytes: 5 * 1024 * 1024 * 1024, mimeType: "video/mp4"), .tooLarge(isVideo: true))
    }

    func testRetryDelaysGrowAndCap() {
        XCTAssertEqual(MediaUploadPlan.retryDelay(attempt: 1), 1)
        XCTAssertEqual(MediaUploadPlan.retryDelay(attempt: 2), 3)
        XCTAssertEqual(MediaUploadPlan.retryDelay(attempt: 3), 9)
        XCTAssertEqual(MediaUploadPlan.retryDelay(attempt: 10), 30)
    }

    func testCreatePostInputSendsMediaIdsOnlyWhenPresent() throws {
        let without = String(decoding: try JSONEncoder().encode(CreatePostInput(content: "a", channelIds: [], scheduledAt: nil)), as: UTF8.self)
        XCTAssertFalse(without.contains("mediaIds"))
        let with = String(decoding: try JSONEncoder().encode(CreatePostInput(content: "a", channelIds: [], scheduledAt: nil, mediaIds: ["m1", "m2"])), as: UTF8.self)
        XCTAssertTrue(with.contains("\"mediaIds\":[\"m1\",\"m2\"]"))
    }
}
