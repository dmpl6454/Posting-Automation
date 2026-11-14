import XCTest
@testable import PostAutomation

/// Inbox rules (web-parity Phase 5, 2026-11-14) — same decisions as the web.
final class InboxRulesTests: XCTestCase {
    private func comment(_ json: String) -> SocialComment {
        let d = JSONDecoder()
        return try! d.decode(SocialComment.self, from: Data(json.utf8))
    }

    private func trpcError(code: String, status: Int, message: String) -> APIError {
        .trpc(TRPCErrorPayload(message: message, data: .init(code: code, httpStatus: status, path: "comment.reply")))
    }

    // MARK: classify — an unknown outcome must never read as a plain failure

    func testMayAlreadyBePostedIsUnconfirmed() {
        XCTAssertEqual(InboxRules.classify(trpcError(code: "BAD_REQUEST", status: 400, message: "Facebook accepted the reply but did not confirm it. … it may already be posted.")), .unconfirmed)
        XCTAssertEqual(InboxRules.classify(trpcError(code: "BAD_REQUEST", status: 400, message: "Instagram didn't confirm that message. It may already have been sent — refresh the conversation before sending again.")), .unconfirmed)
    }

    func testNoStructuredAnswerIsUnconfirmed() {
        XCTAssertEqual(InboxRules.classify(URLError(.timedOut)), .unconfirmed)
        XCTAssertEqual(InboxRules.classify(APIError.http(status: 502, body: "<html>")), .unconfirmed)
        XCTAssertEqual(InboxRules.classify(trpcError(code: "INTERNAL_SERVER_ERROR", status: 500, message: "x")), .unconfirmed)
    }

    func testRefusalsAreRefused() {
        XCTAssertEqual(InboxRules.classify(trpcError(code: "TOO_MANY_REQUESTS", status: 429, message: "slow down")), .refused)
        XCTAssertEqual(InboxRules.classify(APIError.http(status: 429, body: "")), .refused)
        XCTAssertEqual(InboxRules.classify(trpcError(code: "BAD_REQUEST", status: 400, message: "Reply cannot be empty.")), .refused)
    }

    // MARK: moderation patch

    private var thread: [SocialComment] {
        [comment(#"{"id":"1","text":"hi","likeCount":2,"likedByAccount":false,"replyCount":2,"replies":[{"id":"1a","text":"r1","likeCount":0},{"id":"1b","text":"r2","likeCount":5}]}"#)]
    }

    func testDeleteReplyDropsItAndTheCount() {
        let out = InboxRules.apply(thread, id: "1a", action: .delete)
        XCTAssertEqual(out[0].replies.map(\.id), ["1b"])
        XCTAssertEqual(out[0].replyCount, 1)
        XCTAssertTrue(InboxRules.apply(thread, id: "1", action: .delete).isEmpty)
    }

    func testFacebookLikeIsPlusOneOnceInstagramUsesTheServerCount() {
        let fb = InboxRules.apply(thread, id: "1", action: .like)            // no key ⇒ ±1
        XCTAssertEqual(fb[0].likeCount, 3)
        XCTAssertEqual(InboxRules.apply(fb, id: "1", action: .like)[0].likeCount, 3, "liking twice doesn't add twice")
        let ig = InboxRules.apply(thread, id: "1", action: .like, likeCount: .some(9))
        XCTAssertEqual(ig[0].likeCount, 9)
        let igUnknown = InboxRules.apply(thread, id: "1", action: .like, likeCount: .some(nil))
        XCTAssertEqual(igUnknown[0].likeCount, 2, "a failed re-read leaves the count alone")
        XCTAssertEqual(igUnknown[0].likedByAccount, true)
    }

    func testHideAndEdit() {
        XCTAssertTrue(InboxRules.apply(thread, id: "1b", action: .hide)[0].replies[1].hidden)
        XCTAssertEqual(InboxRules.apply(thread, id: "1", action: .edit, message: "new")[0].text, "new")
    }

    // MARK: display

    func testGraphDatesParse() {
        XCTAssertNotNil(InboxRules.graphDate("2026-09-19T10:00:00+0000"))
        XCTAssertNotNil(InboxRules.graphDate("2026-09-19T10:00:00.000Z"))
        XCTAssertNil(InboxRules.graphDate(""))
        let now = InboxRules.graphDate("2026-09-19T10:00:00+0000")!
        XCTAssertEqual(InboxRules.relative("2026-09-19T11:00:00+0000", now: now), "just now", "future times read as just now")
    }

    func testAuthorNames() {
        let own = comment(#"{"id":"x","isOwn":true}"#)
        XCTAssertEqual(InboxRules.authorName(own, accountName: "My Page", namesHidden: nil), "My Page")
        let ig = comment(#"{"id":"x","author":{"username":"alice"}}"#)
        XCTAssertEqual(InboxRules.authorName(ig, accountName: nil, namesHidden: nil), "@alice")
        let hidden = comment(#"{"id":"x","author":{}}"#)
        XCTAssertEqual(InboxRules.authorName(hidden, accountName: nil, namesHidden: true), "Instagram user (name hidden)")
    }

    func testWriteBlockedOnlyWhenKnownAndRefused() {
        XCTAssertNil(InboxRules.writeBlockedReason(CommentCapabilities(), platform: "FACEBOOK"), "unknown ⇒ never guess")
        XCTAssertNil(InboxRules.writeBlockedReason(CommentCapabilities(known: true, canReply: true), platform: "FACEBOOK"))
        let r = InboxRules.writeBlockedReason(CommentCapabilities(known: true, canReply: false, missing: ["pages_manage_engagement"]), platform: "FACEBOOK")
        XCTAssertTrue(r!.contains("pages_manage_engagement"))
    }

    func testModerateResultKnowsWhetherACountWasSent() {
        let d = JSONDecoder()
        let fb = try! d.decode(ModerateResult.self, from: Data(#"{"ok":true,"action":"like","platform":"FACEBOOK"}"#.utf8))
        XCTAssertFalse(fb.likeCountSent)
        let ig = try! d.decode(ModerateResult.self, from: Data(#"{"ok":true,"likeCount":null}"#.utf8))
        XCTAssertTrue(ig.likeCountSent)
        XCTAssertNil(ig.likeCount)
    }
}
