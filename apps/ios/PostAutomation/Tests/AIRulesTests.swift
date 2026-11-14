import XCTest
@testable import PostAutomation

final class AIRulesTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as: T.Type) throws -> T {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try d.decode(T.self, from: Data(json.utf8))
    }

    // MARK: SSE

    func testParsesStreamEvents() {
        XCTAssertEqual(ChatStreamEvent.parse(line: #"data: {"type":"chunk","content":"Hel"}"#), .chunk("Hel"))
        XCTAssertEqual(ChatStreamEvent.parse(line: #"data: {"type":"error","message":"boom"}"#), .error("boom"))
        let done = ChatStreamEvent.parse(line: #"data: {"type":"done","displayText":"Hi","action":{"type":"schedule_post","payload":{"content":"x","channelIds":["c1"]},"idempotencyKey":"k1"},"provider":"anthropic"}"#)
        guard case .done(let text, let action) = done else { return XCTFail("not done") }
        XCTAssertEqual(text, "Hi")
        XCTAssertEqual(action?.idempotencyKey, "k1")
        XCTAssertEqual(action?.payload["channelIds"], .array([.string("c1")]))
    }

    func testIgnoresNonEventLines() {
        XCTAssertNil(ChatStreamEvent.parse(line: ""))
        XCTAssertNil(ChatStreamEvent.parse(line: ": keepalive"))
        XCTAssertNil(ChatStreamEvent.parse(line: "data: not json"))
        XCTAssertNil(ChatStreamEvent.parse(line: #"data: {"type":"other"}"#))
    }

    // MARK: Action locking

    func testActionKeyAndPersistedMarkers() throws {
        let msgs = try decode(#"""
        [{"id":"m1","role":"assistant","content":"Ready","metadata":{"action":{"type":"publish_now","payload":{"content":"x"},"idempotencyKey":"key-1"}}},
         {"id":"m2","role":"assistant","content":"Published","metadata":{"type":"post_published","executedActionId":"key-1"}},
         {"id":"m3","role":"assistant","content":"Legacy","metadata":{"action":{"type":"schedule_post","payload":{}}}},
         {"id":"m4","role":"user","content":"hi","metadata":null}]
        """#, as: [ChatMessageDTO].self)
        XCTAssertEqual(AIRules.actionKey(msgs[0]), "key-1")
        XCTAssertEqual(AIRules.actionKey(msgs[2]), "m3", "legacy actions fall back to the message id")
        XCTAssertEqual(AIRules.executedKeys(msgs), ["key-1"])
    }

    func testPostActionsCarryThreadMedia() {
        let post = ChatAction(type: "schedule_post", payload: ["content": .string("x")], idempotencyKey: nil)
        XCTAssertEqual(AIRules.payloadWithMedia(post, mediaIds: ["a", "b"])["mediaIds"], .array([.string("a"), .string("b")]))
        // The agent's own mediaIds win; non-post actions are untouched.
        let own = ChatAction(type: "publish_now", payload: ["mediaIds": .array([.string("z")])], idempotencyKey: nil)
        XCTAssertEqual(AIRules.payloadWithMedia(own, mediaIds: ["a"])["mediaIds"], .array([.string("z")]))
        let agent = ChatAction(type: "create_agent", payload: [:], idempotencyKey: nil)
        XCTAssertNil(AIRules.payloadWithMedia(agent, mediaIds: ["a"])["mediaIds"])
    }

    func testJSONValueRoundTrip() throws {
        let raw = #"{"a":1.5,"b":true,"c":null,"d":["x",{"e":"f"}]}"#
        let v = try decode(raw, as: JSONValue.self)
        let again = try decode(String(decoding: try JSONEncoder().encode(v), as: UTF8.self), as: JSONValue.self)
        XCTAssertEqual(v, again)
        XCTAssertEqual(v["d"], .array([.string("x"), .object(["e": .string("f")])]))
    }

    // MARK: Repurpose

    private let staticResult = #"""
    {"platformContent":{"INSTAGRAM":"IG caption","FACEBOOK":"FB caption"},"mediaUrls":["https://x/1.png"],
     "mediaMap":{"INSTAGRAM":{"url":"https://x/1.png","mediaId":"m1"},"FACEBOOK":{"url":"https://x/1.png","mediaId":"m1"}},
     "carouselMediaIds":[],"format":"static","mediaFailed":false}
    """#

    func testStaticMediaIsDeduped() throws {
        let r = try decode(staticResult, as: RepurposeResult.self)
        XCTAssertEqual(AIRules.repurposeMediaIds(r), ["m1"])
    }

    func testCarouselKeepsSlideOrder() throws {
        let r = try decode(#"{"platformContent":{"INSTAGRAM":"c"},"mediaUrls":[],"mediaMap":{"INSTAGRAM":{"url":"u","mediaId":"cover"}},"carouselMediaIds":["s3","s1","s2"],"format":"carousel"}"#, as: RepurposeResult.self)
        XCTAssertEqual(AIRules.repurposeMediaIds(r), ["s3", "s1", "s2"])
    }

    func testMediaLessDraftBlockedOnlyForInstagramFacebook() {
        XCTAssertNotNil(AIRules.mediaLessBlock(mediaIds: [], selectedPlatforms: ["LINKEDIN", "INSTAGRAM"]))
        XCTAssertNil(AIRules.mediaLessBlock(mediaIds: [], selectedPlatforms: ["LINKEDIN", "TWITTER"]))
        XCTAssertNil(AIRules.mediaLessBlock(mediaIds: ["m"], selectedPlatforms: ["FACEBOOK"]))
    }

    func testDraftInputUsesFirstChannelsCaptionAndAllVariants() throws {
        let r = try decode(staticResult, as: RepurposeResult.self)
        let chans = try decode(#"[{"id":"c-fb","platform":"FACEBOOK","name":"Page","isActive":true},{"id":"c-ig","platform":"INSTAGRAM","name":"IG","isActive":true}]"#, as: [Channel].self)
        let input = AIRules.draftInput(r, channels: chans)
        XCTAssertEqual(input.content, "FB caption")
        XCTAssertEqual(input.contentVariants, ["INSTAGRAM": "IG caption", "FACEBOOK": "FB caption"])
        XCTAssertEqual(input.channelIds, ["c-fb", "c-ig"])
        XCTAssertEqual(input.mediaIds, ["m1"])
        // A draft never carries a schedule.
        let body = String(decoding: try JSONEncoder().encode(input), as: UTF8.self)
        XCTAssertFalse(body.contains("scheduledAt"))
        XCTAssertTrue(body.contains("\"aiGenerated\":true"))
    }
}
