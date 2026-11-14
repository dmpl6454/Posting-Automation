import XCTest

/// Opens the Comments, Mentions and Messages inboxes against the LIVE API —
/// READ-ONLY: never replies, likes, hides, deletes or sends (those act
/// publicly on Facebook/Instagram). Needs a signed-in simulator; run alone:
///   -only-testing:PostAutomationUITests/InboxUITests
final class InboxUITests: XCTestCase {
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
        let errors = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Unexpected response' OR label CONTAINS 'Invalid response'"))
        XCTAssertEqual(errors.count, 0, "decode error on \(place): \(errors.allElementsBoundByIndex.map(\.label))")
    }

    private func openMore(_ row: String) {
        app.tabBars.buttons["More"].tap()
        // Back to More's root if a previous step left something pushed.
        while app.navigationBars.buttons.element(boundBy: 0).exists && !app.buttons[row].exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        app.buttons[row].tap()
    }

    func testCommentsThreadLoads() throws {
        openMore("Comments")
        let account = app.cells.containing(NSPredicate(format: "label CONTAINS ' post'")).firstMatch
        XCTAssertTrue(account.waitForExistence(timeout: 20), "accounts list")
        noDecodeError("Comments accounts")
        // An account that has published posts, so there is a thread to open.
        let withPosts = app.cells.containing(NSPredicate(format: "label MATCHES '.*· [1-9][0-9]* posts?.*'")).firstMatch
        XCTAssertTrue(withPosts.waitForExistence(timeout: 10), "an account with published posts")
        withPosts.tap()
        let post = app.cells.firstMatch
        XCTAssertTrue(post.waitForExistence(timeout: 20), "posts list")
        noDecodeError("Comments posts")
        post.tap()
        let loaded = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'comment' OR label ENDSWITH 'comments' OR label == 'COMMENTS' OR label == 'Comments' OR label == 'No comments yet.'")).firstMatch
        XCTAssertTrue(loaded.waitForExistence(timeout: 25), "thread loaded")
        noDecodeError("Comment thread")
    }

    func testMentionsLoad() throws {
        openMore("Mentions")
        let state = app.staticTexts.matching(NSPredicate(format: "label == 'No open mentions.' OR label BEGINSWITH '@'")).firstMatch
        XCTAssertTrue(state.waitForExistence(timeout: 20))
        app.buttons["All"].tap()
        noDecodeError("Mentions")
    }

    func testMessagesConversationsLoad() throws {
        openMore("Messages")
        let account = app.cells.firstMatch
        XCTAssertTrue(account.waitForExistence(timeout: 20), "messaging accounts")
        noDecodeError("Messages accounts")
        account.tap()
        let state = app.staticTexts.matching(NSPredicate(format: "label == 'No conversations.' OR label BEGINSWITH 'Messages aren' OR label CONTAINS[c] 'couldn'")).firstMatch
        let anyConversation = app.cells.firstMatch
        XCTAssertTrue(state.waitForExistence(timeout: 25) || anyConversation.waitForExistence(timeout: 5), "conversations or a clear state")
        noDecodeError("Conversations")
    }
}
