import Foundation
import Observation

/// Single source of truth for "who is signed in". Injected via
/// `.environment(SessionStore)` and read with `@Environment(SessionStore.self)`.
@Observable
@MainActor
final class SessionStore {
    enum State: Equatable { case loading, signedOut, signedIn }

    private(set) var state: State = .loading
    private(set) var user: User?
    var lastError: String?

    private let auth: AuthService
    private let client: TRPCClient

    init(auth: AuthService = .shared, client: TRPCClient = .shared) {
        self.auth = auth
        self.client = client
    }

    /// The workspace every call is scoped to (sent as x-organization-id).
    /// Remembered between launches; falls back to the server's default.
    private(set) var activeOrganization: Organization?
    var currentOrganizationName: String? { activeOrganization?.name ?? user?.defaultOrganization?.name }
    static let activeOrgKey = "activeOrganizationId"

    /// Switch workspace. Views key on `activeOrganization?.id`, so every tab
    /// reloads with the new workspace's data.
    func switchOrganization(to org: Organization) {
        guard user?.memberships.contains(where: { $0.organization.id == org.id }) == true else { return }
        activeOrganization = org
        client.organizationId = org.id
        UserDefaults.standard.set(org.id, forKey: Self.activeOrgKey)
    }

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
        }
    }

    func signIn(email: String, password: String) async throws {
        lastError = nil
        try await auth.signIn(email: email, password: password)
        try await loadMe()
        state = .signedIn
    }

    func signOut() async {
        await auth.signOut()
        client.organizationId = nil
        activeOrganization = nil
        UserDefaults.standard.removeObject(forKey: Self.activeOrgKey)
        user = nil
        state = .signedOut
    }

    /// Called by any view that gets UNAUTHORIZED from tRPC (cookie expired,
    /// password changed elsewhere → JWT invalidated, etc.).
    func handleUnauthorized() async {
        auth.clearCookies()
        client.organizationId = nil
        user = nil
        lastError = "Your session has expired. Please sign in again."
        state = .signedOut
    }

    private func loadMe() async throws {
        let me: User? = try await client.query("user.me")
        guard let me else { throw APIError.invalidResponse }
        user = me
        // Pin the org explicitly so every call is unambiguous even if the
        // server-side default ordering ever changes. A remembered workspace the
        // user no longer belongs to is ignored.
        activeOrganization = LibraryRules.activeOrganization(
            remembered: UserDefaults.standard.string(forKey: Self.activeOrgKey), memberships: me.memberships
        )
        client.organizationId = activeOrganization?.id
    }
}
