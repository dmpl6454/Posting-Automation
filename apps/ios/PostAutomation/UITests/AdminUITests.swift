import XCTest

/// Opens every admin screen against the LIVE API — READ-ONLY: never changes a
/// role, plan, ban or Meta app, never retries/deletes a job, never resolves an
/// error. Needs a signed-in SUPER ADMIN; run alone:
///   -only-testing:PostAutomationUITests/AdminUITests
final class AdminUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        if app.textFields["login.email"].waitForExistence(timeout: 5) { throw XCTSkip("Not signed in.") }
        XCTAssertTrue(app.tabBars.buttons["More"].waitForExistence(timeout: 30))
        app.tabBars.buttons["More"].tap()
        if !app.buttons["Admin"].waitForExistence(timeout: 10) { throw XCTSkip("Signed-in user isn't a super admin.") }
        app.buttons["Admin"].tap()
        XCTAssertTrue(app.staticTexts["Users"].waitForExistence(timeout: 20), "overview loaded")
    }

    private func noErrors(_ place: String) {
        let bad = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Unexpected response' OR label CONTAINS 'Invalid response' OR label CONTAINS 'couldn’t be read' OR label CONTAINS 'FORBIDDEN'"))
        XCTAssertEqual(bad.count, 0, "\(place): \(bad.allElementsBoundByIndex.map(\.label))")
    }

    private func open(_ row: String, expect: XCUIElement, _ check: () -> Void = {}) {
        app.buttons[row].tap()
        XCTAssertTrue(expect.waitForExistence(timeout: 25), "\(row) loaded")
        noErrors(row)
        check()
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    func testEveryAdminScreenLoads() throws {
        noErrors("Overview")
        open("Users", expect: app.cells.element(boundBy: 1)) {
            app.cells.element(boundBy: 1).tap()
            XCTAssertTrue(app.staticTexts["Email"].waitForExistence(timeout: 15), "user detail")
            noErrors("User detail")
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        open("Organizations", expect: app.cells.element(boundBy: 1)) {
            app.cells.element(boundBy: 1).tap()
            XCTAssertTrue(app.staticTexts["Members"].waitForExistence(timeout: 15), "org detail")
            noErrors("Org detail")
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        open("Queues", expect: app.staticTexts["Failed jobs"].firstMatch)
        open("Error monitoring", expect: app.staticTexts["Unresolved"].firstMatch)
        open("Audit log", expect: app.cells.element(boundBy: 1))
    }
}
