import XCTest
@testable import PostAutomation

final class LoginRulesTests: XCTestCase {
    func testNormalizesEmail() {
        XCTAssertEqual(LoginRules.normalizedEmail("  Sudhanshu@DigitalSukoon.com \n"), "sudhanshu@digitalsukoon.com")
    }

    func testExplainsEachProblem() {
        XCTAssertEqual(LoginRules.problem(email: "  ", password: "x"), "Enter your email address.")
        XCTAssertNotNil(LoginRules.problem(email: "sudhanshu", password: "x"), "a username is not an email")
        XCTAssertNotNil(LoginRules.problem(email: "@x.com", password: "x"))
        XCTAssertNotNil(LoginRules.problem(email: "a@b.co", password: ""))
    }

    func testValidInputHasNoProblem() {
        XCTAssertNil(LoginRules.problem(email: " a@b.co ", password: "secret"))
        // A password is sent exactly as typed — spaces can be part of it.
        XCTAssertNil(LoginRules.problem(email: "a@b.co", password: " "))
    }
}
