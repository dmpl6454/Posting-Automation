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
    /// Set when the platform could not confirm whether the publish landed
    /// (2026-08-18 duplicate-post guard). Such a target is FAILED in `status`
    /// but must be shown as "Needs check" — never as a plain failure that
    /// invites a Retry, because retrying is what created the duplicates.
    let ambiguousAt: Date?
    let channel: Channel

    var publishedURL: URL? { publishedUrl.flatMap(URL.init(string:)) }
    var needsCheck: Bool { ambiguousAt != nil }
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
    /// `post.list` / `post.getById` include `mediaAttachments: { include: { media } }`.
    /// Optional so a list shape that omits it can never make a page undecodable.
    let mediaAttachments: [PostMediaAttachment]?

    /// Best "when" for display: published > scheduled > created.
    var displayDate: Date { publishedAt ?? scheduledAt ?? createdAt }

    /// Attached media in display order (`PostMedia.order`, then stable).
    var media: [MediaItem] {
        (mediaAttachments ?? [])
            .enumerated()
            .sorted { ($0.element.order ?? $0.offset) < ($1.element.order ?? $1.offset) }
            .map(\.element.media)
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

// MARK: - Media (Post.mediaAttachments[].media, upload.complete)

/// The Prisma `Media` row. `fileSize` is a BigInt (superjson encodes it as a
/// string + meta) and `metadata` is Json — both deliberately NOT modelled.
struct MediaItem: Decodable, Identifiable, Hashable {
    let id: String
    let url: String
    let fileName: String?
    let fileType: String?
    let thumbnailUrl: String?

    var isVideo: Bool { fileType?.hasPrefix("video/") == true }
    var mediaURL: URL? { URL(string: url) }
    /// Something an `<img>`-equivalent may load: a video's thumbnail when the
    /// worker produced one, an image's own URL, never a video file itself.
    var previewURL: URL? {
        if let thumbnailUrl, let u = URL(string: thumbnailUrl) { return u }
        return isVideo ? nil : mediaURL
    }
}

/// `PostMedia` join row (`post.list` includes it with the media relation).
struct PostMediaAttachment: Decodable, Identifiable, Hashable {
    let id: String
    let order: Int?
    let media: MediaItem
}

/// `upload.complete` (and the proxied `/api/upload`) answer `{ id, url, fileName, fileType }`.
struct UploadedMedia: Decodable, Identifiable, Hashable {
    let id: String
    let url: String
    let fileName: String
    let fileType: String
}

// MARK: - Compose (post.create)

struct CreatePostInput: Encodable {
    let content: String
    let channelIds: [String]
    /// ISO 8601 string; omit for a draft.
    let scheduledAt: String?
    /// `Media.id`s from `upload.complete`, in display order. nil (omitted) for a
    /// text-only post — synthesized `Encodable` skips nil optionals, which is what
    /// the zod `.optional()` on the server expects (it rejects an explicit null).
    var mediaIds: [String]? = nil
}

/// `post.create` returns the created Post; we only rely on `id`/`status` so a
/// server-side change to the returned shape can't break the compose flow.
struct CreatedPost: Decodable {
    let id: String
    let status: PostStatus?
}

// MARK: - Small shared inputs / acknowledgements

/// `{ id }` — post.getById / post.delete / notification.markRead / ...
struct IdInput: Encodable {
    let id: String
}

/// `post.publishNow { id, targetIds? }` — omit `targetIds` to publish every
/// claimable target; pass the FAILED ones to retry only those.
struct PublishNowInput: Encodable {
    let id: String
    var targetIds: [String]? = nil
}

/// Lenient ack for mutations that answer `{ success: true }` (post.delete,
/// post.publishNow, notification.markRead/markAllRead). Every field optional so a
/// richer future payload can never fail the decode.
struct Ack: Decodable {
    let success: Bool?
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
