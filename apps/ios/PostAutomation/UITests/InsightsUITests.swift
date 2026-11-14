import XCTest

/// Opens Insights and Reports against the LIVE API — read-only (never taps
/// Sync now or Email). Proves the real payloads decode and render. Needs a
/// signed-in simulator; run alone (LoginUITests signs the simulator out):
///   -only-testing:PostAutomationUITests/InsightsUITests
final class InsightsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        if app.textFields["login.email"].waitForExistence(timeout: 5) {
            throw XCTSkip("Not signed in — sign in on the simulator first.")
        }
    }

    private func noErrorShown(_ where_: String) {
        let errors = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Unexpected response' OR label CONTAINS 'Invalid response' OR label BEGINSWITH 'Request failed'"))
        XCTAssertEqual(errors.count, 0, "an error is shown on \(where_): \(errors.allElementsBoundByIndex.map(\.label))")
    }

    func testInsightsAndReportsLoadRealData() throws {
        app.tabBars.buttons["Insights"].tap()
        XCTAssertTrue(app.staticTexts["Posts created"].waitForExistence(timeout: 20), "overview tiles")
        XCTAssertTrue(app.staticTexts["Engagement rate"].waitForExistence(timeout: 20), "engagement tiles")
        noErrorShown("Insights")

        // 90 days, then open the first channel's detail.
        app.buttons["90 days"].tap()
        XCTAssertTrue(app.staticTexts["Posts created"].waitForExistence(timeout: 20))
        var swipes = 0
        while !app.staticTexts["CHANNEL PERFORMANCE"].exists && !app.staticTexts["Channel performance"].exists && swipes < 6 {
            app.swipeUp(); swipes += 1
        }
        let firstChannel = app.cells.containing(NSPredicate(format: "label CONTAINS 'Posts'")).firstMatch
        if firstChannel.waitForExistence(timeout: 10) {
            firstChannel.tap()
            XCTAssertTrue(app.staticTexts["Posts sent"].waitForExistence(timeout: 10), "channel detail")
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        noErrorShown("Insights (90 days)")

        // Reports.
        app.tabBars.buttons["More"].tap()
        app.buttons["Reports"].tap()
        let header = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'row' OR label == 'No posts in this window.'")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 20), "report rows or the empty message")
        app.buttons["30d"].tap()
        XCTAssertTrue(header.waitForExistence(timeout: 20))
        noErrorShown("Reports")
    }
}
