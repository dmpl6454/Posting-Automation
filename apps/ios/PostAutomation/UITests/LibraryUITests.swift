import XCTest

/// Opens Media library, Channel groups, Notifications and the workspace list
/// against the LIVE API — READ-ONLY: never uploads, deletes, edits a group,
/// marks notifications read or switches workspace. Needs a signed-in
/// simulator; run alone: -only-testing:PostAutomationUITests/LibraryUITests
final class LibraryUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        if app.textFields["login.email"].waitForExistence(timeout: 5) {
            throw XCTSkip("Not signed in — sign in on the simulator first.")
        }
    }

    private func noDecodeError(_ place: String) {
        let errors = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Unexpected response' OR label CONTAINS 'Invalid response' OR label CONTAINS 'couldn’t be read'"))
        XCTAssertEqual(errors.count, 0, "decode error on \(place): \(errors.allElementsBoundByIndex.map(\.label))")
    }

    private func openMore(_ row: String) {
        app.tabBars.buttons["More"].tap()
        while app.navigationBars.buttons.element(boundBy: 0).exists && !app.buttons[row].exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        app.buttons[row].tap()
    }

    func testMediaLibraryLoadsAndFilters() throws {
        openMore("Media library")
        let tile = app.buttons["media.tile"].firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 20), "media tiles")
        noDecodeError("Media library")
        app.buttons["Videos"].tap()
        sleep(3)
        noDecodeError("Media library videos")
        // Open one item's detail and close it — no delete.
        if app.buttons["media.tile"].firstMatch.waitForExistence(timeout: 10) {
            app.buttons["media.tile"].firstMatch.tap()
            XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 10), "detail sheet")
            app.buttons["Close"].tap()
        }
    }

    func testChannelGroupsLoad() throws {
        openMore("Channel groups")
        XCTAssertTrue(app.navigationBars["Channel groups"].waitForExistence(timeout: 10))
        sleep(4)
        noDecodeError("Channel groups")
    }

    func testNotificationsLoad() throws {
        openMore("Notifications")
        let row = app.buttons["notification.row"].firstMatch
        let empty = app.staticTexts["No notifications"]
        XCTAssertTrue(row.waitForExistence(timeout: 20) || empty.exists, "notifications or empty state")
        noDecodeError("Notifications")
    }

    func testWorkspacesListed() throws {
        openMore("Account")
        XCTAssertTrue(app.staticTexts["Workspaces"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.images["checkmark"].exists || app.buttons.containing(NSPredicate(format: "label CONTAINS 'checkmark'")).count > 0
                      || app.cells.count > 0, "workspace rows")
    }
}
