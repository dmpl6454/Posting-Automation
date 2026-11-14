import Foundation

// Mirrors of the analytics.* payloads the Insights screens use. Every field
// that isn't essential decodes with `try?`, so a server-side change can't
// blank the whole screen of an installed app.

/// The metrics a row can carry. NOT interchangeable: on Facebook impressions
/// and views are different numbers; on Instagram/YouTube/Threads views is the
/// only one (impressions declared unavailable).
enum MetricKey: String, CaseIterable, Decodable {
    case impressions, views, reach, likes, comments, shares, clicks
}

private extension KeyedDecodingContainer {
    func int(_ k: Key) -> Int { (try? decodeIfPresent(Int.self, forKey: k)) ?? (try? decodeIfPresent(Double.self, forKey: k)).map { Int($0) } ?? 0 }
    func optInt(_ k: Key) -> Int? { (try? decodeIfPresent(Int.self, forKey: k)) ?? (try? decodeIfPresent(Double.self, forKey: k)).map { Int($0) } }
    func double(_ k: Key) -> Double? { try? decodeIfPresent(Double.self, forKey: k) }
    func string(_ k: Key) -> String? { try? decodeIfPresent(String.self, forKey: k) }
    func bool(_ k: Key) -> Bool? { try? decodeIfPresent(Bool.self, forKey: k) }
    /// Unknown metric names are dropped rather than failing the payload.
    func metrics(_ k: Key) -> [MetricKey]? {
        (try? decodeIfPresent([String].self, forKey: k)).map { $0.compactMap(MetricKey.init(rawValue:)) }
    }
}

struct RateBasis: Decodable, Equatable {
    var impressionedPosts: Int
    var totalPosts: Int
}

struct RateFlags: Decodable, Equatable {
    var lowBase: Bool
    /// "no_basis" | "rate_impossible" | nil
    var reason: String?
}

/// analytics.overview
struct InsightsOverview: Decodable {
    var totalPosts: Int
    var totalTargets: Int
    var published: Int
    var failed: Int
    var publishedAllTime: Int

    enum K: String, CodingKey { case totalPosts, totalTargets, published, failed, publishedAllTime }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        totalPosts = c.int(.totalPosts); totalTargets = c.int(.totalTargets)
        published = c.int(.published); failed = c.int(.failed); publishedAllTime = c.int(.publishedAllTime)
    }
}

/// analytics.engagement
struct InsightsEngagement: Decodable {
    var includesDirectPosts: Bool
    var values: [MetricKey: Int]
    var engagementRate: Double?
    var basis: RateBasis?
    var flags: RateFlags?
    /// Metrics ANY connected platform can report. nil ⇒ show everything (legacy payload).
    var reportableMetrics: [MetricKey]?

    enum K: String, CodingKey {
        case includesDirectPosts, impressions, views, reach, likes, comments, shares, clicks
        case engagementRate, engagementRateBasis, engagementRateFlags, reportableMetrics
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        includesDirectPosts = c.bool(.includesDirectPosts) ?? false
        var v: [MetricKey: Int] = [:]
        for (m, k) in [(MetricKey.impressions, K.impressions), (.views, .views), (.reach, .reach), (.likes, .likes),
                       (.comments, .comments), (.shares, .shares), (.clicks, .clicks)] {
            v[m] = c.int(k)
        }
        values = v
        engagementRate = c.double(.engagementRate)
        basis = try? c.decodeIfPresent(RateBasis.self, forKey: .engagementRateBasis)
        flags = try? c.decodeIfPresent(RateFlags.self, forKey: .engagementRateFlags)
        reportableMetrics = c.metrics(.reportableMetrics)
    }
}

/// One row of analytics.perChannelStats.
struct ChannelStat: Decodable, Identifiable {
    var id: String
    var name: String
    var username: String?
    var avatar: String?
    var platform: String
    var postCount: Int
    var values: [MetricKey: Int]
    var engagementRate: Double?
    var basis: RateBasis?
    var flags: RateFlags?
    /// "connected" | "paused" | "disconnected"
    var channelStatus: String?
    var hasSnapshot: Bool?
    var likeKind: String?
    var reachIsDistinct: Bool?
    var unavailable: [MetricKey]
    var healthStatus: String?

    enum K: String, CodingKey {
        case id, name, username, avatar, platform, postCount, impressions, views, reach, likes, comments, shares, clicks
        case engagementRate, engagementRateBasis, engagementRateFlags, channelStatus, hasSnapshot, likeKind
        case reachIsDistinct, unavailable, insightsHealth
    }
    private struct Health: Decodable { var status: String? }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.string(.name) ?? ""
        username = c.string(.username)
        avatar = c.string(.avatar)
        platform = c.string(.platform) ?? ""
        postCount = c.int(.postCount)
        var v: [MetricKey: Int] = [:]
        for (m, k) in [(MetricKey.impressions, K.impressions), (.views, .views), (.reach, .reach), (.likes, .likes),
                       (.comments, .comments), (.shares, .shares), (.clicks, .clicks)] {
            v[m] = c.int(k)
        }
        values = v
        engagementRate = c.double(.engagementRate)
        basis = try? c.decodeIfPresent(RateBasis.self, forKey: .engagementRateBasis)
        flags = try? c.decodeIfPresent(RateFlags.self, forKey: .engagementRateFlags)
        channelStatus = c.string(.channelStatus)
        hasSnapshot = c.bool(.hasSnapshot)
        likeKind = c.string(.likeKind)
        reachIsDistinct = c.bool(.reachIsDistinct)
        unavailable = c.metrics(.unavailable) ?? []
        healthStatus = (try? c.decodeIfPresent(Health.self, forKey: .insightsHealth))?.status
    }
}

/// analytics.insightsHealth
struct InsightsHealthSummary: Decodable {
    struct Item: Decodable, Identifiable {
        var id: String
        var name: String
        var platform: String
        var status: String
        var reason: String?
        var daysUntilDataAccessExpiry: Int?
    }
    var needsReconnectCount: Int
    var expiringSoonCount: Int
    var channels: [Item]

    enum K: String, CodingKey { case needsReconnectCount, expiringSoonCount, channels }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        needsReconnectCount = c.int(.needsReconnectCount)
        expiringSoonCount = c.int(.expiringSoonCount)
        channels = (try? c.decodeIfPresent([Item].self, forKey: .channels)) ?? []
    }
}

/// analytics.triggerSync
struct SyncResult: Decodable {
    var queued: Int
    var accountsQueued: Int
    enum K: String, CodingKey { case queued, accountsQueued }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        queued = c.int(.queued); accountsQueued = c.int(.accountsQueued)
    }
}

/// One row of analytics.postReports — a post on one channel.
struct ReportRow: Decodable, Identifiable {
    var id: String { targetId }
    var targetId: String
    var postId: String
    var contentPreview: String
    var channelName: String
    var channelUsername: String?
    var platform: String
    var publishedAt: Date?
    var publishedUrl: String?
    var campaignLabel: String?
    /// nil ⇒ "—" (not reported / not captured). A real 0 stays 0.
    var values: [MetricKey: Int?]
    var engagementRate: Double?
    var snapshotAt: Date?

    enum K: String, CodingKey {
        case targetId, postId, contentPreview, channelName, channelUsername, platform, publishedAt, publishedUrl
        case campaignLabel, impressions, views, reach, likes, comments, shares, clicks, engagementRate, snapshotAt
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        targetId = try c.decode(String.self, forKey: .targetId)
        postId = c.string(.postId) ?? ""
        contentPreview = c.string(.contentPreview) ?? ""
        channelName = c.string(.channelName) ?? ""
        channelUsername = c.string(.channelUsername)
        platform = c.string(.platform) ?? ""
        publishedAt = try? c.decodeIfPresent(Date.self, forKey: .publishedAt)
        publishedUrl = c.string(.publishedUrl)
        campaignLabel = c.string(.campaignLabel)
        var v: [MetricKey: Int?] = [:]
        for (m, k) in [(MetricKey.impressions, K.impressions), (.views, .views), (.reach, .reach), (.likes, .likes),
                       (.comments, .comments), (.shares, .shares), (.clicks, .clicks)] {
            v[m] = c.optInt(k)
        }
        values = v
        engagementRate = c.double(.engagementRate)
        snapshotAt = try? c.decodeIfPresent(Date.self, forKey: .snapshotAt)
    }
}

/// analytics.postReports
struct ReportsResponse: Decodable {
    var rows: [ReportRow]
    var reportableMetrics: [MetricKey]?
    enum K: String, CodingKey { case rows, reportableMetrics }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        rows = (try? c.decodeIfPresent([ReportRow].self, forKey: .rows)) ?? []
        reportableMetrics = c.metrics(.reportableMetrics)
    }
}
