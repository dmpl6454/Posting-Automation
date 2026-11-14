import Foundation

// Mirrors of comment.* and message.* payloads (Comments inbox, @mentions,
// Messages). Optional pieces decode with `try?` so a server change can't empty
// an inbox on an installed app.

private extension KeyedDecodingContainer {
    func str(_ k: Key) -> String? { try? decodeIfPresent(String.self, forKey: k) }
    func int(_ k: Key) -> Int { (try? decodeIfPresent(Int.self, forKey: k)) ?? 0 }
    func optInt(_ k: Key) -> Int? { try? decodeIfPresent(Int.self, forKey: k) }
    func bool(_ k: Key) -> Bool? { try? decodeIfPresent(Bool.self, forKey: k) }
}

/// What the channel's granted permissions allow (comment.* `capabilities`).
/// nil = unknown — the app never guesses.
struct CommentCapabilities: Decodable, Equatable {
    var known: Bool
    var canRead: Bool?
    var canReply: Bool?
    var canModerate: Bool?
    var canLike: Bool?
    var namesHidden: Bool?
    var missing: [String]

    enum K: String, CodingKey { case known, canRead, canReply, canModerate, canLike, namesHidden, missing }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        known = c.bool(.known) ?? false
        canRead = c.bool(.canRead); canReply = c.bool(.canReply); canModerate = c.bool(.canModerate)
        canLike = c.bool(.canLike); namesHidden = c.bool(.namesHidden)
        missing = (try? c.decodeIfPresent([String].self, forKey: .missing)) ?? []
    }
    init(known: Bool = false, canRead: Bool? = nil, canReply: Bool? = nil, canModerate: Bool? = nil, canLike: Bool? = nil, namesHidden: Bool? = nil, missing: [String] = []) {
        self.known = known; self.canRead = canRead; self.canReply = canReply; self.canModerate = canModerate
        self.canLike = canLike; self.namesHidden = namesHidden; self.missing = missing
    }
}

/// comment.accounts
struct CommentAccount: Decodable, Identifiable {
    var id: String
    var platform: String
    var name: String
    var username: String?
    var avatar: String?
    var isActive: Bool
    var publishedPosts: Int
    var commentAccess: CommentCapabilities?

    enum K: String, CodingKey { case id, platform, name, username, avatar, isActive, publishedPosts, commentAccess }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        platform = c.str(.platform) ?? ""
        name = c.str(.name) ?? ""
        username = c.str(.username)
        avatar = c.str(.avatar)
        isActive = c.bool(.isActive) ?? true
        publishedPosts = c.int(.publishedPosts)
        commentAccess = try? c.decodeIfPresent(CommentCapabilities.self, forKey: .commentAccess)
    }
}

/// One published post in comment.posts.
struct CommentPostItem: Decodable, Identifiable {
    var id: String { targetId }
    var targetId: String
    var caption: String
    var format: String?
    var publishedAt: Date?
    var publishedUrl: String?
    var mediaKind: String?
    var thumbnailUrl: String?

    enum K: String, CodingKey { case targetId, caption, format, publishedAt, publishedUrl, mediaKind, thumbnailUrl }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        targetId = try c.decode(String.self, forKey: .targetId)
        caption = c.str(.caption) ?? ""
        format = c.str(.format)
        publishedAt = try? c.decodeIfPresent(Date.self, forKey: .publishedAt)
        publishedUrl = c.str(.publishedUrl)
        mediaKind = c.str(.mediaKind)
        thumbnailUrl = c.str(.thumbnailUrl)
    }
}

struct CommentPostsPage: Decodable {
    var items: [CommentPostItem]
    var nextCursor: String?
}

struct CommentAuthor: Decodable, Equatable {
    var id: String?
    var name: String?
    var username: String?
}

/// One comment (or reply), live from Meta.
struct SocialComment: Decodable, Identifiable, Equatable {
    var id: String
    var text: String
    /// Exactly as Graph sends it ("2026-09-19T10:00:00+0000"); "" if absent.
    var createdAt: String
    var author: CommentAuthor
    var likeCount: Int
    var hidden: Bool
    var replyCount: Int
    var replies: [SocialComment]
    var isOwn: Bool
    var canReply: Bool
    var attachmentType: String?
    /// nil on Instagram: it can't say whether we liked it.
    var likedByAccount: Bool?
    var canHide: Bool
    var canDelete: Bool
    var canLike: Bool
    var canEdit: Bool

    enum K: String, CodingKey {
        case id, text, createdAt, author, likeCount, hidden, replyCount, replies, isOwn, canReply, attachmentType
        case likedByAccount, canHide, canDelete, canLike, canEdit
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        text = c.str(.text) ?? ""
        createdAt = c.str(.createdAt) ?? ""
        author = (try? c.decodeIfPresent(CommentAuthor.self, forKey: .author)) ?? CommentAuthor()
        likeCount = c.int(.likeCount)
        hidden = c.bool(.hidden) ?? false
        replyCount = c.int(.replyCount)
        replies = (try? c.decodeIfPresent([SocialComment].self, forKey: .replies)) ?? []
        isOwn = c.bool(.isOwn) ?? false
        canReply = c.bool(.canReply) ?? false
        attachmentType = c.str(.attachmentType)
        likedByAccount = c.bool(.likedByAccount)
        canHide = c.bool(.canHide) ?? false
        canDelete = c.bool(.canDelete) ?? false
        canLike = c.bool(.canLike) ?? false
        canEdit = c.bool(.canEdit) ?? false
    }
}

/// comment.list
struct CommentThreadPage: Decodable {
    struct Account: Decodable { var name: String?; var username: String? }
    var capabilities: CommentCapabilities
    var platform: String
    var publishedUrl: String?
    var account: Account?
    var comments: [SocialComment]
    var nextCursor: String?
    var totalCount: Int?

    enum K: String, CodingKey { case capabilities, platform, publishedUrl, account, comments, nextCursor, totalCount }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        capabilities = (try? c.decodeIfPresent(CommentCapabilities.self, forKey: .capabilities)) ?? CommentCapabilities()
        platform = c.str(.platform) ?? ""
        publishedUrl = c.str(.publishedUrl)
        account = try? c.decodeIfPresent(Account.self, forKey: .account)
        comments = try c.decode([SocialComment].self, forKey: .comments)
        nextCursor = c.str(.nextCursor)
        totalCount = c.optInt(.totalCount)
    }
}

/// comment.moderate
struct ModerateResult: Decodable {
    /// Instagram re-reads the count after a like; nil when it couldn't.
    var likeCount: Int?
    /// Was the key present at all? Facebook never sends one (use ±1 locally).
    var likeCountSent: Bool

    enum K: String, CodingKey { case likeCount }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        likeCountSent = c.contains(.likeCount)
        likeCount = c.optInt(.likeCount)
    }
}

// MARK: - Mentions

struct InstagramMention: Decodable, Identifiable {
    struct Account: Decodable { var channelId: String?; var name: String?; var username: String?; var disconnected: Bool?; var canReply: Bool? }
    var id: String
    /// "comment" | "caption"
    var kind: String
    var text: String?
    var username: String?
    var permalink: String?
    var mentionedAt: Date?
    var receivedAt: Date?
    var detailsError: String?
    /// nil | "SENT" | "UNCONFIRMED"
    var replyStatus: String?
    var replyText: String?
    var repliedAt: Date?
    var dismissedAt: Date?
    var account: Account?

    enum K: String, CodingKey {
        case id, kind, text, username, permalink, mentionedAt, receivedAt, detailsError, replyStatus, replyText, repliedAt, dismissedAt, account
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        kind = c.str(.kind) ?? "caption"
        text = c.str(.text); username = c.str(.username); permalink = c.str(.permalink)
        mentionedAt = try? c.decodeIfPresent(Date.self, forKey: .mentionedAt)
        receivedAt = try? c.decodeIfPresent(Date.self, forKey: .receivedAt)
        detailsError = c.str(.detailsError)
        replyStatus = c.str(.replyStatus); replyText = c.str(.replyText)
        repliedAt = try? c.decodeIfPresent(Date.self, forKey: .repliedAt)
        dismissedAt = try? c.decodeIfPresent(Date.self, forKey: .dismissedAt)
        account = try? c.decodeIfPresent(Account.self, forKey: .account)
    }
}

struct MentionsPage: Decodable {
    var openCount: Int
    var nextCursor: String?
    var mentions: [InstagramMention]
    enum K: String, CodingKey { case openCount, nextCursor, mentions }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        openCount = c.int(.openCount)
        nextCursor = c.str(.nextCursor)
        mentions = (try? c.decodeIfPresent([InstagramMention].self, forKey: .mentions)) ?? []
    }
}

// MARK: - Messages

struct MessagingCapabilities: Decodable {
    var known: Bool
    var canUseInbox: Bool?
    var missingForInbox: [String]
    enum K: String, CodingKey { case known, canUseInbox, missingForInbox }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        known = c.bool(.known) ?? false
        canUseInbox = c.bool(.canUseInbox)
        missingForInbox = (try? c.decodeIfPresent([String].self, forKey: .missingForInbox)) ?? []
    }
}

struct MessagingAccount: Decodable, Identifiable {
    var id: String
    var platform: String
    var name: String
    var username: String?
    var avatar: String?
    var messageAccess: MessagingCapabilities?
}

struct MessageParticipant: Decodable, Equatable {
    var id: String
    var name: String?
    var username: String?
    var display: String { name ?? username.map { "@\($0)" } ?? "Someone" }
}

struct SocialConversation: Decodable, Identifiable {
    var id: String
    var updatedAt: String
    var participant: MessageParticipant?
    var snippet: String
    var lastFromAccount: Bool?
    var unreadCount: Int?
}

struct ConversationsPage: Decodable {
    var conversations: [SocialConversation]
    var nextCursor: String?
    var blocked: Bool?
    var capabilities: MessagingCapabilities?
}

struct MessageAttachment: Decodable {
    var kind: String
    var previewUrl: String?
    var url: String?
    var name: String?
}

struct SocialMessage: Decodable, Identifiable {
    var id: String
    var text: String
    var createdAt: String
    var fromAccount: Bool
    var attachments: [MessageAttachment]?
}

/// message.thread
struct ConversationThread: Decodable {
    var participant: MessageParticipant?
    var messages: [SocialMessage]
    /// false ⇒ outside Meta's reply window — sending is refused.
    var windowOpen: Bool?
    var windowClosesAt: String?
}
