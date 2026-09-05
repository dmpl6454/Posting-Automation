import XCTest

/// End-to-end UI test against the LIVE auth endpoint.
///
/// Uses deliberately fake credentials (`example.invalid` is an IETF-reserved
/// domain that can never resolve to a real account), so this performs exactly
/// one failed sign-in against production per run — the same as a user typo —
/// and never touches real credentials. It exercises the full path:
/// CSRF fetch → credentials callback → `?error=CredentialsSignin` parsing →
/// inline error rendering.
final class LoginUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["--reset-session"]
        app.launch()
    }

    func testLoginScreenAppearsWithDisabledSubmit() {
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10), "Login screen should appear when signed out")
        XCTAssertTrue(app.secureTextFields["login.password"].exists)
        let submit = app.buttons["login.submit"]
        XCTAssertTrue(submit.exists)
        XCTAssertFalse(submit.isEnabled, "Sign In must be disabled until both fields are filled")
    }

    func testWrongCredentialsShowInlineError() {
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("uitest-nobody@example.invalid")

        let password = app.secureTextFields["login.password"]
        password.tap()
        password.typeText("definitely-not-a-real-password")

        let submit = app.buttons["login.submit"]
        XCTAssertTrue(submit.isEnabled, "Sign In should enable once both fields are filled")
        submit.tap()

        // Network round-trip to production: allow generous time.
        let errorText = app.staticTexts["Invalid email or password."]
        XCTAssertTrue(errorText.waitForExistence(timeout: 30), "Expected the invalid-credentials error to render")

        // We must still be on the login screen (never signed in).
        XCTAssertTrue(email.exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists, "Tab bar must not appear after a failed sign-in")
    }
}
