import Foundation

// media.list, channelGroup.list, notification.* payloads (web-parity Phase 6).

private extension KeyedDecodingContainer {
    func str(_ k: Key) -> String? { try? decodeIfPresent(String.self, forKey: k) }
}

/// One file in the media library.
struct MediaItem: Decodable, Identifiable, Equatable {
    var id: String
    var fileName: String
    var fileType: String
    /// BigInt column: superjson sends it as a STRING, older rows as a number.
    var fileSize: Int64?
    var url: String
    var thumbnailUrl: String?
    var createdAt: Date?
    /// Web-optimized video rendition (media-optimize worker), when made.
    var optimizedUrl: String?

    var isVideo: Bool { fileType.hasPrefix("video/") }
    /// What to play: the optimized rendition when there is one (originals can
    /// be multi-GB camera files), else the original.
    var playbackURL: URL? { URL(string: optimizedUrl ?? url) }

    enum K: String, CodingKey { case id, fileName, fileType, fileSize, url, thumbnailUrl, createdAt, metadata }
    private struct Meta: Decodable {
        struct Optimize: Decodable { var status: String?; var url: String? }
        var optimize: Optimize?
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        fileName = c.str(.fileName) ?? ""
        fileType = c.str(.fileType) ?? ""
        url = try c.decode(String.self, forKey: .url)
        thumbnailUrl = c.str(.thumbnailUrl)
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        fileSize = LibraryRules.lenientSize(c, .fileSize)
        let meta = try? c.decodeIfPresent(Meta.self, forKey: .metadata)
        optimizedUrl = meta?.optimize?.status == "done" ? meta?.optimize?.url : nil
    }
}

struct MediaPage: Decodable {
    var items: [MediaItem]
    var nextCursor: String?
}

struct ChannelGroup: Decodable, Identifiable, Equatable {
    struct Member: Decodable, Equatable, Identifiable {
        var id: String
        var name: String
        var platform: String
        var isActive: Bool?
    }
    var id: String
    var name: String
    var color: String?
    var channels: [Member]
}

struct AppNotification: Decodable, Identifiable {
    var id: String
    var type: String
    var title: String
    var body: String
    var link: String?
    var isRead: Bool
    var createdAt: Date?
}

struct NotificationsPage: Decodable {
    var notifications: [AppNotification]
    var nextCursor: String?
}

struct UnreadCount: Decodable { var count: Int }

enum LibraryRules {
    /// A size that may arrive as a number or as superjson's BigInt string.
    static func lenientSize<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int64? {
        if let n = try? c.decodeIfPresent(Int64.self, forKey: k) { return n }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int64(d) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int64(s) }
        return nil
    }

    static func sizeText(_ bytes: Int64?) -> String {
        guard let bytes else { return "" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// A notification link that opens a post page in the app — the web's
    /// `/dashboard/posts/<id>` — or nil.
    static func postId(fromLink link: String?) -> String? {
        guard let link, let path = URL(string: link, relativeTo: URL(string: "https://x.invalid"))?.path else { return nil }
        let parts = path.split(separator: "/").map(String.init)
        guard let i = parts.firstIndex(of: "posts"), i + 1 < parts.count else { return nil }
        let id = parts[i + 1]
        return id.range(of: "^[A-Za-z0-9_-]{6,64}$", options: .regularExpression) != nil && id != "new" && id != "bulk" ? id : nil
    }

    /// What `channelGroup.setChannels` needs to turn `current` members into `wanted`.
    static func groupDiff(current: Set<String>, wanted: Set<String>) -> (add: [String], remove: [String]) {
        (Array(wanted.subtracting(current)).sorted(), Array(current.subtracting(wanted)).sorted())
    }

    /// The workspace to use: the remembered one if the user still belongs to it,
    /// else the server's default (first membership).
    static func activeOrganization(remembered: String?, memberships: [Membership]) -> Organization? {
        if let remembered, let m = memberships.first(where: { $0.organization.id == remembered }) { return m.organization }
        return memberships.first?.organization
    }

    /// Group pills in the channel picker: a group's ACTIVE members that are in
    /// the picker's list (a stale id can't sneak into a post).
    static func selectableMembers(_ group: ChannelGroup, available: Set<String>) -> [String] {
        group.channels.filter { ($0.isActive ?? true) && available.contains($0.id) }.map(\.id)
    }
}
