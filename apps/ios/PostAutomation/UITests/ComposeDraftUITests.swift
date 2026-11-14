import XCTest

/// Drives the real Compose screen against the LIVE API and saves a DRAFT —
/// nothing is published. Needs a signed-in session already in the simulator
/// (it skips otherwise), so run it on its own:
///   xcodebuild test ... -only-testing:PostAutomationUITests/ComposeDraftUITests
/// ⚠️ Never in the same run as LoginUITests: that one launches with
/// `--reset-session`, which signs the simulator out.
final class ComposeDraftUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        if app.textFields["login.email"].waitForExistence(timeout: 5) {
            throw XCTSkip("Not signed in — sign in on the simulator first.")
        }
    }

    /// Opens the channel sheet, searches, and taps the result — with the search
    /// keyboard UP, which is exactly the case that used to swallow the tap.
    private func pickChannel(named name: String, selectedAfter count: Int) {
        let choose = app.buttons["compose.chooseChannels"]
        choose.scrollToVisible(in: app)
        choose.tap()
        let search = app.searchFields["Search channels"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText(name)
        let row = app.buttons.matching(
            NSPredicate(format: "identifier == 'compose.channel' AND label BEGINSWITH %@", name)
        ).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "row for \(name)")
        row.tap()
        let selectedNow = expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: row)
        XCTAssertEqual(XCTWaiter().wait(for: [selectedNow], timeout: 5), .completed,
                       "tapping \(name) in the search results must select it on the first tap")
        XCTAssertTrue(app.navigationBars["\(count) selected"].waitForExistence(timeout: 3))
        app.buttons["channelPicker.done"].tap()
    }

    /// The Compose keyboard toolbar's Done — the keyboard otherwise covers the
    /// next control, exactly as it would for a person.
    private func closeKeyboard() {
        let done = app.buttons["Done"].firstMatch
        if done.waitForExistence(timeout: 2) { done.tap() }
    }

    func testSaveDraftWithFirstCommentsYouTubeAndCampaign() throws {
        app.tabBars.buttons["Compose"].tap()

        let caption = app.textViews["compose.caption"]
        XCTAssertTrue(caption.waitForExistence(timeout: 10))
        caption.tap()
        caption.typeText("UITest draft - please ignore")
        closeKeyboard()

        pickChannel(named: "doosra.thefilm", selectedAfter: 1)
        pickChannel(named: "SudhaNshu", selectedAfter: 2)

        let first = app.textFields["#hashtags #go #here"]
        first.scrollToVisible(in: app)
        first.tap()
        first.typeText("#uitest one")
        closeKeyboard()
        app.buttons["Add another comment"].tap()
        let second = app.textFields["Another comment"]
        second.tap()
        second.typeText("uitest two")
        closeKeyboard()

        let title = app.textFields["Video title (defaults to the start of the caption)"]
        title.scrollToVisible(in: app)
        title.tap()
        title.typeText("UITest title")
        closeKeyboard()

        let campaign = app.textFields["e.g. Diwali 2026"]
        campaign.scrollToVisible(in: app)
        campaign.tap()
        campaign.typeText("UITest campaign")
        closeKeyboard()

        app.buttons["Save Draft"].tap()
        XCTAssertTrue(app.staticTexts["Draft saved"].waitForExistence(timeout: 15))
    }
}

extension XCUIElement {
    /// Swipe the form until this element is on screen and hittable.
    func scrollToVisible(in app: XCUIApplication, maxSwipes: Int = 15) {
        var swipes = 0
        while !(exists && isHittable) && swipes < maxSwipes {
            app.swipeUp(velocity: .slow)
            swipes += 1
        }
    }
}
