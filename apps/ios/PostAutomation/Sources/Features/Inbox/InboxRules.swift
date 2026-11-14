import Foundation

/// Inbox rules, ported from the web (apps/web/lib/comment-reply-outcome.ts,
/// comment-moderation-patch.ts, graph-time.ts). Pure and unit-tested.
enum InboxRules {
    enum ModerationAction: String { case hide, unhide, delete, like, unlike, edit }

    // MARK: Sending is not idempotent

    enum FailureKind: Equatable {
        /// It may already be posted/sent — refresh and check, NEVER auto-retry.
        case unconfirmed
        /// Definitely not sent (refused, rate-limited, bad input).
        case refused
    }

    /// The web's classifyReplyFailure. A request that never got a structured
    /// answer (network drop, nginx 5xx page) counts as unconfirmed: it may have
    /// reached Meta.
    static func classify(_ error: Error) -> FailureKind {
        let message = error.localizedDescription
        if message.range(of: "may already be posted", options: .caseInsensitive) != nil { return .unconfirmed }
        if message.range(of: "may already have been sent", options: .caseInsensitive) != nil { return .unconfirmed }
        if message.range(of: "didn't confirm (the private reply|that message)", options: [.regularExpression, .caseInsensitive]) != nil {
            return .unconfirmed
        }
        guard let api = error as? APIError else { return .unconfirmed }
        switch api {
        case .trpc(let p):
            if p.code == "TOO_MANY_REQUESTS" { return .refused }
            if message.range(of: "too many requests|a lot of comment activity", options: [.regularExpression, .caseInsensitive]) != nil {
                return .refused
            }
            return (p.data?.httpStatus ?? 0) >= 500 ? .unconfirmed : .refused
        case .http(let status, _):
            return status == 429 ? .refused : (status >= 500 ? .unconfirmed : .refused)
        case .decoding, .invalidResponse:
            return .unconfirmed
        }
    }

    // MARK: Moderation patch (web: applyModeration)

    /// Apply a confirmed moderation result to the loaded thread. Returns nil
    /// when the comment was deleted. `likeCount`: `.some(n)` from Instagram's
    /// re-read, `.some(nil)` when it couldn't re-read (leave the count), and
    /// `nil` (no key — Facebook) ⇒ ±1 locally.
    static func apply(_ c: SocialComment, id: String, action: ModerationAction, message: String? = nil, likeCount: Int?? = nil) -> SocialComment? {
        if c.id == id {
            var out = c
            switch action {
            case .delete: return nil
            case .hide, .unhide: out.hidden = action == .hide
            case .like, .unlike:
                let liked = action == .like
                if let reported = likeCount {
                    if let n = reported, n >= 0 { out.likeCount = n }
                } else {
                    let delta = liked == (c.likedByAccount ?? false) ? 0 : (liked ? 1 : -1)
                    out.likeCount = max(0, c.likeCount + delta)
                }
                out.likedByAccount = liked
            case .edit: out.text = message ?? c.text
            }
            return out
        }
        guard c.replies.contains(where: { $0.id == id }) else { return c }
        var out = c
        out.replies = c.replies.compactMap { apply($0, id: id, action: action, message: message, likeCount: likeCount) }
        out.replyCount = max(0, c.replyCount - (c.replies.count - out.replies.count))
        return out
    }

    static func apply(_ list: [SocialComment], id: String, action: ModerationAction, message: String? = nil, likeCount: Int?? = nil) -> [SocialComment] {
        list.compactMap { apply($0, id: id, action: action, message: message, likeCount: likeCount) }
    }

    // MARK: Display

    /// Graph timestamps ("2026-09-19T10:00:00+0000") — ISO 8601 without the colon.
    static func graphDate(_ s: String) -> Date? {
        guard !s.isEmpty else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        for format in ["yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mm:ss.SSSZ"] {
            f.dateFormat = format
            if let d = f.date(from: s) { return d }
        }
        return TRPCClient.isoWithFraction.date(from: s) ?? TRPCClient.isoPlain.date(from: s)
    }

    /// Future times (clock skew) read as "just now", like the web.
    static func relative(_ s: String, now: Date = Date()) -> String {
        guard let d = graphDate(s) else { return "" }
        if d >= now.addingTimeInterval(-30) { return "just now" }
        return RelativeDateTimeFormatter().localizedString(for: d, relativeTo: now)
    }

    /// Instagram hides commenter names without instagram_manage_comments.
    static func authorName(_ c: SocialComment, accountName: String?, namesHidden: Bool?) -> String {
        if c.isOwn { return accountName ?? "You" }
        if let u = c.author.username, !u.isEmpty { return "@\(u)" }
        if let n = c.author.name, !n.isEmpty { return n }
        return namesHidden == true ? "Instagram user (name hidden)" : "Someone"
    }

    /// Why a write action is greyed out, or nil when it's allowed.
    static func writeBlockedReason(_ caps: CommentCapabilities, platform: String) -> String? {
        guard caps.known, caps.canReply == false else { return nil }
        let p = platform == "INSTAGRAM" ? "Instagram" : "Facebook"
        let scopes = caps.missing.isEmpty ? "" : " (missing: \(caps.missing.joined(separator: ", ")))"
        return "This \(p) account hasn't granted comment access\(scopes). Reconnect it on the web Channels page, choosing “Edit settings”."
    }
}
