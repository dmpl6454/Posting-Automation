import XCTest
@testable import PostAutomation

/// Pure tests for the in-app notifications: the `notification.list` wire shape
/// (an envelope built from the Prisma `Notification` model, exactly as the
/// router returns it), the post deep-link parser, the icon map, and the
/// same-site rule for links handed to Safari. No network, no UI.
final class NotificationTests: XCTestCase {

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom(TRPCClient.decodeDate)
        return d
    }

    private func make(type: String = "post.published", link: String? = "/dashboard/posts/abc", isRead: Bool = false) -> AppNotification {
        AppNotification(id: "n1", type: type, title: "Post published", body: "Published to INSTAGRAM",
                        link: link, isRead: isRead, createdAt: Date(timeIntervalSince1970: 1_787_144_465))
    }

    // MARK: - notification.list envelope

    /// The row carries `metadata` (Json), `organizationId` and `userId`, none of
    /// which the app declares — `Decodable` must ignore them, which is what keeps
    /// an installed build safe against additive server changes.
    func testDecodesNotificationListEnvelope() throws {
        let body = #"""
        {"result":{"data":{"json":{"notifications":[{"id":"n1","organizationId":"org1","userId":"u1","type":"post.published","title":"Post published","body":"Published to INSTAGRAM","link":"/dashboard/posts/abc","isRead":false,"metadata":{"postId":"abc","postTargetId":"t1","platform":"INSTAGRAM"},"createdAt":"2026-08-19T13:01:05.123Z"},{"id":"n2","organizationId":"org1","userId":"u1","type":"approval.requested","title":"Approval Requested","body":"You have been asked to review a post for approval.","link":"/dashboard/approvals","isRead":true,"metadata":null,"createdAt":"2026-08-19T12:00:00.000Z"},{"id":"n3","organizationId":"org1","userId":"u1","type":"post.captions_held","title":"Captions on hold","body":"Per-channel captions could not be generated. The post was NOT published.","link":null,"isRead":true,"metadata":null,"createdAt":"2026-08-18T09:30:00.000Z"}],"nextCursor":"n3"},"meta":{"values":{"notifications.0.createdAt":["Date"],"notifications.1.createdAt":["Date"],"notifications.2.createdAt":["Date"]}}}}}
        """#
        let page: NotificationListPage = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 200, decoder: decoder)
        XCTAssertEqual(page.notifications.count, 3)
        XCTAssertEqual(page.nextCursor, "n3")

        let published = page.notifications[0]
        XCTAssertEqual(published.id, "n1")
        XCTAssertEqual(published.type, "post.published")
        XCTAssertEqual(published.title, "Post published")
        XCTAssertEqual(published.body, "Published to INSTAGRAM")
        XCTAssertEqual(published.link, "/dashboard/posts/abc")
        XCTAssertFalse(published.isRead)
        XCTAssertEqual(published.linkedPostId, "abc")
        // 2026-08-19T13:01:00Z = 1787144460 (see TRPCClientTests); the fractional
        // seconds superjson emits must survive the decode too.
        XCTAssertEqual(published.createdAt.timeIntervalSince1970, 1_787_144_465.123, accuracy: 0.01)

        let approval = page.notifications[1]
        XCTAssertEqual(approval.type, "approval.requested")
        XCTAssertTrue(approval.isRead)
        XCTAssertEqual(approval.link, "/dashboard/approvals")
        XCTAssertNil(approval.linkedPostId)
        XCTAssertEqual(approval.createdAt.timeIntervalSince1970, 1_787_140_800, accuracy: 1)

        let held = page.notifications[2]
        XCTAssertNil(held.link)
        XCTAssertNil(held.linkedPostId)
        XCTAssertTrue(held.isRead)
        XCTAssertEqual(held.createdAt.timeIntervalSince1970, 1_787_045_400, accuracy: 1)
    }

    func testLastPageHasNoCursor() throws {
        let body = #"{"result":{"data":{"json":{"notifications":[],"nextCursor":null}}}}"#
        let page: NotificationListPage = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 200, decoder: decoder)
        XCTAssertTrue(page.notifications.isEmpty)
        XCTAssertNil(page.nextCursor)
    }

    // Verbatim shape of the error the router returns without a session.
    func testUnauthorizedListIsUnauthorized() {
        let body = #"{"error":{"json":{"message":"UNAUTHORIZED","code":-32001,"data":{"code":"UNAUTHORIZED","httpStatus":401,"path":"notification.list","zodError":null}}}}"#
        do {
            let _: NotificationListPage = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 401, decoder: decoder)
            XCTFail("Expected an error")
        } catch let e as APIError {
            XCTAssertTrue(e.isUnauthorized)
        } catch { XCTFail("Unexpected error type: \(error)") }
    }

    /// zod's `cursor: z.string().optional()` rejects an explicit null, so the
    /// key must be OMITTED (synthesized `Encodable` → `encodeIfPresent`), and the
    /// default page size the view relies on is 30.
    func testListInputOmitsAbsentCursor() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let firstPage = try encoder.encode(NotificationListInput())
        XCTAssertEqual(String(decoding: firstPage, as: UTF8.self), #"{"limit":30}"#)
        let nextPage = try encoder.encode(NotificationListInput(limit: 30, cursor: "n3"))
        XCTAssertEqual(String(decoding: nextPage, as: UTF8.self), #"{"cursor":"n3","limit":30}"#)
    }

    // MARK: - unreadCount

    func testUnreadCountDecodes() throws {
        let body = #"{"result":{"data":{"json":{"count":4}}}}"#
        let result: UnreadCountResult = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 200, decoder: decoder)
        XCTAssertEqual(result.count, 4)
    }

    // MARK: - linkedPostId

    func testLinkedPostIdParsesPublishLinks() {
        XCTAssertEqual(make(link: "/dashboard/posts/abc").linkedPostId, "abc")
        XCTAssertEqual(make(link: "/dashboard/posts/abc?tab=x").linkedPostId, "abc")
        XCTAssertEqual(make(link: "/dashboard/posts/cmsrxo9tq0003nq0itqw1nuw9").linkedPostId, "cmsrxo9tq0003nq0itqw1nuw9")
    }

    func testLinkedPostIdIsNilForEverythingElse() {
        XCTAssertNil(make(link: "/dashboard/approvals").linkedPostId)
        XCTAssertNil(make(link: "/dashboard/posts").linkedPostId)
        XCTAssertNil(make(link: "/dashboard/posts/").linkedPostId)
        XCTAssertNil(make(link: nil).linkedPostId)
        XCTAssertNil(make(link: "").linkedPostId)
    }

    // MARK: - Icon / tint map

    func testSystemImageByType() {
        XCTAssertEqual(make(type: "post.published").systemImage, "checkmark.circle.fill")
        XCTAssertEqual(make(type: "post.failed").systemImage, "exclamationmark.triangle.fill")
        XCTAssertEqual(make(type: "approval.requested").systemImage, "person.crop.circle.badge.checkmark")
        // A producer added server-side must still render — with the generic bell.
        XCTAssertEqual(make(type: "something.new").systemImage, "bell.fill")
    }

    func testTintByType() {
        XCTAssertEqual(make(type: "post.published").tint, .green)
        XCTAssertEqual(make(type: "post.failed").tint, .red)
        XCTAssertEqual(make(type: "post.captions_held").tint, .orange)
        XCTAssertEqual(make(type: "something.new").tint, .accentColor)
    }

    // MARK: - Same-site links handed to Safari

    func testWebURLResolvesSameSitePathsOnly() {
        let base = URL(string: "https://postautomation.co.in")!
        XCTAssertEqual(
            NotificationLinkResolver.webURL(for: "/dashboard/approvals", base: base)?.absoluteString,
            "https://postautomation.co.in/dashboard/approvals"
        )
        XCTAssertEqual(
            NotificationLinkResolver.webURL(for: "/dashboard/posts?status=FAILED", base: base)?.absoluteString,
            "https://postautomation.co.in/dashboard/posts?status=FAILED"
        )
        XCTAssertNil(NotificationLinkResolver.webURL(for: nil, base: base))
        XCTAssertNil(NotificationLinkResolver.webURL(for: "", base: base))
        XCTAssertNil(NotificationLinkResolver.webURL(for: "dashboard/approvals", base: base))
        // Never an absolute or protocol-relative URL from the server.
        XCTAssertNil(NotificationLinkResolver.webURL(for: "https://evil.example/dashboard", base: base))
        XCTAssertNil(NotificationLinkResolver.webURL(for: "//evil.example/dashboard", base: base))
        XCTAssertNil(NotificationLinkResolver.webURL(for: "javascript:alert(1)", base: base))
    }

    func testWebURLDefaultsToTheAPIHost() {
        let url = NotificationLinkResolver.webURL(for: "/dashboard/approvals")
        XCTAssertEqual(url?.host, APIConfig.baseURL.host)
        XCTAssertEqual(url?.path, "/dashboard/approvals")
    }
}
