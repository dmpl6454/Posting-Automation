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

    var currentOrganizationName: String? { user?.defaultOrganization?.name }

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
        // server-side default ordering ever changes.
        client.organizationId = me.defaultOrganization?.id
    }
}
