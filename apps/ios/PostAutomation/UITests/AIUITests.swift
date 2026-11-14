import XCTest

/// Live AI checks. Generates text only: never runs an agent action, never
/// publishes or schedules, and deletes the test chat it creates. Needs a
/// signed-in simulator; run alone: -only-testing:PostAutomationUITests/AIUITests
final class AIUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        if app.textFields["login.email"].waitForExistence(timeout: 5) {
            throw XCTSkip("Not signed in — sign in on the simulator first.")
        }
    }

    func testWriteWithAIFillsResult() throws {
        XCTAssertTrue(app.tabBars.buttons["Compose"].waitForExistence(timeout: 30))
        app.tabBars.buttons["Compose"].tap()
        let ai = app.buttons["compose.ai"]
        XCTAssertTrue(ai.waitForExistence(timeout: 10))
        ai.tap()
        let prompt = app.textFields["ai.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        prompt.tap()
        prompt.typeText("A short friendly caption for a neighbourhood coffee shop's morning special")
        app.buttons["ai.generate"].tap()
        let result = app.textViews["ai.result"]
        XCTAssertTrue(result.waitForExistence(timeout: 120), "AI result")
        XCTAssertFalse((result.value as? String ?? "").isEmpty)
        app.buttons["Cancel"].tap()   // don't touch the user's Compose caption
    }

    func testSuperAgentReplies() throws {
        XCTAssertTrue(app.tabBars.buttons["More"].waitForExistence(timeout: 30))
        app.tabBars.buttons["More"].tap()
        app.buttons["Super Agent"].tap()
        let new = app.buttons["agent.new"]
        XCTAssertTrue(new.waitForExistence(timeout: 15))
        new.tap()
        let input = app.textFields["agent.input"]
        if !input.waitForExistence(timeout: 20) { print("DUMP>>> " + app.debugDescription); XCTFail("chat screen didn't open") }
        input.tap()
        input.typeText("UITest: give me two short caption ideas for a coffee shop. Do not schedule or publish anything.")
        app.buttons["agent.send"].tap()
        // The saved reply replaces the stream when it finishes.
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'coffee'")).element(boundBy: 1)
        XCTAssertTrue(reply.waitForExistence(timeout: 180), "assistant reply")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'The reply was interrupted' OR label BEGINSWITH 'Couldn'")).count, 0)

        // Clean up the test chat.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let thread = app.buttons.matching(identifier: "agent.thread").element(matching: NSPredicate(format: "label BEGINSWITH 'UITest'"))
        XCTAssertTrue(thread.waitForExistence(timeout: 15))
        thread.swipeLeft()
        app.buttons["Delete"].tap()
        XCTAssertTrue(thread.waitForNonExistence(timeout: 15))
    }
}
