import Foundation

/// Signs in against NextAuth (Auth.js v5) exactly the way the web login form
/// does, so no backend changes are needed:
///
///   1. GET  /api/auth/csrf                      → { csrfToken } + csrf cookie
///   2. POST /api/auth/callback/credentials      → session cookie on success
///      (form-encoded: csrfToken, email, password, loginType=email, json=true)
///
/// `json=true` is what `signIn(..., { redirect: false })` sends from the browser:
/// Auth.js then answers 200 `{ "url": "..." }` instead of a 302, and a failed
/// login shows up as `?error=CredentialsSignin` inside that url. We still handle
/// a 302 defensively by refusing to follow redirects and reading `Location`.
///
/// The resulting `__Secure-authjs.session-token` cookie lives in the shared
/// `HTTPCookieStorage`, which `TRPCClient` reuses — so every tRPC call after
/// this is authenticated, and the session survives app restarts.
enum AuthError: Error, LocalizedError, Equatable {
    case invalidCredentials
    case oauthOnlyAccount
    case csrfUnavailable
    case rateLimited
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidCredentials: return "Invalid email or password."
        case .oauthOnlyAccount: return "This account signs in with Google. Set a password from the web dashboard to use the app."
        case .csrfUnavailable: return "Couldn't reach the sign-in service. Check your connection and try again."
        case .rateLimited: return "Too many attempts — please wait a minute and try again."
        case .server(let m): return m
        }
    }
}

enum LoginOutcome: Equatable {
    case success
    case failure(AuthError)
}

final class AuthService {
    static let shared = AuthService()

    private let baseURL: URL
    private let session: URLSession
    private let cookieStorage: HTTPCookieStorage

    init(baseURL: URL = APIConfig.baseURL, cookieStorage: HTTPCookieStorage = .shared) {
        self.baseURL = baseURL
        self.cookieStorage = cookieStorage
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = cookieStorage
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpShouldSetCookies = true
        cfg.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: cfg)
    }

    // MARK: Session state

    var hasSessionCookie: Bool {
        (cookieStorage.cookies(for: baseURL) ?? []).contains { APIConfig.sessionCookieNames.contains($0.name) }
    }

    /// Remove every cookie for the API host (session, csrf, callback-url).
    func clearCookies() {
        for c in cookieStorage.cookies(for: baseURL) ?? [] { cookieStorage.deleteCookie(c) }
    }

    // MARK: Sign in

    func signIn(email: String, password: String) async throws {
        let csrf = try await fetchCSRFToken()

        var req = URLRequest(url: baseURL.appendingPathComponent("/api/auth/callback/credentials"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = Self.formEncode([
            "csrfToken": csrf,
            "email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            "password": password,
            "loginType": "email",          // mirrors apps/web login page exactly
            "callbackUrl": baseURL.appendingPathComponent("/dashboard").absoluteString,
            "json": "true",
        ])

        let (data, response) = try await session.data(for: req, delegate: NoRedirectDelegate.shared)
        guard let http = response as? HTTPURLResponse else { throw AuthError.csrfUnavailable }

        let redirectTarget = http.value(forHTTPHeaderField: "Location")
            ?? (try? JSONDecoder().decode(CallbackJSON.self, from: data))?.url

        switch Self.parseCallbackOutcome(status: http.statusCode, target: redirectTarget, hasSessionCookie: hasSessionCookie) {
        case .success: return
        case .failure(let e): throw e
        }
    }

    /// Pure, testable classification of the credentials-callback response.
    static func parseCallbackOutcome(status: Int, target: String?, hasSessionCookie: Bool) -> LoginOutcome {
        if status == 429 { return .failure(.rateLimited) }
        if status >= 500 { return .failure(.server("Sign-in service unavailable (HTTP \(status)).")) }
        if let target, let comps = URLComponents(string: target),
           let err = comps.queryItems?.first(where: { $0.name == "error" })?.value {
            switch err {
            case "CredentialsSignin": return .failure(.invalidCredentials)
            case "OAuthAccountNotLinked": return .failure(.oauthOnlyAccount)
            default: return .failure(.server("Sign-in failed (\(err))."))
            }
        }
        // No error in the URL: success iff the session cookie actually landed.
        return hasSessionCookie ? .success : .failure(.invalidCredentials)
    }

    // MARK: Sign out

    func signOut() async {
        // Best-effort server-side invalidation; local cookie wipe is what matters.
        if let csrf = try? await fetchCSRFToken() {
            var req = URLRequest(url: baseURL.appendingPathComponent("/api/auth/signout"))
            req.httpMethod = "POST"
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            req.httpBody = Self.formEncode(["csrfToken": csrf, "json": "true"])
            _ = try? await session.data(for: req, delegate: NoRedirectDelegate.shared)
        }
        clearCookies()
    }

    // MARK: Internals

    private struct CSRFResponse: Decodable { let csrfToken: String }
    private struct CallbackJSON: Decodable { let url: String? }

    private func fetchCSRFToken() async throws -> String {
        var req = URLRequest(url: baseURL.appendingPathComponent("/api/auth/csrf"))
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw AuthError.csrfUnavailable }
            return try JSONDecoder().decode(CSRFResponse.self, from: data).csrfToken
        } catch let e as AuthError { throw e } catch { throw AuthError.csrfUnavailable }
    }

    static func formEncode(_ fields: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._*")
        let body = fields
            .sorted { $0.key < $1.key }
            .map { k, v in
                "\(k)=\(v.addingPercentEncoding(withAllowedCharacters: allowed)?.replacingOccurrences(of: "%20", with: "+") ?? "")"
            }
            .joined(separator: "&")
        return Data(body.utf8)
    }
}

/// Stops URLSession from transparently following 3xx so we can inspect the
/// Location header (and its `?error=` query) ourselves.
final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    static let shared = NoRedirectDelegate()
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
