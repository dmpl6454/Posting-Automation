import Foundation

/// Central place for environment configuration.
///
/// The app talks to the production PostAutomation API. `.co.in` is the canonical
/// host — `postautomation.in` 301-redirects to it, and NextAuth's session cookie
/// is scoped to `.co.in`, so pointing at `.in` would drop the cookie on the
/// redirect and every tRPC call would come back 401.
enum APIConfig {
    static let baseURL = URL(string: "https://postautomation.co.in")!

    /// Auth.js v5 cookie names on an HTTPS origin. The CSRF cookie uses the
    /// `__Host-` prefix and the session token the `__Secure-` prefix; both are
    /// verified against production (GET /api/auth/csrf).
    static let sessionCookieNames: Set<String> = [
        "__Secure-authjs.session-token",
        "authjs.session-token",
    ]

    /// Path of the tRPC fetch adapter mounted by apps/web/app/api/trpc/[trpc]/route.ts
    static let trpcPath = "/api/trpc"
}
