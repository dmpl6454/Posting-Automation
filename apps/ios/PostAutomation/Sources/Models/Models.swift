import Foundation
import SwiftUI

// Swift mirrors of the tRPC payloads the app consumes. `Decodable` ignores keys
// we don't declare, so server-side additions never break the app — and we
// deliberately do NOT model `metadata` / `contentVariants` (Prisma Json) or any
// BigInt column (superjson encodes those as strings + meta).

// MARK: - Enums

enum PostStatus: String, Decodable, CaseIterable, Identifiable {
    case DRAFT, SCHEDULED, PUBLISHING, PUBLISHED, FAILED, CANCELLED
    var id: String { rawValue }

    var label: String { rawValue.capitalized }

    var color: Color {
        switch self {
        case .DRAFT: return .gray
        case .SCHEDULED: return .blue
        case .PUBLISHING: return .orange
        case .PUBLISHED: return .green
        case .FAILED: return .red
        case .CANCELLED: return .secondary
        }
    }

    var systemImage: String {
        switch self {
        case .DRAFT: return "doc"
        case .SCHEDULED: return "clock"
        case .PUBLISHING: return "arrow.up.circle"
        case .PUBLISHED: return "checkmark.circle.fill"
        case .FAILED: return "exclamationmark.triangle.fill"
        case .CANCELLED: return "xmark.circle"
        }
    }
}

/// Kept as a String (not an enum) so a platform added server-side never makes
/// `channel.list` undecodable. Display helpers map known values.
struct Platform: Hashable {
    let raw: String

    var displayName: String {
        switch raw {
        case "TWITTER": return "X (Twitter)"
        case "YOUTUBE": return "YouTube"
        case "LINKEDIN": return "LinkedIn"
        case "TIKTOK": return "TikTok"
        case "DEVTO": return "dev.to"
        case "WORDPRESS": return "WordPress"
        // Unknown/new platform: "SOMETHING_NEW" → "Something New"
        default: return raw.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// SF Symbols stand-ins (no brand assets bundled).
    var systemImage: String {
        switch raw {
        case "TWITTER": return "xmark"
        case "INSTAGRAM": return "camera"
        case "FACEBOOK": return "f.square"
        case "LINKEDIN": return "briefcase"
        case "YOUTUBE": return "play.rectangle"
        case "TIKTOK": return "music.note"
        case "REDDIT": return "bubble.left.and.bubble.right"
        case "PINTEREST": return "pin"
        case "THREADS": return "at"
        case "TELEGRAM": return "paperplane"
        case "DISCORD": return "gamecontroller"
        case "SLACK": return "number"
        case "MASTODON": return "globe"
        case "BLUESKY": return "cloud"
        case "MEDIUM": return "text.book.closed"
        case "DEVTO": return "chevron.left.forwardslash.chevron.right"
        case "WORDPRESS": return "w.square"
        case "SNAPCHAT": return "ghost"
        default: return "network"
        }
    }

    var tint: Color {
        switch raw {
        case "INSTAGRAM": return .pink
        case "FACEBOOK": return .blue
        case "TWITTER": return .primary
        case "LINKEDIN": return .indigo
        case "YOUTUBE": return .red
        case "TIKTOK": return .primary
        case "TELEGRAM": return .cyan
        case "PINTEREST": return .red
        default: return .accentColor
        }
    }
}

// MARK: - Channel (channel.list)

struct ChannelInsightsHealth: Decodable, Hashable {
    let status: String?   // "ok" | "expiring_soon" | "needs_reconnect"
    let reason: String?
}

struct Channel: Decodable, Identifiable, Hashable {
    let id: String
    private let platformRaw: String
    let name: String
    let username: String?
    let avatar: String?
    let isActive: Bool
    let tokenExpiresAt: Date?
    let createdAt: Date?
    let insightsHealth: ChannelInsightsHealth?

    var platform: Platform { Platform(raw: platformRaw) }

    enum CodingKeys: String, CodingKey {
        case id, name, username, avatar, isActive, tokenExpiresAt, createdAt, insightsHealth
        case platformRaw = "platform"
    }

    var avatarURL: URL? { avatar.flatMap(URL.init(string:)) }
    var handle: String? { username.map { $0.hasPrefix("@") ? $0 : "@\($0)" } }
    var needsReconnect: Bool { insightsHealth?.status == "needs_reconnect" }
}

// MARK: - Post (post.list / post.getById)

struct PostTarget: Decodable, Identifiable, Hashable {
    let id: String
    let status: PostStatus
    let publishedUrl: String?
    let errorMessage: String?
    let publishedAt: Date?
    let channel: Channel
    // Phase 3 (2026-11-14). All optional: an older server or a renamed field
    // must never make post.list undecodable for an installed app.
    var publishedId: String? = nil
    /// Set when the platform never confirmed the publish — it may be live, so
    /// it must NOT be retried blindly ("Needs check").
    var ambiguousAt: Date? = nil
    var ambiguousReason: String? = nil
    var platformDeletedAt: Date? = nil
    var retryCount: Int? = nil
    var contentOverride: String? = nil
    var format: String? = nil
    var metadata: TargetMetadata? = nil

    var publishedURL: URL? { publishedUrl.flatMap(URL.init(string:)) }
    var needsCheck: Bool { ambiguousAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, status, publishedUrl, errorMessage, publishedAt, channel
        case publishedId, ambiguousAt, ambiguousReason, platformDeletedAt, retryCount, contentOverride, format, metadata
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(PostStatus.self, forKey: .status)
        publishedUrl = try c.decodeIfPresent(String.self, forKey: .publishedUrl)
        errorMessage = try c.decodeIfPresent(String.self, forKey: .errorMessage)
        publishedAt = try? c.decodeIfPresent(Date.self, forKey: .publishedAt)
        channel = try c.decode(Channel.self, forKey: .channel)
        publishedId = try? c.decodeIfPresent(String.self, forKey: .publishedId)
        ambiguousAt = try? c.decodeIfPresent(Date.self, forKey: .ambiguousAt)
        ambiguousReason = try? c.decodeIfPresent(String.self, forKey: .ambiguousReason)
        platformDeletedAt = try? c.decodeIfPresent(Date.self, forKey: .platformDeletedAt)
        retryCount = try? c.decodeIfPresent(Int.self, forKey: .retryCount)
        contentOverride = try? c.decodeIfPresent(String.self, forKey: .contentOverride)
        format = try? c.decodeIfPresent(String.self, forKey: .format)
        metadata = try? c.decodeIfPresent(TargetMetadata.self, forKey: .metadata)
    }
}

/// The two parts of PostTarget.metadata (Prisma Json) the app shows. Each part
/// decodes on its own; anything else in the column is ignored.
struct TargetMetadata: Decodable, Hashable {
    struct PlatformDelete: Decodable, Hashable {
        var status: String?
        var message: String?
        var requestedAt: String?
        var finishedAt: String?
    }
    struct FirstComment: Decodable, Hashable {
        var status: String?
        var error: String?
        var dueAt: String?
        var posted: Int?
        var total: Int?
    }
    var platformDelete: PlatformDelete?
    var firstComment: FirstComment?

    enum CodingKeys: String, CodingKey { case platformDelete, firstComment }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        platformDelete = try? c.decodeIfPresent(PlatformDelete.self, forKey: .platformDelete)
        firstComment = try? c.decodeIfPresent(FirstComment.self, forKey: .firstComment)
    }
    init(platformDelete: PlatformDelete? = nil, firstComment: FirstComment? = nil) {
        self.platformDelete = platformDelete
        self.firstComment = firstComment
    }
}

struct PostMediaAttachment: Decodable, Hashable {
    struct MediaRef: Decodable, Hashable {
        let id: String
        let url: String
        let fileType: String
    }
    let media: MediaRef
    var isVideo: Bool { media.fileType.hasPrefix("video/") }
}

struct Post: Decodable, Identifiable, Hashable {
    let id: String
    let content: String
    let status: PostStatus
    let scheduledAt: Date?
    let publishedAt: Date?
    let archivedAt: Date?
    let aiGenerated: Bool
    let createdAt: Date
    let updatedAt: Date
    let targets: [PostTarget]
    var campaignLabel: String? = nil
    var mediaAttachments: [PostMediaAttachment]? = nil

    /// Best "when" for display: published > scheduled > created.
    var displayDate: Date { publishedAt ?? scheduledAt ?? createdAt }
    /// The web's rule: only drafts and scheduled posts can be edited.
    var isEditable: Bool { status == .DRAFT || status == .SCHEDULED }

    enum CodingKeys: String, CodingKey {
        case id, content, status, scheduledAt, publishedAt, archivedAt, aiGenerated, createdAt, updatedAt, targets
        case campaignLabel, mediaAttachments
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        content = try c.decode(String.self, forKey: .content)
        status = try c.decode(PostStatus.self, forKey: .status)
        scheduledAt = try c.decodeIfPresent(Date.self, forKey: .scheduledAt)
        publishedAt = try c.decodeIfPresent(Date.self, forKey: .publishedAt)
        archivedAt = try c.decodeIfPresent(Date.self, forKey: .archivedAt)
        aiGenerated = try c.decode(Bool.self, forKey: .aiGenerated)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        targets = try c.decode([PostTarget].self, forKey: .targets)
        campaignLabel = try? c.decodeIfPresent(String.self, forKey: .campaignLabel)
        mediaAttachments = try? c.decodeIfPresent([PostMediaAttachment].self, forKey: .mediaAttachments)
    }
}

struct PostListPage: Decodable {
    let posts: [Post]
    let nextCursor: String?
}

struct PostListInput: Encodable {
    var status: PostStatus.RawValue? = nil
    var limit: Int = 20
    var cursor: String? = nil
    var archived: Bool = false
    var sort: String = "newest"
}

// MARK: - Compose (post.create)

struct CreatePostInput: Encodable {
    let content: String
    let channelIds: [String]
    /// ISO 8601 string; omit for a draft.
    let scheduledAt: String?
    /// Media rows from `upload.complete`, in display order; omitted when none.
    var mediaIds: [String]? = nil
    // Everything below is omitted from the JSON when nil (synthesized
    // Encodable uses encodeIfPresent), so an unused feature changes nothing.
    var story: StoryInput? = nil
    var firstComments: [String]? = nil
    var firstCommentDelayMinutes: Int? = nil
    var captionOverrides: [String: String]? = nil
    var campaignLabel: String? = nil
    var tiktok: TikTokInput? = nil
    var metadata: PostMetadataInput? = nil
}

/// `post.create` returns the created Post; we only rely on `id`/`status` so a
/// server-side change to the returned shape can't break the compose flow.
struct CreatedPost: Decodable {
    let id: String
    let status: PostStatus?
}

// MARK: - Dashboard (analytics.dashboardStats)

struct DashboardStats: Decodable {
    struct Trends: Decodable {
        let totalPosts: [Int]
        let published: [Int]
        let aiGenerated: [Int]
        let connectedChannels: [Int]
    }
    let totalPosts: Int
    let connectedChannels: Int
    let published: Int
    let aiGenerated: Int
    let trends: Trends
}
