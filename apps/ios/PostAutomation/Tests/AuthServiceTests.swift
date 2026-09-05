import XCTest
@testable import PostAutomation

final class AuthServiceTests: XCTestCase {

    // Auth.js `signIn(..., {redirect:false})` answers 200 {"url": ".../login?error=CredentialsSignin&code=credentials"}
    func testBadPasswordIsInvalidCredentials() {
        let outcome = AuthService.parseCallbackOutcome(
            status: 200,
            target: "https://postautomation.co.in/login?error=CredentialsSignin&code=credentials",
            hasSessionCookie: false
        )
        XCTAssertEqual(outcome, .failure(.invalidCredentials))
    }

    func testSuccessRequiresSessionCookie() {
        // A clean redirect target but no cookie landed → treat as failure, never as signed in.
        XCTAssertEqual(
            AuthService.parseCallbackOutcome(status: 200, target: "https://postautomation.co.in/dashboard", hasSessionCookie: false),
            .failure(.invalidCredentials)
        )
        XCTAssertEqual(
            AuthService.parseCallbackOutcome(status: 200, target: "https://postautomation.co.in/dashboard", hasSessionCookie: true),
            .success
        )
    }

    func testHandles302WithLocation() {
        XCTAssertEqual(
            AuthService.parseCallbackOutcome(status: 302, target: "/login?error=CredentialsSignin", hasSessionCookie: false),
            .failure(.invalidCredentials)
        )
        XCTAssertEqual(
            AuthService.parseCallbackOutcome(status: 302, target: "/dashboard", hasSessionCookie: true),
            .success
        )
    }

    func testOAuthOnlyAccountIsExplained() {
        let outcome = AuthService.parseCallbackOutcome(
            status: 200, target: "https://postautomation.co.in/login?error=OAuthAccountNotLinked", hasSessionCookie: false
        )
        XCTAssertEqual(outcome, .failure(.oauthOnlyAccount))
    }

    func testRateLimitAndServerErrors() {
        XCTAssertEqual(AuthService.parseCallbackOutcome(status: 429, target: nil, hasSessionCookie: false), .failure(.rateLimited))
        if case .failure(.server) = AuthService.parseCallbackOutcome(status: 502, target: nil, hasSessionCookie: false) {} else {
            XCTFail("Expected server error for 502")
        }
    }

    func testFormEncodingMatchesBrowser() {
        let body = String(decoding: AuthService.formEncode([
            "email": "a+b@example.com",
            "password": "p@ss word&more",
            "json": "true",
        ]), as: UTF8.self)
        // Sorted keys, application/x-www-form-urlencoded escaping, spaces → '+'
        XCTAssertEqual(body, "email=a%2Bb%40example.com&json=true&password=p%40ss+word%26more")
    }

    func testSessionCookieDetectionUsesIsolatedStorage() {
        let storage = HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: "test.\(UUID().uuidString)")
        let svc = AuthService(cookieStorage: storage)
        XCTAssertFalse(svc.hasSessionCookie)

        let cookie = HTTPCookie(properties: [
            .name: "__Secure-authjs.session-token",
            .value: "abc",
            .domain: APIConfig.baseURL.host!,
            .path: "/",
            .secure: "TRUE",
        ])!
        storage.setCookie(cookie)
        XCTAssertTrue(svc.hasSessionCookie)

        svc.clearCookies()
        XCTAssertFalse(svc.hasSessionCookie)
    }
}
