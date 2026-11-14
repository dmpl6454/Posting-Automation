import XCTest
@testable import PostAutomation

/// Compose parity (2026-11-14): the request the app sends and when it refuses
/// to send one. Mirrors the web Compose and the server's post.create rules.
final class ComposePayloadTests: XCTestCase {
    private func channel(_ id: String, _ platform: String, _ name: String? = nil) -> Channel {
        let json = #"{"id":"\#(id)","platform":"\#(platform)","name":"\#(name ?? id)","isActive":true}"#
        return try! JSONDecoder().decode(Channel.self, from: Data(json.utf8))
    }

    private func json(_ input: CreatePostInput) -> [String: Any] {
        let data = try! JSONEncoder().encode(input)
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

    func testPlainDraftSendsOnlyTheOriginalKeys() {
        var d = ComposeDraft()
        d.content = " Hello "
        d.channels = [channel("c1", "TWITTER")]
        let body = json(ComposeRules.makeInput(d, action: .draft))
        XCTAssertEqual(Set(body.keys), ["content", "channelIds"])
        XCTAssertEqual(body["content"] as? String, "Hello")
    }

    func testPublishNowSendsTheCurrentTime() {
        var d = ComposeDraft()
        d.content = "x"
        d.channels = [channel("c1", "TWITTER")]
        let body = json(ComposeRules.makeInput(d, action: .publishNow, now: fixedNow))
        XCTAssertEqual(body["scheduledAt"] as? String, TRPCClient.isoWithFraction.string(from: fixedNow))
    }

    func testFirstCommentsOnlyWithInstagramOrFacebook() {
        var d = ComposeDraft()
        d.content = "x"
        d.firstComments = ["#a", "  ", "two"]
        d.firstCommentDelayMinutes = 15
        d.channels = [channel("c1", "TWITTER")]
        XCTAssertNil(json(ComposeRules.makeInput(d, action: .draft))["firstComments"])

        d.channels.append(channel("c2", "FACEBOOK"))
        let body = json(ComposeRules.makeInput(d, action: .draft))
        XCTAssertEqual(body["firstComments"] as? [String], ["#a", "two"])
        XCTAssertEqual(body["firstCommentDelayMinutes"] as? Int, 15)
    }

    func testZeroDelayIsOmitted() {
        var d = ComposeDraft()
        d.content = "x"
        d.firstComments = ["#a"]
        d.channels = [channel("c1", "INSTAGRAM")]
        XCTAssertNil(json(ComposeRules.makeInput(d, action: .draft))["firstCommentDelayMinutes"])
    }

    func testCaptionOverridesDropBlankAndIdenticalOnes() {
        var d = ComposeDraft()
        d.content = "shared"
        d.customCaptions = true
        d.channels = [channel("a", "TWITTER"), channel("b", "LINKEDIN"), channel("c", "THREADS")]
        d.captionOverrides = ["a": "own", "b": " shared ", "c": "  "]
        let body = json(ComposeRules.makeInput(d, action: .draft))
        XCTAssertEqual(body["captionOverrides"] as? [String: String], ["a": "own"])
    }

    func testEmptyCaptionAllowedOnlyWhenEveryChannelHasItsOwn() {
        var d = ComposeDraft()
        d.channels = [channel("a", "TWITTER"), channel("b", "LINKEDIN")]
        d.customCaptions = true
        d.captionOverrides = ["a": "one"]
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "Write a caption.")
        d.captionOverrides["b"] = "two"
        XCTAssertNil(ComposeRules.blockReason(d, action: .publishNow))
    }

    func testStorySendsTagsToInstagramOnly() {
        var d = ComposeDraft()
        d.mode = .story
        d.mediaIds = ["m1"]
        d.mediaKinds = [.image]
        d.storyMentions = ["alice"]
        d.firstComments = ["never on a story"]
        d.channels = [channel("f", "FACEBOOK")]
        var body = json(ComposeRules.makeInput(d, action: .publishNow))
        XCTAssertEqual((body["story"] as? [String: Any])?["mentions"] as? [String], [])
        XCTAssertNil(body["firstComments"])

        d.channels.append(channel("i", "INSTAGRAM"))
        body = json(ComposeRules.makeInput(d, action: .publishNow))
        XCTAssertEqual((body["story"] as? [String: Any])?["mentions"] as? [String], ["alice"])
    }

    func testStoryRules() {
        var d = ComposeDraft()
        d.mode = .story
        d.channels = [channel("i", "INSTAGRAM"), channel("t", "TWITTER", "My X")]
        XCTAssertEqual(ComposeRules.blockReason(d, action: .draft), "Stories can only go to Instagram or Facebook. Remove: My X.")
        d.channels.removeLast()
        XCTAssertNil(ComposeRules.blockReason(d, action: .draft), "a story note may be empty")
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "A story needs exactly one photo or video.")
        d.mediaIds = ["m"]; d.mediaKinds = [.video]
        XCTAssertNil(ComposeRules.blockReason(d, action: .publishNow))
    }

    func testYouTubeNeedsAVideoAndNoPhotos() {
        var d = ComposeDraft()
        d.content = "x"
        d.channels = [channel("y", "YOUTUBE")]
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "YouTube requires a video. Attach one before publishing.")
        d.mediaIds = ["v", "p"]; d.mediaKinds = [.video, .image]
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "YouTube does not accept images. Remove the photos before publishing.")
        XCTAssertNil(ComposeRules.blockReason(d, action: .draft), "drafts are never blocked by platform media rules")
    }

    func testYouTubeMetadataAndCover() {
        var d = ComposeDraft()
        d.content = "x"
        d.channels = [channel("y", "YOUTUBE")]
        d.mediaIds = ["v"]; d.mediaKinds = [.video]
        d.youtubeTitle = "  My video "
        d.youtubePrivacy = "unlisted"
        d.videoCoverMediaId = "cover1"
        let meta = json(ComposeRules.makeInput(d, action: .draft))["metadata"] as? [String: Any]
        XCTAssertEqual(meta?["title"] as? String, "My video")
        XCTAssertEqual(meta?["privacyStatus"] as? String, "unlisted")
        XCTAssertEqual((meta?["videoThumbnail"] as? [String: Any])?["mediaId"] as? String, "cover1")
    }

    func testCoverIsDroppedWithoutAVideo() {
        var d = ComposeDraft()
        d.content = "x"
        d.channels = [channel("i", "INSTAGRAM")]
        d.mediaIds = ["p"]; d.mediaKinds = [.image]
        d.videoCoverMediaId = "cover1"
        XCTAssertNil(json(ComposeRules.makeInput(d, action: .draft))["metadata"])
    }

    func testCampaignLabelIsCollapsedAndOmittedWhenBlank() {
        var d = ComposeDraft()
        d.content = "x"
        d.campaignLabel = "  Diwali   2026 "
        XCTAssertEqual(json(ComposeRules.makeInput(d, action: .draft))["campaignLabel"] as? String, "Diwali 2026")
        d.campaignLabel = "   "
        XCTAssertNil(json(ComposeRules.makeInput(d, action: .draft))["campaignLabel"])
    }

    // MARK: TikTok

    private func tiktokReady(_ options: [String] = ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], comments: Bool = false) -> TikTokCreatorInfoResult {
        TikTokCreatorInfoResult(
            creator: TikTokCreatorInfo(nickname: "Nick", username: "nick", avatarUrl: nil, privacyLevelOptions: options,
                                       commentDisabled: comments, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 600),
            canPost: true, reason: nil)
    }

    private func tiktokDraft() -> ComposeDraft {
        var d = ComposeDraft()
        d.content = "x"
        d.channels = [channel("t", "TIKTOK", "TT")]
        d.mediaIds = ["v"]; d.mediaKinds = [.video]
        d.tiktokCreators = ["t": tiktokReady()]
        return d
    }

    func testTikTokHasNoDefaultVisibility() {
        var d = tiktokDraft()
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "TT: choose who can see this video.")
        XCTAssertNil(ComposeRules.blockReason(d, action: .draft))
        d.tiktokDrafts["t"] = TikTokDraft(privacyLevel: "PUBLIC_TO_EVERYONE")
        XCTAssertNil(ComposeRules.blockReason(d, action: .publishNow))
    }

    func testTikTokNeedsExactlyOneVideo() {
        var d = tiktokDraft()
        d.tiktokDrafts["t"] = TikTokDraft(privacyLevel: "PUBLIC_TO_EVERYONE")
        d.mediaKinds = [.image]
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "TikTok posts need exactly one video.")
    }

    func testTikTokCommercialRules() {
        var d = tiktokDraft()
        d.tiktokDrafts["t"] = TikTokDraft(privacyLevel: "SELF_ONLY", discloseCommercial: true)
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "TT: \(TikTokText.commercialHint)")
        d.tiktokDrafts["t"]?.brandContent = true
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "TT: \(TikTokText.brandedPrivate)")
        d.tiktokDrafts["t"]?.privacyLevel = "PUBLIC_TO_EVERYONE"
        XCTAssertNil(ComposeRules.blockReason(d, action: .publishNow))
    }

    func testTikTokSettingAccountTurnedOffBlocks() {
        var d = tiktokDraft()
        d.tiktokCreators["t"] = tiktokReady(comments: true)
        d.tiktokDrafts["t"] = TikTokDraft(privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true)
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "TT: comments are turned off for this account.")
    }

    func testTikTokCannotPostShowsTikToksReason() {
        var d = tiktokDraft()
        d.tiktokCreators["t"] = TikTokCreatorInfoResult(creator: nil, canPost: false, reason: "Posting limit reached.")
        XCTAssertEqual(ComposeRules.blockReason(d, action: .publishNow), "TT: Posting limit reached.")
    }

    func testTikTokPayloadSendsBrandFlagsOnlyWhileDisclosing() {
        var d = tiktokDraft()
        d.tiktokDrafts["t"] = TikTokDraft(privacyLevel: "PUBLIC_TO_EVERYONE", allowDuet: true, discloseCommercial: false, brandOrganic: true, isAigc: true)
        let tt = (json(ComposeRules.makeInput(d, action: .draft))["tiktok"] as? [String: Any])?["byChannel"] as? [String: [String: Any]]
        XCTAssertEqual(tt?["t"]?["privacyLevel"] as? String, "PUBLIC_TO_EVERYONE")
        XCTAssertEqual(tt?["t"]?["brandOrganic"] as? Bool, false)
        XCTAssertEqual(tt?["t"]?["allowDuet"] as? Bool, true)
        XCTAssertEqual(tt?["t"]?["isAigc"] as? Bool, true)
    }

    func testTikTokConsentWording() {
        XCTAssertEqual(TikTokText.consent(branded: false), "By posting, you agree to TikTok's Music Usage Confirmation")
        XCTAssertEqual(TikTokText.consent(branded: true), "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.")
    }

    func testMentionParsing() {
        let r = ComposeRules.parseMentions("@alice, bob  @alice\nbad name! x.y_z")
        XCTAssertEqual(r.valid, ["alice", "bob", "bad", "x.y_z"])
        XCTAssertEqual(r.invalid, ["name!"])
    }

    func testUploadsBlockEverything() {
        var d = ComposeDraft()
        d.content = "x"
        d.mediaBusy = true
        XCTAssertNotNil(ComposeRules.blockReason(d, action: .draft))
    }
}
