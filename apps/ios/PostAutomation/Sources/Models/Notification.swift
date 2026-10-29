import Foundation
import SwiftUI

// `notification.list` rows — the Prisma Notification model minus `metadata`
// (Json) and the owner ids the app never needs. Producers and their `type`:
//   post-publish worker   "post.published" / "post.failed"  link /dashboard/posts/<id>
//   caption-fanout worker "post.captions_degraded" / "post.captions_held"
//   super-text worker     "post.supertext_degraded"
//   approval router       "approval.requested" / "approval.approved" / "approval.rejected"
// `type` stays a String (a new producer must never make the list undecodable).

struct AppNotification: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let title: String
    let body: String
    let link: String?
    let isRead: Bool
    let createdAt: Date

    /// `/dashboard/posts/<postId>` (optionally with a query string) → the post id,
    /// so a tap can open the post in-app instead of bouncing to the website.
    var linkedPostId: String? {
        guard let link else { return nil }
        let path = link.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? link
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "dashboard", parts[1] == "posts" else { return nil }
        return parts[2].isEmpty ? nil : parts[2]
    }

    var systemImage: String {
        switch type {
        case "post.published": return "checkmark.circle.fill"
        case "post.failed": return "exclamationmark.triangle.fill"
        case let t where t.hasPrefix("approval."): return "person.crop.circle.badge.checkmark"
        case let t where t.hasPrefix("post.captions"): return "text.quote"
        case let t where t.hasPrefix("post.supertext"): return "textformat"
        default: return "bell.fill"
        }
    }

    var tint: Color {
        switch type {
        case "post.published": return .green
        case "post.failed": return .red
        case let t where t.hasSuffix("_held"): return .orange
        default: return .accentColor
        }
    }
}

struct NotificationListPage: Decodable {
    let notifications: [AppNotification]
    let nextCursor: String?
}

struct NotificationListInput: Encodable {
    var limit: Int = 30
    var cursor: String? = nil
}

/// `notification.unreadCount` → `{ count }`
struct UnreadCountResult: Decodable {
    let count: Int
}
