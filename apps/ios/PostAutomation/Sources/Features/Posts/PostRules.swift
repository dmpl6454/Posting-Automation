import Foundation

/// Post-page rules, ported from the web so the two apps decide the same way:
/// - retry / "Needs check": apps/web/app/dashboard/posts/[id]/page.tsx
/// - delete from Facebook/Instagram: apps/web/lib/platform-delete-view.ts
/// - first comments: apps/web/lib/first-comment.ts
/// Pure, so the wording and decisions are unit-tested.
enum PostRules {
    // MARK: Retry

    /// A channel that can be (re)sent. A "Needs check" channel is NEVER offered
    /// a plain retry: the post may already be live, and retrying is how
    /// duplicates got published (2026-08-18).
    static func canRetry(_ t: PostTarget) -> Bool {
        !t.needsCheck && [.FAILED, .DRAFT, .SCHEDULED].contains(t.status)
    }

    /// "Publish all" splits the not-yet-published channels into the ones that
    /// can safely be sent and the ones parked for a check.
    static func publishAllPlan(_ targets: [PostTarget]) -> (eligible: [PostTarget], parked: Int) {
        let pending = targets.filter { [.FAILED, .DRAFT, .SCHEDULED].contains($0.status) }
        let eligible = pending.filter { !$0.needsCheck }
        return (eligible, pending.count - eligible.count)
    }

    /// What to say when nothing can be sent — never a silent dead button.
    static func nothingToPublishMessage(parked: Int) -> (title: String, detail: String) {
        parked > 0
            ? ("Nothing safe to publish yet",
               "\(parked) channel\(parked == 1 ? "" : "s") may already have this post published — the platform never confirmed. Check the account, then use \u{201C}It didn't publish\u{201D} on that channel to allow a retry.")
            : ("No eligible channels", "Every channel is already published or has nothing to send.")
    }

    // MARK: Delete from the platforms

    enum DeleteState: Equatable {
        case none
        case eligible
        case inProgress
        case deleted(at: String?)
        case notFound(String)
        case failed(String)
    }

    static let deletablePlatforms: Set<String> = ["FACEBOOK", "INSTAGRAM"]
    /// Mirrors PLATFORM_DELETE_STALE_MS: a request this old is treated as lost.
    static let deleteStaleSeconds: TimeInterval = 30 * 60

    static func platformName(_ raw: String) -> String {
        raw == "FACEBOOK" ? "Facebook" : raw == "INSTAGRAM" ? "Instagram" : raw
    }

    static func deleteState(_ t: PostTarget, now: Date = Date()) -> DeleteState {
        if let deletedAt = t.platformDeletedAt {
            return .deleted(at: t.metadata?.platformDelete?.finishedAt ?? TRPCClient.isoWithFraction.string(from: deletedAt))
        }
        guard deletablePlatforms.contains(t.channel.platform.raw), t.status == .PUBLISHED, t.publishedId != nil else {
            return .none
        }
        let rec = t.metadata?.platformDelete
        if rec?.status == "queued" || rec?.status == "deleting" {
            if let at = rec?.requestedAt.flatMap(parseDate), now.timeIntervalSince(at) < deleteStaleSeconds {
                return .inProgress
            }
            return .eligible
        }
        if rec?.status == "not_found" { return .notFound(rec?.message ?? "") }
        if rec?.status == "failed" { return .failed(rec?.message ?? "") }
        return .eligible
    }

    static func canRequestDelete(_ s: DeleteState) -> Bool {
        switch s {
        case .eligible, .failed, .notFound: return true
        default: return false
        }
    }

    enum Tone { case muted, ok, warn, error }

    static func deleteLine(_ s: DeleteState, platform: String) -> (text: String, tone: Tone)? {
        let name = platformName(platform)
        switch s {
        case .inProgress: return ("Deleting from \(name)…", .muted)
        case .deleted(let at):
            let when = at.flatMap(parseDate).map { " on \($0.formatted(date: .abbreviated, time: .shortened))" } ?? ""
            return ("Deleted from \(name)\(when). Its history stays here.", .ok)
        case .notFound(let m): return (m.isEmpty ? "\(name) couldn't find this post. It may already be deleted." : m, .warn)
        case .failed(let m): return ("Couldn't delete from \(name): \(m.isEmpty ? "unknown error" : m)", .error)
        default: return nil
        }
    }

    /// `post.deleteFromPlatforms`' answer.
    struct DeleteRequestSummary: Decodable, Equatable {
        var queued: Int
        var notPublished: Int
        var unsupported: Int
        var alreadyDeleted: Int
        var inProgress: Int
        var overLimit: Int
    }

    static func deleteRequestMessage(_ s: DeleteRequestSummary) -> (title: String, detail: String) {
        var notes: [String] = []
        if s.inProgress > 0 { notes.append("\(s.inProgress) already being deleted") }
        if s.alreadyDeleted > 0 { notes.append("\(s.alreadyDeleted) already deleted") }
        if s.unsupported > 0 { notes.append("\(s.unsupported) on platforms we can't delete from (only Facebook and Instagram)") }
        if s.notPublished > 0 { notes.append("\(s.notPublished) never published") }
        if s.overLimit > 0 { notes.append("\(s.overLimit) left over the 1,000-per-request limit; run it again to continue") }
        let tail = notes.isEmpty ? "" : " Skipped: \(notes.joined(separator: "; "))."
        if s.queued == 0 {
            return ("Nothing to delete", "No published Facebook or Instagram posts to delete.\(tail)")
        }
        return ("Deleting \(s.queued) post\(s.queued == 1 ? "" : "s") from the platforms",
                "This runs in the background, a little over a second per channel; each channel shows its result.\(tail)")
    }

    // MARK: First comments

    static func firstCommentLine(_ m: TargetMetadata.FirstComment?, now: Date = Date()) -> (text: String, tone: Tone)? {
        guard let m, let status = m.status else { return nil }
        let total = (m.total ?? 0) > 1 ? m.total : nil
        let posted = m.posted ?? 0
        let noun = total != nil ? "First comments" : "First comment"
        let error = (m.error?.isEmpty == false) ? m.error : nil
        switch status {
        case "scheduled":
            let when: String
            if let due = m.dueAt.flatMap(parseDate) {
                when = due <= now ? "any moment now" : "at \(due.formatted(date: .abbreviated, time: .shortened))"
            } else {
                when = "later"
            }
            return ("\(noun) will be posted \(when).", .muted)
        case "posting":
            return ("Posting the \(noun.lowercased())…", .muted)
        case "posted":
            return (total.map { "All \($0) first comments posted." } ?? "First comment posted.", .ok)
        case "unconfirmed":
            return (total.map { "\(posted) of \($0) first comments posted; the next one wasn't confirmed — it may already be on the post. Check before adding any by hand." }
                ?? "First comment not confirmed — it may already be on the post. Check before adding it by hand.", .warn)
        case "failed":
            if let total {
                return ("\(posted) of \(total) first comments posted\(error.map { "; the next one failed: \($0)" } ?? ".") You can add the rest from the Comments inbox on the web.", .error)
            }
            return ("First comment wasn't posted\(error.map { ": \($0)" } ?? ".")", .error)
        default:
            return nil
        }
    }

    // MARK: Calendar

    /// The date a post sits on in the calendar — the web's rule.
    static func calendarDate(_ p: Post) -> Date { p.scheduledAt ?? p.publishedAt ?? p.createdAt }

    static func postsByDay(_ posts: [Post], calendar: Calendar = .current) -> [Date: [Post]] {
        Dictionary(grouping: posts) { calendar.startOfDay(for: calendarDate($0)) }
    }

    // MARK: Helpers

    static func parseDate(_ s: String) -> Date? {
        TRPCClient.isoWithFraction.date(from: s) ?? TRPCClient.isoPlain.date(from: s)
    }
}
