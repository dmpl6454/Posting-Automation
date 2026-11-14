import Foundation

// Web-parity Phase 8: the super-admin panel (/admin) and Monitoring.
// Every procedure here is `superAdminProcedure` on the server — the app only
// hides the entry point; the server is the real gate.

struct AdminCount: Decodable, Equatable {
    var memberships: Int?
    var members: Int?
    var posts: Int?
    var channels: Int?
}

struct AdminUser: Decodable, Identifiable, Equatable {
    var id: String
    var name: String?
    var email: String
    var isSuperAdmin: Bool
    var appRole: String?
    var isBanned: Bool
    var createdAt: Date?
    var _count: AdminCount?

    var display: String { (name?.isEmpty == false ? name : nil) ?? email }

    enum K: String, CodingKey { case id, name, email, isSuperAdmin, appRole, isBanned, createdAt, _count }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        email = (try? c.decode(String.self, forKey: .email)) ?? ""
        isSuperAdmin = (try? c.decode(Bool.self, forKey: .isSuperAdmin)) ?? false
        appRole = try? c.decodeIfPresent(String.self, forKey: .appRole)
        isBanned = (try? c.decode(Bool.self, forKey: .isBanned)) ?? false
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        _count = try? c.decodeIfPresent(AdminCount.self, forKey: ._count)
    }
}

struct AdminUserDetail: Decodable {
    struct Member: Decodable, Identifiable {
        struct Org: Decodable { var id: String; var name: String; var plan: String? }
        var id: String
        var role: String
        var organization: Org
    }
    var id: String
    var memberships: [Member]
}

struct AdminOrg: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var slug: String?
    var plan: String
    var metaAppId: String?
    var createdAt: Date?
    var _count: AdminCount?
}

struct AdminPage<T: Decodable>: Decodable {
    var items: [T]
    var nextCursor: String?
}

struct MetaAppOption: Decodable, Identifiable, Equatable {
    var appId: String
    var legacy: Bool
    var id: String { appId }
}

struct AuditEntry: Decodable, Identifiable {
    struct Who: Decodable { var name: String?; var email: String? }
    struct Org: Decodable { var name: String }
    var id: String
    var action: String
    var entityType: String
    var entityId: String?
    var createdAt: Date?
    var user: Who?
    var organization: Org?
}

struct AdminOverview: Decodable {
    var users: Int
    var organizations: Int
    var posts: [String: Int]
    var channels: Int
    var agents: Int
    var queueHealth: [String: JSONValue]?
}

struct FailedJob: Decodable, Identifiable {
    var jobId: String
    var queue: String
    var queueName: String
    var failedReason: String?
    var attemptsMade: Int?
    var timestamp: Double?
    var id: String { "\(queueName)#\(jobId)" }

    enum K: String, CodingKey { case id, queue, queueName, failedReason, attemptsMade, timestamp }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        // BullMQ ids are strings, but a numeric id can arrive as a number.
        if let s = try? c.decode(String.self, forKey: .id) { jobId = s }
        else { jobId = String(Int((try? c.decode(Double.self, forKey: .id)) ?? 0)) }
        queue = (try? c.decode(String.self, forKey: .queue)) ?? ""
        queueName = (try? c.decode(String.self, forKey: .queueName)) ?? queue
        failedReason = try? c.decodeIfPresent(String.self, forKey: .failedReason)
        attemptsMade = try? c.decodeIfPresent(Int.self, forKey: .attemptsMade)
        timestamp = try? c.decodeIfPresent(Double.self, forKey: .timestamp)
    }
}

struct ErrorLogEntry: Decodable, Identifiable {
    var id: String
    var source: String
    var severity: String
    var message: String
    var endpoint: String?
    var occurrences: Int?
    var lastSeenAt: Date?
    var resolved: Bool
}

struct ErrorLogPage: Decodable { var errors: [ErrorLogEntry]; var nextCursor: String? }

struct ErrorStats: Decodable {
    var total: Int
    var unresolved: Int
    var last24h: Int
    var lastWeek: Int
}

struct UpdateCount: Decodable { var count: Int }

enum AdminRules {
    static let plans = ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]
    static let errorSources = ["all", "frontend", "api", "worker", "publish", "auto-healer"]
    static let severities = ["all", "critical", "error", "warning"]

    struct QueueRow: Equatable, Identifiable {
        var name: String
        var waiting: Int, active: Int, delayed: Int, failed: Int
        var unreadable: Bool
        var id: String { name }
    }

    /// `queue.getJobCounts()` per queue, or `{error}` when Redis couldn't be read.
    /// Busiest-first: failed, then waiting.
    static func queueRows(_ raw: [String: JSONValue]) -> [QueueRow] {
        raw.map { name, v in
            func n(_ k: String) -> Int { if case .number(let x)? = v[k] { return Int(x) }; return 0 }
            return QueueRow(name: name, waiting: n("waiting") + n("prioritized"), active: n("active"),
                            delayed: n("delayed"), failed: n("failed"), unreadable: v["error"] != nil)
        }
        .sorted { ($0.failed, $0.waiting, $1.name) > ($1.failed, $1.waiting, $0.name) }
    }

    /// The super-admin and ban actions TOGGLE on the server, so they are only
    /// offered when the result is what the button says. You can't ban or
    /// demote yourself from the phone (that would lock you out of this screen).
    static func canToggleBan(target: AdminUser, me: String?) -> Bool { target.id != me }
    static func canToggleSuperAdmin(target: AdminUser, me: String?) -> Bool { target.id != me }

    /// The appRole picker means nothing for a super admin (they pass every gate).
    static func appRoleEditable(_ u: AdminUser) -> Bool { !u.isSuperAdmin }

    static func humanQueue(_ key: String) -> String {
        key.replacingOccurrences(of: "_", with: " ").lowercased().capitalized
    }

    /// Retrying a publish job re-runs a publish. Say so.
    static func retryWarning(queueName: String) -> String? {
        queueName.lowercased().contains("publish")
            ? "This re-runs the publish. Targets marked \"Needs check\" are skipped by the server, but check the post isn't already live first."
            : nil
    }
}
