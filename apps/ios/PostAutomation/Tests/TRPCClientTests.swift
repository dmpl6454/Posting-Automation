import XCTest
@testable import PostAutomation

/// Pure decoding tests against the exact envelopes production returns.
/// These run with no network and no simulator UI — they guard the wire contract.
final class TRPCClientTests: XCTestCase {

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom(TRPCClient.decodeDate)
        return d
    }

    // Verbatim from GET https://postautomation.co.in/api/trpc/post.list (unauthenticated)
    func testDecodesUnauthorizedErrorEnvelope() {
        let body = #"{"error":{"json":{"message":"UNAUTHORIZED","code":-32001,"data":{"code":"UNAUTHORIZED","httpStatus":401,"path":"post.list","zodError":null}}}}"#
        do {
            let _: PostListPage = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 401, decoder: decoder)
            XCTFail("Expected an error")
        } catch let e as APIError {
            XCTAssertTrue(e.isUnauthorized)
            if case .trpc(let p) = e {
                XCTAssertEqual(p.code, "UNAUTHORIZED")
                XCTAssertEqual(p.data?.path, "post.list")
            } else { XCTFail("Expected .trpc error, got \(e)") }
        } catch { XCTFail("Unexpected error type: \(error)") }
    }

    func testDecodesSuccessEnvelopeWithDates() throws {
        let body = #"""
        {"result":{"data":{"json":{"posts":[{"id":"p1","content":"hello","status":"PUBLISHED","scheduledAt":null,"publishedAt":"2026-08-19T13:01:00.000Z","archivedAt":null,"aiGenerated":true,"createdAt":"2026-08-19T12:00:00.000Z","updatedAt":"2026-08-19T13:01:05.123Z","targets":[{"id":"t1","status":"PUBLISHED","publishedUrl":"https://www.facebook.com/1_2","errorMessage":null,"publishedAt":"2026-08-19T13:01:00.000Z","channel":{"id":"c1","platform":"FACEBOOK","name":"Digital Sukoon","username":null,"avatar":null,"isActive":true,"tokenExpiresAt":null,"createdAt":"2026-01-01T00:00:00.000Z","insightsHealth":{"status":"ok"}}}]}],"nextCursor":null},"meta":{"values":{"posts.0.publishedAt":["Date"]}}}}}
        """#
        let page: PostListPage = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 200, decoder: decoder)
        XCTAssertEqual(page.posts.count, 1)
        XCTAssertNil(page.nextCursor)
        let post = page.posts[0]
        XCTAssertEqual(post.status, .PUBLISHED)
        XCTAssertTrue(post.aiGenerated)
        XCTAssertEqual(post.targets.first?.channel.platform.raw, "FACEBOOK")
        XCTAssertEqual(post.targets.first?.channel.platform.displayName, "Facebook")
        XCTAssertEqual(post.targets.first?.publishedURL?.host, "www.facebook.com")
        // Fractional-second ISO date parsed correctly:
        // 2026-08-19T13:01:00Z = 1767225600 (2026-01-01) + 230 days + 13h01m = 1787144460
        let publishedAt = try XCTUnwrap(post.publishedAt)
        XCTAssertEqual(publishedAt.timeIntervalSince1970, 1787144460, accuracy: 1)
    }

    func testUnknownPlatformStillDecodes() throws {
        // A platform added server-side must not make channel.list undecodable.
        let body = #"{"result":{"data":{"json":[{"id":"c9","platform":"SOMETHING_NEW","name":"Future","username":"fut","avatar":null,"isActive":true,"tokenExpiresAt":null,"createdAt":"2026-01-01T00:00:00Z"}]}}}"#
        let channels: [Channel] = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 200, decoder: decoder)
        XCTAssertEqual(channels.first?.platform.displayName, "Something New")
        XCTAssertEqual(channels.first?.handle, "@fut")
    }

    func testNonJSONErrorBecomesHTTPError() {
        // nginx's HTML 429 page — this is exactly the "Unexpected token '<'" class
        // of failure the web client used to leak into toasts.
        let body = "<html><head><title>429 Too Many Requests</title></head></html>"
        do {
            let _: DashboardStats = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 429, decoder: decoder)
            XCTFail("Expected an error")
        } catch let e as APIError {
            if case .http(let status, _) = e { XCTAssertEqual(status, 429) } else { XCTFail("Expected .http, got \(e)") }
            XCTAssertEqual(e.errorDescription, "Too many requests — please wait a moment and try again.")
        } catch { XCTFail("Unexpected error type: \(error)") }
    }

    func testDashboardStatsDecodes() throws {
        let body = #"{"result":{"data":{"json":{"totalPosts":105,"connectedChannels":39,"published":90,"aiGenerated":12,"trends":{"totalPosts":[1,2,3,4,5,6],"published":[0,1,1,2,3,3],"aiGenerated":[0,0,0,1,1,1],"connectedChannels":[39,39,39,39,39,39]}}}}}"#
        let stats: DashboardStats = try TRPCClient.decodeResponse(data: Data(body.utf8), status: 200, decoder: decoder)
        XCTAssertEqual(stats.totalPosts, 105)
        XCTAssertEqual(stats.trends.published.count, 6)
    }

    func testDateDecoderAcceptsPlainISO() throws {
        struct Box: Decodable { let d: Date }
        let box = try decoder.decode(Box.self, from: Data(#"{"d":"2026-01-01T00:00:00Z"}"#.utf8))
        XCTAssertEqual(box.d.timeIntervalSince1970, 1767225600, accuracy: 1)
    }
}
