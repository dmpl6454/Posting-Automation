import Foundation

/// Which workspace (organization) the app acts in, and where that choice lives.
///
/// Every org-scoped tRPC call is pinned with the `x-organization-id` header
/// (`TRPCClient.organizationId`, owned by `SessionStore`). The server would fall
/// back to the user's OWNER-first / oldest-first membership when the header is
/// absent — `memberships[0]` of `user.me` is that very default — but a user who
/// belongs to several workspaces needs the one they last chose on this device to
/// come back after a relaunch. This enum is the pure part of that: resolving a
/// stored id against the live membership list, and the UserDefaults plumbing.
///
/// No I/O beyond `UserDefaults`, so the unit tests cover it without a network.
enum OrganizationSelection {

    // MARK: - Resolution

    /// The organization the session should act in.
    ///
    /// Precedence: the stored id, but ONLY while it is still one of the user's
    /// memberships (a workspace the user was removed from must never be pinned
    /// — every org-scoped call would come back FORBIDDEN); otherwise
    /// `memberships.first`, which `user.me` orders OWNER-first / oldest-first so
    /// it matches the org the server itself would pick; `nil` only when the
    /// user has no memberships at all.
    static func resolve(stored: String?, memberships: [Membership]) -> Organization? {
        if let stored, let match = memberships.first(where: { $0.organization.id == stored }) {
            return match.organization
        }
        return memberships.first?.organization
    }

    // MARK: - Persistence

    /// `activeOrganizationId.<userId>` — keyed per USER, not per device, so two
    /// accounts signing in on the same phone never inherit each other's choice
    /// (and a stale key from account A can never pin account B to a workspace
    /// B does not belong to; `resolve` would reject it anyway, belt and braces).
    static func storageKey(userId: String) -> String {
        "activeOrganizationId." + userId
    }

    /// The workspace id last chosen by this user on this device, if any.
    static func load(userId: String, defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: storageKey(userId: userId))
    }

    /// Persists the chosen workspace; `nil` removes the preference entirely
    /// (rather than storing an empty string that `resolve` would then have to
    /// treat as "nothing stored").
    static func store(_ organizationId: String?, userId: String, defaults: UserDefaults = .standard) {
        let key = storageKey(userId: userId)
        if let organizationId {
            defaults.set(organizationId, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
