import Foundation

// Compose → `post.create`, as pure data so it can be unit-tested. Mirrors the
// web Compose (apps/web/components/content-agent/ComposeTab.tsx) and the
// server's own rules in packages/api/src/routers/post.router.ts — the server is
// still the authority; these checks only stop a request that would certainly be
// refused and say why up front.

enum ComposeMode: String, CaseIterable, Identifiable {
    case post, story
    var id: String { rawValue }
    var label: String { self == .post ? "Post" : "Story" }
}

enum SubmitAction: Equatable {
    case draft
    case publishNow
    case schedule(Date)
}

// MARK: - TikTok

/// TikTok's Content Sharing Guidelines: no default visibility, every switch
/// off until the user turns it on. Same shape as the web's TikTokDraft.
struct TikTokDraft: Equatable {
    var privacyLevel: String?
    var allowComment = false
    var allowDuet = false
    var allowStitch = false
    var discloseCommercial = false
    var brandOrganic = false
    var brandContent = false
    var isAigc = false
}

struct TikTokCreatorInfo: Decodable, Equatable {
    let nickname: String
    let username: String
    let avatarUrl: String?
    let privacyLevelOptions: [String]
    let commentDisabled: Bool
    let duetDisabled: Bool
    let stitchDisabled: Bool
    let maxVideoPostDurationSec: Double?
}

/// `tiktok.creatorInfo`.
struct TikTokCreatorInfoResult: Decodable, Equatable {
    let creator: TikTokCreatorInfo?
    let canPost: Bool
    let reason: String?
}

enum TikTokText {
    static let privacyLabels: [String: String] = [
        "PUBLIC_TO_EVERYONE": "Everyone",
        "MUTUAL_FOLLOW_FRIENDS": "Friends",
        "FOLLOWER_OF_CREATOR": "Followers",
        "SELF_ONLY": "Only me",
    ]
    static let privacyPlaceholder = "Who can see this video"
    static let commercialHint = "You need to indicate if your content promotes yourself, a third party, or both."
    static let brandedPrivate = "Branded content visibility cannot be set to private."
    static let interactionOff = "Turned off in this account's TikTok settings."
    static let processingNotice = "TikTok may take a few minutes to process your video."

    /// Exact strings from TikTok's guidelines (the default has no full stop).
    static func consent(branded: Bool) -> String {
        branded
            ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
            : "By posting, you agree to TikTok's Music Usage Confirmation"
    }

    static func commercialLabel(_ d: TikTokDraft) -> String? {
        guard d.discloseCommercial else { return nil }
        if d.brandContent { return "Your video will be labeled as 'Paid partnership'" }
        if d.brandOrganic { return "Your video will be labeled as 'Promotional content'" }
        return nil
    }
}

struct TikTokSettingsInput: Encodable, Equatable {
    let privacyLevel: String
    let allowComment: Bool
    let allowDuet: Bool
    let allowStitch: Bool
    let brandOrganic: Bool
    let brandContent: Bool
    let isAigc: Bool

    /// nil until a visibility is chosen. Brand flags only count while
    /// disclosure is ON — a box ticked and then disclosure switched off is not sent.
    init?(_ d: TikTokDraft) {
        guard let level = d.privacyLevel else { return nil }
        privacyLevel = level
        allowComment = d.allowComment
        allowDuet = d.allowDuet
        allowStitch = d.allowStitch
        brandOrganic = d.discloseCommercial && d.brandOrganic
        brandContent = d.discloseCommercial && d.brandContent
        isAigc = d.isAigc
    }
}

struct TikTokInput: Encodable, Equatable { let byChannel: [String: TikTokSettingsInput] }
struct StoryInput: Encodable, Equatable { let mentions: [String] }
struct VideoThumbnailInput: Encodable, Equatable { let mediaId: String }

/// The `metadata` object post.create accepts (only the keys the app sets).
struct PostMetadataInput: Encodable, Equatable {
    var title: String?
    var privacyStatus: String?
    var videoThumbnail: VideoThumbnailInput?
    var isEmpty: Bool { title == nil && privacyStatus == nil && videoThumbnail == nil }
}

// MARK: - Input

/// Everything Compose knows when the user taps a button.
struct ComposeDraft {
    var content = ""
    var mode: ComposeMode = .post
    var channels: [Channel] = []           // the SELECTED channels
    var mediaIds: [String] = []             // uploaded, in order
    var mediaKinds: [ComposeAttachment.Kind] = []
    var mediaBusy = false                   // an upload still running or failed
    var storyMentions: [String] = []
    var firstComments: [String] = []
    var firstCommentDelayMinutes = 0
    var customCaptions = false
    var captionOverrides: [String: String] = [:]
    var campaignLabel = ""
    var tiktokDrafts: [String: TikTokDraft] = [:]
    var tiktokCreators: [String: TikTokCreatorInfoResult] = [:]
    var youtubeTitle = ""
    var youtubePrivacy = "public"
    var videoCoverMediaId: String?
}

enum ComposeRules {
    static let storyPlatforms: Set<String> = ["INSTAGRAM", "FACEBOOK"]
    static let firstCommentPlatforms: Set<String> = ["INSTAGRAM", "FACEBOOK"]
    static let firstCommentsMax = 5
    static let firstCommentMaxLength = 2200
    static let storyMaxMentions = 20
    static let campaignLabelMax = 120
    static let tiktokCaptionMax = 2200
    static let firstCommentDelays: [(minutes: Int, label: String)] = [
        (0, "Right away"), (1, "After 1 minute"), (5, "After 5 minutes"), (15, "After 15 minutes"),
        (30, "After 30 minutes"), (60, "After 1 hour"), (180, "After 3 hours"), (1440, "After 24 hours"),
    ]

    /// Instagram username rule (same as the server's IG_USERNAME_RE).
    static func isValidInstagramUsername(_ s: String) -> Bool {
        s.range(of: "^[A-Za-z0-9._]{1,30}$", options: .regularExpression) != nil
    }

    /// Splits typed tags ("@a, b c") into clean, de-duplicated usernames and the
    /// entries that aren't valid.
    static func parseMentions(_ raw: String) -> (valid: [String], invalid: [String]) {
        var valid: [String] = []
        var invalid: [String] = []
        var seen = Set<String>()
        for piece in raw.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }) {
            let name = piece.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "^@", with: "", options: .regularExpression)
            guard !name.isEmpty else { continue }
            guard isValidInstagramUsername(name) else { invalid.append(String(piece)); continue }
            if seen.insert(name.lowercased()).inserted { valid.append(name) }
        }
        return (valid, invalid)
    }

    static func hasPlatform(_ d: ComposeDraft, _ platform: String) -> Bool {
        d.channels.contains { $0.platform.raw == platform }
    }

    /// Every selected channel has its own non-blank caption.
    static func everyChannelHasOwnCaption(_ d: ComposeDraft) -> Bool {
        d.customCaptions && !d.channels.isEmpty && d.channels.allSatisfy {
            !(d.captionOverrides[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// Why this action can't go ahead yet, or nil. Drafts are only stopped by
    /// things that would make the request itself fail.
    static func blockReason(_ d: ComposeDraft, action: SubmitAction) -> String? {
        if d.mediaBusy { return "Wait for the uploads to finish (or remove the failed one)." }
        let trimmed = d.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty && d.mode == .post && !everyChannelHasOwnCaption(d) {
            return "Write a caption."
        }
        if d.campaignLabel.count > campaignLabelMax { return "The campaign label can be at most 120 characters." }
        if d.mode == .story {
            let others = d.channels.filter { !storyPlatforms.contains($0.platform.raw) }
            if !others.isEmpty {
                return "Stories can only go to Instagram or Facebook. Remove: \(others.map(\.name).joined(separator: ", "))."
            }
            if d.storyMentions.count > storyMaxMentions { return "A story can tag at most 20 accounts." }
        }
        if d.firstComments.contains(where: { $0.count > firstCommentMaxLength }) {
            return "Each first comment can be at most 2,200 characters."
        }
        guard action != .draft else { return nil }

        if d.channels.isEmpty { return "Pick at least one channel." }
        if d.mode == .story {
            if d.mediaIds.count != 1 { return "A story needs exactly one photo or video." }
            return nil
        }
        let videos = d.mediaKinds.filter { $0 == .video }.count
        let images = d.mediaKinds.filter { $0 == .image }.count
        if hasPlatform(d, "YOUTUBE") {
            if videos == 0 { return "YouTube requires a video. Attach one before publishing." }
            if images > 0 { return "YouTube does not accept images. Remove the photos before publishing." }
        }
        for ch in d.channels where ch.platform.raw == "TIKTOK" {
            if let reason = tiktokBlockReason(d, channel: ch, videos: videos, images: images) { return reason }
        }
        return nil
    }

    static func tiktokBlockReason(_ d: ComposeDraft, channel ch: Channel, videos: Int, images: Int) -> String? {
        if videos != 1 || images > 0 { return "TikTok posts need exactly one video." }
        guard let result = d.tiktokCreators[ch.id] else { return "\(ch.name): loading TikTok settings…" }
        guard result.canPost, let info = result.creator else {
            return "\(ch.name): \(result.reason ?? "This TikTok account can't post right now. Try again later.")"
        }
        let draft = d.tiktokDrafts[ch.id] ?? TikTokDraft()
        if draft.discloseCommercial && !draft.brandOrganic && !draft.brandContent {
            return "\(ch.name): \(TikTokText.commercialHint)"
        }
        guard let level = draft.privacyLevel else { return "\(ch.name): choose who can see this video." }
        if !info.privacyLevelOptions.contains(level) {
            return "\(ch.name): choose who can see this video again — that option isn't available for this account now."
        }
        if draft.discloseCommercial && draft.brandContent && level == "SELF_ONLY" {
            return "\(ch.name): \(TikTokText.brandedPrivate)"
        }
        var off: [String] = []
        if draft.allowComment && info.commentDisabled { off.append("comments") }
        if draft.allowDuet && info.duetDisabled { off.append("Duet") }
        if draft.allowStitch && info.stitchDisabled { off.append("Stitch") }
        if !off.isEmpty { return "\(ch.name): \(off.joined(separator: ", ")) are turned off for this account." }
        let caption = d.customCaptions ? (d.captionOverrides[ch.id].flatMap { $0.isEmpty ? nil : $0 } ?? d.content) : d.content
        if caption.utf16.count > tiktokCaptionMax {
            return "\(ch.name): TikTok captions can be up to 2,200 characters."
        }
        return nil
    }

    /// The `post.create` request. Optional keys are left out when unused, so a
    /// plain post is the same request the app sent before these features.
    static func makeInput(_ d: ComposeDraft, action: SubmitAction, now: Date = Date()) -> CreatePostInput {
        let isStory = d.mode == .story
        var input = CreatePostInput(
            content: d.content.trimmingCharacters(in: .whitespacesAndNewlines),
            channelIds: d.channels.map(\.id),
            scheduledAt: {
                switch action {
                case .draft: return nil
                case .publishNow: return TRPCClient.isoWithFraction.string(from: now)
                case .schedule(let date): return TRPCClient.isoWithFraction.string(from: date)
                }
            }(),
            mediaIds: d.mediaIds.isEmpty ? nil : d.mediaIds
        )
        if isStory {
            // Tags reach Instagram only; Facebook stories have no tagging API.
            input.story = StoryInput(mentions: hasPlatform(d, "INSTAGRAM") ? d.storyMentions : [])
        } else {
            let comments = d.firstComments
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .prefix(firstCommentsMax)
            if !comments.isEmpty && d.channels.contains(where: { firstCommentPlatforms.contains($0.platform.raw) }) {
                input.firstComments = Array(comments)
                if d.firstCommentDelayMinutes > 0 { input.firstCommentDelayMinutes = d.firstCommentDelayMinutes }
            }
            if d.customCaptions {
                var overrides: [String: String] = [:]
                for ch in d.channels {
                    let text = (d.captionOverrides[ch.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty && text != input.content { overrides[ch.id] = text }
                }
                if !overrides.isEmpty { input.captionOverrides = overrides }
            }
            var byChannel: [String: TikTokSettingsInput] = [:]
            for ch in d.channels where ch.platform.raw == "TIKTOK" {
                if let s = d.tiktokDrafts[ch.id].flatMap(TikTokSettingsInput.init) { byChannel[ch.id] = s }
            }
            if !byChannel.isEmpty { input.tiktok = TikTokInput(byChannel: byChannel) }

            var meta = PostMetadataInput()
            if hasPlatform(d, "YOUTUBE") {
                let title = d.youtubeTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty { meta.title = String(title.prefix(100)) }
                if d.youtubePrivacy != "public" { meta.privacyStatus = d.youtubePrivacy }
            }
            if let cover = d.videoCoverMediaId, d.mediaKinds.contains(.video) {
                meta.videoThumbnail = VideoThumbnailInput(mediaId: cover)
            }
            if !meta.isEmpty { input.metadata = meta }
        }
        let label = d.campaignLabel.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if !label.isEmpty { input.campaignLabel = label }
        return input
    }
}
