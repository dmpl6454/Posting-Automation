import XCTest
@testable import PostAutomation
import SwiftUI

final class LibraryRulesTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as: T.Type) throws -> T {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try d.decode(T.self, from: Data(json.utf8))
    }

    func testMediaItemBigIntSizeAsString() throws {
        let m = try decode(#"{"id":"m1","fileName":"a.mov","fileType":"video/quicktime","fileSize":"3221225472","url":"https://x/a.mov"}"#, as: MediaItem.self)
        XCTAssertEqual(m.fileSize, 3_221_225_472)
        XCTAssertTrue(m.isVideo)
        XCTAssertEqual(m.playbackURL?.absoluteString, "https://x/a.mov")
    }

    func testMediaItemSizeAsNumberAndOptimizedRendition() throws {
        let m = try decode(#"{"id":"m1","fileName":"a.mp4","fileType":"video/mp4","fileSize":1024,"url":"https://x/a.mp4","metadata":{"optimize":{"status":"done","url":"https://x/opt.mp4"}}}"#, as: MediaItem.self)
        XCTAssertEqual(m.fileSize, 1024)
        XCTAssertEqual(m.playbackURL?.absoluteString, "https://x/opt.mp4")
    }

    func testPendingOptimizeIsIgnored() throws {
        let m = try decode(#"{"id":"m1","fileName":"a.mp4","fileType":"video/mp4","url":"https://x/a.mp4","metadata":{"optimize":{"status":"pending"}}}"#, as: MediaItem.self)
        XCTAssertNil(m.optimizedUrl)
        XCTAssertNil(m.fileSize)
    }

    func testPostIdFromLink() {
        XCTAssertEqual(LibraryRules.postId(fromLink: "/dashboard/posts/cmabc123xyz"), "cmabc123xyz")
        XCTAssertEqual(LibraryRules.postId(fromLink: "https://postautomation.co.in/dashboard/posts/cmabc123xyz?tab=1"), "cmabc123xyz")
        XCTAssertNil(LibraryRules.postId(fromLink: "/dashboard/posts/new"))
        XCTAssertNil(LibraryRules.postId(fromLink: "/dashboard/posts"))
        XCTAssertNil(LibraryRules.postId(fromLink: "/dashboard/channels"))
        XCTAssertNil(LibraryRules.postId(fromLink: nil))
    }

    func testGroupDiff() {
        let d = LibraryRules.groupDiff(current: ["a", "b", "c"], wanted: ["b", "c", "d", "e"])
        XCTAssertEqual(d.add, ["d", "e"])
        XCTAssertEqual(d.remove, ["a"])
        let none = LibraryRules.groupDiff(current: ["a"], wanted: ["a"])
        XCTAssertTrue(none.add.isEmpty && none.remove.isEmpty)
    }

    func testSelectableMembersSkipsPausedAndUnknown() throws {
        let g = try decode(#"{"id":"g","name":"G","channels":[{"id":"a","name":"A","platform":"INSTAGRAM","isActive":true},{"id":"b","name":"B","platform":"FACEBOOK","isActive":false},{"id":"c","name":"C","platform":"FACEBOOK"},{"id":"gone","name":"X","platform":"FACEBOOK","isActive":true}]}"#, as: ChannelGroup.self)
        XCTAssertEqual(LibraryRules.selectableMembers(g, available: ["a", "b", "c"]), ["a", "c"])
    }

    func testChunked() {
        XCTAssertEqual(Array(1...5).chunked(2), [[1, 2], [3, 4], [5]])
        XCTAssertEqual([Int]().chunked(500), [])
    }

    func testColorHex() {
        XCTAssertNotNil(Color(hex: "#6366f1"))
        XCTAssertNil(Color(hex: "red"))
        XCTAssertNil(Color(hex: nil))
    }

    func testActiveOrganizationRemembersOnlyAMembership() throws {
        let ms = try decode(#"[{"role":"OWNER","organization":{"id":"o1","name":"Mine"}},{"role":"MEMBER","organization":{"id":"o2","name":"Team"}}]"#, as: [Membership].self)
        XCTAssertEqual(LibraryRules.activeOrganization(remembered: "o2", memberships: ms)?.id, "o2")
        // A workspace the user has left falls back to the server default.
        XCTAssertEqual(LibraryRules.activeOrganization(remembered: "gone", memberships: ms)?.id, "o1")
        XCTAssertEqual(LibraryRules.activeOrganization(remembered: nil, memberships: ms)?.id, "o1")
        XCTAssertNil(LibraryRules.activeOrganization(remembered: "o1", memberships: []))
    }
}
