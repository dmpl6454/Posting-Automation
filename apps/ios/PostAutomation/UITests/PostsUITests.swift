import XCTest

/// Drives the Posts tab and post page against the LIVE API using ONLY the
/// "UITest draft" created by ComposeDraftUITests: edit its caption, archive and
/// unarchive it, open the calendar. Never publishes or deletes. Needs a
/// signed-in simulator; run alone (LoginUITests signs the simulator out):
///   -only-testing:PostAutomationUITests/PostsUITests
final class PostsUITests: XCTestCase {
    private var app: XCUIApplication!
    private let original = "UITest draft - please ignore"
    private let edited = "UITest draft - edited - please ignore"

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        if app.textFields["login.email"].waitForExistence(timeout: 5) {
            throw XCTSkip("Not signed in — sign in on the simulator first.")
        }
    }

    private func text(_ s: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label == %@", s)).firstMatch
    }

    private func openDraftsList() {
        app.tabBars.buttons["Posts"].tap()
        let drafts = app.buttons["Draft"].firstMatch
        XCTAssertTrue(drafts.waitForExistence(timeout: 10))
        drafts.tap()
    }

    func testEditArchiveUnarchiveAndCalendar() throws {
        openDraftsList()
        // Either the original caption or one an earlier run already edited.
        let cell = app.buttons.matching(NSPredicate(format: "label CONTAINS 'UITest draft'")).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 15), "the UITest draft should be in Drafts")
        cell.tap()

        XCTAssertTrue(app.staticTexts["Channels (2)"].waitForExistence(timeout: 10), "post page shows its 2 channels")

        // Edit the caption.
        app.buttons["Post actions"].tap()
        app.buttons["Edit"].tap()
        let editor = app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        editor.typeText(edited)
        app.buttons["Save"].tap()
        XCTAssertTrue(text(edited).waitForExistence(timeout: 10), "the post page shows the edited caption")

        // Archive, then find it under Archived and unarchive.
        app.buttons["Post actions"].tap()
        app.buttons["Archive"].tap()
        let ok = app.alerts.buttons["OK"]
        XCTAssertTrue(ok.waitForExistence(timeout: 10))
        ok.tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["Sort and archived"].tap()
        app.buttons["Show archived"].tap()
        let archivedCell = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", edited)).firstMatch
        XCTAssertTrue(archivedCell.waitForExistence(timeout: 10), "archived post is listed under Archived")
        archivedCell.swipeLeft()
        app.buttons["Unarchive"].tap()
        XCTAssertTrue(archivedCell.waitForNonExistence(timeout: 10), "unarchived post leaves the Archived list")

        // Calendar.
        app.buttons["Sort and archived"].tap()
        app.buttons["Show archived"].tap()
        app.buttons["Calendar"].tap()
        XCTAssertTrue(app.buttons["Previous month"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Next month"].exists)
    }
}
