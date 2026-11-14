import XCTest
@testable import PostAutomation

final class AdminRulesTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as: T.Type) throws -> T {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try d.decode(T.self, from: Data(json.utf8))
    }

    func testQueueRowsSortBusiestFirstAndFlagUnreadable() throws {
        let raw = try decode(#"""
        {"POST_PUBLISH":{"waiting":2,"prioritized":3,"active":1,"delayed":40,"failed":0},
         "MEDIA_OPTIMIZE":{"waiting":0,"active":0,"delayed":0,"failed":7},
         "BROKEN":{"error":"Failed to get job counts"}}
        """#, as: [String: JSONValue].self)
        let rows = AdminRules.queueRows(raw)
        XCTAssertEqual(rows.map(\.name), ["MEDIA_OPTIMIZE", "POST_PUBLISH", "BROKEN"])
        XCTAssertEqual(rows[1].waiting, 5, "prioritized jobs are waiting too")
        XCTAssertTrue(rows[2].unreadable)
    }

    func testCannotBanOrDemoteYourself() throws {
        let me = try decode(#"{"id":"u1","email":"a@b.c","isSuperAdmin":true,"isBanned":false}"#, as: AdminUser.self)
        let other = try decode(#"{"id":"u2","email":"x@y.z","isSuperAdmin":false,"isBanned":true,"appRole":"USER"}"#, as: AdminUser.self)
        XCTAssertFalse(AdminRules.canToggleBan(target: me, me: "u1"))
        XCTAssertFalse(AdminRules.canToggleSuperAdmin(target: me, me: "u1"))
        XCTAssertTrue(AdminRules.canToggleBan(target: other, me: "u1"))
        XCTAssertFalse(AdminRules.appRoleEditable(me), "appRole is moot for a super admin")
        XCTAssertTrue(AdminRules.appRoleEditable(other))
    }

    func testFailedJobNumericIdAndQueueFallback() throws {
        let j = try decode(#"{"id":1576349,"queue":"POST_PUBLISH","queueName":"post-publish","failedReason":"boom","timestamp":1700000000000}"#, as: FailedJob.self)
        XCTAssertEqual(j.jobId, "1576349")
        XCTAssertEqual(j.queueName, "post-publish")
        XCTAssertNotNil(AdminRules.retryWarning(queueName: j.queueName))
        XCTAssertNil(AdminRules.retryWarning(queueName: "media-optimize"))
    }

    func testAdminUserListDecodesLeniently() throws {
        let p = try decode(#"{"items":[{"id":"u","name":null,"email":"e@x.io","isSuperAdmin":false,"appRole":"ADMIN","isBanned":false,"createdAt":"2026-01-01T00:00:00Z","_count":{"memberships":2}}],"nextCursor":"u"}"#, as: AdminPage<AdminUser>.self)
        XCTAssertEqual(p.items.first?.display, "e@x.io")
        XCTAssertEqual(p.items.first?._count?.memberships, 2)
    }
}
