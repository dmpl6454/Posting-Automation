import Foundation
import Observation

/// `org.current` answers `{ id, name, slug, role }`; only `id` is needed to know
/// the call succeeded. File-scoped (not nested in the `@MainActor` class) so its
/// synthesized `Decodable` initializer is never actor-isolated.
private struct OrgCurrentAck: Decodable {
    let id: String
}

/// Single source of truth for "who is signed in" and "which workspace the app
/// acts in". Injected via `.environment(SessionStore)` and read with
/// `@Environment(SessionStore.self)`.
///
/// Workspace scoping: `activeOrganizationId` is the ONE value every tab keys its
/// reloads on (`.task(id: session.activeOrganizationId)`), and it is mirrored
/// into `TRPCClient.organizationId` so every org-scoped call carries the
/// matching `x-organization-id` header. Nothing else in the app may write that
/// header — a tab that disagreed with the session about the workspace would show
/// one org's posts under another org's name.
@Observable
@MainActor
final class SessionStore {
    enum State: Equatable { case loading, signedOut, signedIn }

    private(set) var state: State = .loading
    private(set) var user: User?
    var lastError: String?

    /// The workspace every org-scoped call is pinned to. Non-nil whenever
    /// `state == .signedIn` (the server guarantees every user a personal org via
    /// `ensurePersonalOrg`, and `loadMe` provisions one through `org.current` in
    /// the one edge case where `user.me` arrives membership-less). Written only
    /// by `loadMe` and `switchOrganization`; cleared on sign-out.
    private(set) var activeOrganizationId: String?

    /// Unread in-app notifications in the ACTIVE workspace
    /// (`notification.unreadCount` filters on the org header). 0 when there are
    /// none — or when the count is unknown, e.g. right after a workspace switch
    /// until the refresh lands; a tab badge must never show a stale number
    /// that belongs to another workspace.
    private(set) var unreadNotifications: Int = 0

    private let auth: AuthService
    private let client: TRPCClient
    /// Where the per-user workspace preference lives (see `OrganizationSelection`).
    /// Injectable so a test can use an isolated suite instead of `.standard`.
    private let defaults: UserDefaults

    init(auth: AuthService = .shared, client: TRPCClient = .shared, defaults: UserDefaults = .standard) {
        self.auth = auth
        self.client = client
        self.defaults = defaults
    }

    // MARK: - Workspace

    /// The active workspace's membership organization, looked up in
    /// `user.memberships` so the name and plan are always the server's latest.
    var activeOrganization: Organization? {
        guard let user, let activeOrganizationId else { return nil }
        return user.memberships.first { $0.organization.id == activeOrganizationId }?.organization
    }

    var currentOrganizationName: String? { activeOrganization?.name }

    /// Switches the whole app to another workspace the user belongs to: re-pins
    /// the header, remembers the choice for this user on this device, and
    /// refreshes the badge. Every tab notices through `activeOrganizationId`
    /// changing and reloads its own data (the `.task(id:)` pattern).
    ///
    /// An id that is not one of the user's memberships is ignored outright —
    /// pinning it would make every org-scoped call FORBIDDEN.
    func switchOrganization(to organizationId: String) async {
        guard let user, user.memberships.contains(where: { $0.organization.id == organizationId }) else { return }
        activeOrganizationId = organizationId
        client.organizationId = organizationId
        OrganizationSelection.store(organizationId, userId: user.id, defaults: defaults)
        // The previous count belonged to the previous workspace; it is unknown
        // for this one until the refresh below answers.
        unreadNotifications = 0
        await refreshUnreadCount()
    }

    // MARK: - Notifications badge

    /// Re-reads `notification.unreadCount` for the active workspace. Never
    /// throws: an UNAUTHORIZED answer ends the session like any other tRPC
    /// caller would; any other failure (offline, nginx 429/5xx) keeps the
    /// previous count — a badge that flickers to 0 on every network blip would
    /// read as "everything has been read", which is worse than being a little
    /// stale.
    func refreshUnreadCount() async {
        guard state == .signedIn else { return }
        let requestedFor = activeOrganizationId
        do {
            let result: UnreadCountResult = try await client.query("notification.unreadCount")
            // A workspace switch (or sign-out) while the request was in flight
            // makes this answer belong to a workspace we are no longer in.
            guard state == .signedIn, activeOrganizationId == requestedFor else { return }
            unreadNotifications = max(0, result.count)
        } catch let e as APIError where e.isUnauthorized {
            await handleUnauthorized()
        } catch {
            // Keep the previous count (see above).
        }
    }

    // MARK: - Lifecycle

    /// On launch: if a session cookie survived from a previous run, validate it
    /// against `user.me`; otherwise go straight to the login screen.
    func bootstrap() async {
        guard auth.hasSessionCookie else { state = .signedOut; return }
        do {
            try await loadMe()
            state = .signedIn
        } catch {
            // Expired/invalid cookie (or offline). Fall back to login; the user
            // can sign in again — nothing destructive happens here.
            auth.clearCookies()
            state = .signedOut
            return
        }
        // After the tabs are showing, so the badge never delays first paint.
        await refreshUnreadCount()
    }

    func signIn(email: String, password: String) async throws {
        lastError = nil
        try await auth.signIn(email: email, password: password)
        try await loadMe()
        state = .signedIn
        await refreshUnreadCount()
    }

    func signOut() async {
        await auth.signOut()
        clearSessionState()
        state = .signedOut
    }

    /// Called by any view that gets UNAUTHORIZED from tRPC (cookie expired,
    /// password changed elsewhere → JWT invalidated, etc.).
    func handleUnauthorized() async {
        auth.clearCookies()
        clearSessionState()
        lastError = "Your session has expired. Please sign in again."
        state = .signedOut
    }

    // MARK: - Internals

    /// Everything that belongs to the signed-in user. The stored workspace
    /// preference is deliberately NOT erased: it is keyed per user and simply
    /// comes back the next time that same user signs in on this device.
    private func clearSessionState() {
        client.organizationId = nil
        user = nil
        activeOrganizationId = nil
        unreadNotifications = 0
    }

    private func loadMe() async throws {
        var me = try await fetchMe()
        if me.memberships.isEmpty {
            // Should not happen — every sign-up path runs `ensurePersonalOrg` —
            // but a membership-less user would otherwise be signed in with no
            // workspace, and every tab keys its loads on having one. `org.current`
            // provisions the personal org (idempotently) when the user has none;
            // re-read `user.me` so the new membership is visible. Best-effort:
            // neither call may turn a valid session into a failed sign-in.
            do {
                let ack: OrgCurrentAck = try await client.query("org.current")
                _ = ack
            } catch {
                // Provisioning failed (offline, 5xx): stay signed in without a
                // workspace rather than refusing a valid session.
            }
            if let healed = try? await fetchMe(), !healed.memberships.isEmpty { me = healed }
        }
        user = me
        // Pin the org explicitly so every call is unambiguous even if the
        // server-side default ordering ever changes: the workspace this user
        // last chose on this device, else the server's own default.
        let stored = OrganizationSelection.load(userId: me.id, defaults: defaults)
        let active = OrganizationSelection.resolve(stored: stored, memberships: me.memberships)
        activeOrganizationId = active?.id
        client.organizationId = active?.id
    }

    private func fetchMe() async throws -> User {
        let me: User? = try await client.query("user.me")
        guard let me else { throw APIError.invalidResponse }
        return me
    }
}
