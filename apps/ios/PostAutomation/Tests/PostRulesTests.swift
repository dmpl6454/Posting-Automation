import XCTest
@testable import PostAutomation

/// Post page rules (web-parity Phase 3, 2026-11-14), mirroring the web.
final class PostRulesTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom(TRPCClient.decodeDate)
        return d
    }

    private func target(_ extra: String = "", status: String = "FAILED", platform: String = "INSTAGRAM") -> PostTarget {
        let json = #"{"id":"t1","status":"\#(status)","publishedUrl":null,"errorMessage":"boom","publishedAt":null,"channel":{"id":"c1","platform":"\#(platform)","name":"Chan","isActive":true}\#(extra)}"#
        return try! decoder().decode(PostTarget.self, from: Data(json.utf8))
    }

    // MARK: decoding

    func testNewTargetFieldsDecode() {
        let t = target(#","publishedId":"9","ambiguousAt":"2026-11-14T10:00:00.000Z","ambiguousReason":"Unconfirmed","retryCount":2,"contentOverride":"own","format":"STORY","metadata":{"platformDelete":{"status":"failed","message":"nope"},"firstComment":{"status":"posted","posted":2,"total":2},"other":{"x":1}}"#)
        XCTAssertTrue(t.needsCheck)
        XCTAssertEqual(t.retryCount, 2)
        XCTAssertEqual(t.format, "STORY")
        XCTAssertEqual(t.metadata?.platformDelete?.status, "failed")
        XCTAssertEqual(t.metadata?.firstComment?.total, 2)
    }

    func testOddMetadataNeverBreaksDecoding() {
        let t = target(#","metadata":{"platformDelete":"garbage","firstComment":42},"retryCount":"x""#)
        XCTAssertNil(t.metadata?.platformDelete)
        XCTAssertNil(t.metadata?.firstComment)
        XCTAssertNil(t.retryCount)
    }

    // MARK: retry

    func testNeedsCheckIsNeverRetriedAndPublishAllExcludesIt() {
        let parked = target(#","ambiguousAt":"2026-11-14T10:00:00.000Z""#)
        let failed = target()
        let published = target(status: "PUBLISHED")
        XCTAssertFalse(PostRules.canRetry(parked))
        XCTAssertTrue(PostRules.canRetry(failed))
        XCTAssertFalse(PostRules.canRetry(published))
        let plan = PostRules.publishAllPlan([parked, failed, published])
        XCTAssertEqual(plan.eligible.count, 1)
        XCTAssertEqual(plan.parked, 1)
    }

    func testAllParkedSaysWhyInsteadOfDoingNothing() {
        XCTAssertEqual(PostRules.nothingToPublishMessage(parked: 3).title, "Nothing safe to publish yet")
        XCTAssertTrue(PostRules.nothingToPublishMessage(parked: 3).detail.contains("3 channels may already have this post published"))
        XCTAssertEqual(PostRules.nothingToPublishMessage(parked: 0).title, "No eligible channels")
    }

    // MARK: delete from platforms

    func testDeleteStates() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(PostRules.deleteState(target(status: "PUBLISHED"), now: now), .none, "no publishedId")
        XCTAssertEqual(PostRules.deleteState(target(#","publishedId":"9""#, status: "PUBLISHED", platform: "TWITTER"), now: now), .none)
        XCTAssertEqual(PostRules.deleteState(target(#","publishedId":"9""#, status: "PUBLISHED"), now: now), .eligible)
        let recent = TRPCClient.isoWithFraction.string(from: now.addingTimeInterval(-60))
        let stale = TRPCClient.isoWithFraction.string(from: now.addingTimeInterval(-3600))
        XCTAssertEqual(PostRules.deleteState(target(#","publishedId":"9","metadata":{"platformDelete":{"status":"queued","requestedAt":"\#(recent)"}}"#, status: "PUBLISHED"), now: now), .inProgress)
        XCTAssertEqual(PostRules.deleteState(target(#","publishedId":"9","metadata":{"platformDelete":{"status":"deleting","requestedAt":"\#(stale)"}}"#, status: "PUBLISHED"), now: now), .eligible, "a lost request can be retried")
        let deleted = PostRules.deleteState(target(#","publishedId":"9","platformDeletedAt":"2026-11-14T10:00:00.000Z""#, status: "PUBLISHED"), now: now)
        if case .deleted = deleted {} else { XCTFail("expected deleted") }
        XCTAssertFalse(PostRules.canRequestDelete(deleted))
        XCTAssertTrue(PostRules.canRequestDelete(.failed("x")))
    }

    func testDeleteRequestMessage() {
        let s = PostRules.DeleteRequestSummary(queued: 2, notPublished: 1, unsupported: 0, alreadyDeleted: 0, inProgress: 0, overLimit: 0)
        XCTAssertEqual(PostRules.deleteRequestMessage(s).title, "Deleting 2 posts from the platforms")
        XCTAssertTrue(PostRules.deleteRequestMessage(s).detail.hasSuffix("Skipped: 1 never published."))
        XCTAssertEqual(PostRules.deleteRequestMessage(.init(queued: 0, notPublished: 0, unsupported: 0, alreadyDeleted: 0, inProgress: 0, overLimit: 0)).title, "Nothing to delete")
    }

    // MARK: first comments

    func testFirstCommentLines() {
        typealias FC = TargetMetadata.FirstComment
        XCTAssertEqual(PostRules.firstCommentLine(FC(status: "posted"))?.text, "First comment posted.")
        XCTAssertEqual(PostRules.firstCommentLine(FC(status: "posted", posted: 3, total: 3))?.text, "All 3 first comments posted.")
        XCTAssertEqual(PostRules.firstCommentLine(FC(status: "posting"))?.text, "Posting the first comment…")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(PostRules.firstCommentLine(FC(status: "scheduled", dueAt: "2020-01-01T00:00:00.000Z"), now: now)?.text, "First comment will be posted any moment now.")
        XCTAssertTrue(PostRules.firstCommentLine(FC(status: "unconfirmed", posted: 1, total: 3))!.text.hasPrefix("1 of 3 first comments posted; the next one wasn't confirmed"))
        XCTAssertNil(PostRules.firstCommentLine(FC(status: "weird")))
        XCTAssertNil(PostRules.firstCommentLine(nil))
    }

    // MARK: edit

    private func post(scheduled: String? = nil, label: String? = nil) -> Post {
        let s = scheduled.map { "\"\($0)\"" } ?? "null"
        let l = label.map { "\"\($0)\"" } ?? "null"
        let json = #"{"id":"p1","content":"Hello","status":"SCHEDULED","scheduledAt":\#(s),"publishedAt":null,"archivedAt":null,"aiGenerated":false,"createdAt":"2026-11-14T10:00:00.000Z","updatedAt":"2026-11-14T10:00:00.000Z","targets":[],"campaignLabel":\#(l)}"#
        return try! decoder().decode(Post.self, from: Data(json.utf8))
    }

    private func encoded(_ u: UpdatePostInput) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: JSONEncoder().encode(u)) as! [String: Any]
    }

    func testEditSendsOnlyWhatChanged() {
        let p = post(scheduled: "2026-12-01T10:00:00.000Z", label: "Diwali")
        let same = encoded(PostRulesEdit.makeUpdate(post: p, content: "Hello", scheduled: true, scheduledAt: p.scheduledAt!, campaign: "Diwali"))
        XCTAssertEqual(Set(same.keys), ["id"])
    }

    func testEditClearsWithExplicitNull() {
        let p = post(scheduled: "2026-12-01T10:00:00.000Z", label: "Diwali")
        let body = encoded(PostRulesEdit.makeUpdate(post: p, content: "Hello", scheduled: false, scheduledAt: Date(), campaign: "  "))
        XCTAssertTrue(body["scheduledAt"] is NSNull, "turning the schedule off must send null, not omit it")
        XCTAssertTrue(body["campaignLabel"] is NSNull)
    }

    func testEditSetsNewValues() {
        let p = post()
        let when = Date(timeIntervalSince1970: 1_900_000_000)
        let body = encoded(PostRulesEdit.makeUpdate(post: p, content: "New", scheduled: true, scheduledAt: when, campaign: " Big  launch "))
        XCTAssertEqual(body["content"] as? String, "New")
        XCTAssertEqual(body["scheduledAt"] as? String, TRPCClient.isoWithFraction.string(from: when))
        XCTAssertEqual(body["campaignLabel"] as? String, "Big launch")
    }

    // MARK: calendar

    func testCalendarUsesScheduledThenPublishedThenCreated() {
        let p = post(scheduled: "2026-12-01T10:00:00.000Z")
        XCTAssertEqual(PostRules.calendarDate(p), p.scheduledAt)
        let unscheduled = post()
        XCTAssertEqual(PostRules.calendarDate(unscheduled), unscheduled.createdAt)
    }
}
