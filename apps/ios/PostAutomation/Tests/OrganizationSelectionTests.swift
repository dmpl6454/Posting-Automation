import XCTest
@testable import PostAutomation

/// Pure tests for the workspace-selection rules: which org the session pins on
/// sign-in, and the per-user UserDefaults plumbing that remembers a switch. No
/// network — these guard the rule that a stored id is only honoured while it is
/// still one of the user's memberships, and that the fallback is the server's
/// own OWNER-first / oldest-first default (`memberships[0]`).
final class OrganizationSelectionTests: XCTestCase {

    private let acme = Organization(id: "org_acme", name: "Acme Media", plan: "PROFESSIONAL")
    private let beta = Organization(id: "org_beta", name: "Beta Labs", plan: nil)

    /// Ordered the way `user.me` returns them: the owned org first.
    private var memberships: [Membership] {
        [
            Membership(role: "OWNER", organization: acme),
            Membership(role: "MEMBER", organization: beta),
        ]
    }

    // MARK: - resolve(stored:memberships:)

    func testResolvePicksTheStoredOrgWhenItIsAMembership() {
        XCTAssertEqual(OrganizationSelection.resolve(stored: "org_beta", memberships: memberships), beta)
        XCTAssertEqual(OrganizationSelection.resolve(stored: "org_acme", memberships: memberships), acme)
    }

    func testResolveFallsBackToFirstMembershipWhenNothingIsStored() {
        XCTAssertEqual(OrganizationSelection.resolve(stored: nil, memberships: memberships), acme)
    }

    func testResolveFallsBackToFirstMembershipWhenTheStoredOrgIsUnknown() {
        // The user was removed from the stored workspace (or the id belongs to
        // another account): pinning it would make every org-scoped call FORBIDDEN.
        XCTAssertEqual(OrganizationSelection.resolve(stored: "org_gone", memberships: memberships), acme)
        XCTAssertEqual(OrganizationSelection.resolve(stored: "", memberships: memberships), acme)
    }

    func testResolveReturnsNilWithoutMemberships() {
        XCTAssertNil(OrganizationSelection.resolve(stored: nil, memberships: []))
        XCTAssertNil(OrganizationSelection.resolve(stored: "org_acme", memberships: []))
    }

    // MARK: - storageKey(userId:)

    func testStorageKeyIsNamespacedPerUser() {
        XCTAssertEqual(OrganizationSelection.storageKey(userId: "user_1"), "activeOrganizationId.user_1")
        XCTAssertNotEqual(
            OrganizationSelection.storageKey(userId: "user_1"),
            OrganizationSelection.storageKey(userId: "user_2")
        )
    }

    // MARK: - store / load

    func testStoreAndLoadRoundTripThroughUserDefaults() throws {
        let suite = "OrganizationSelectionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertNil(OrganizationSelection.load(userId: "user_1", defaults: defaults))

        OrganizationSelection.store("org_beta", userId: "user_1", defaults: defaults)
        XCTAssertEqual(OrganizationSelection.load(userId: "user_1", defaults: defaults), "org_beta")
        // Per user: another account on the same device sees nothing.
        XCTAssertNil(OrganizationSelection.load(userId: "user_2", defaults: defaults))

        // Overwriting keeps the latest choice.
        OrganizationSelection.store("org_acme", userId: "user_1", defaults: defaults)
        XCTAssertEqual(OrganizationSelection.load(userId: "user_1", defaults: defaults), "org_acme")
    }

    func testStoringNilRemovesTheKey() throws {
        let suite = "OrganizationSelectionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        OrganizationSelection.store("org_beta", userId: "user_1", defaults: defaults)
        XCTAssertNotNil(defaults.object(forKey: OrganizationSelection.storageKey(userId: "user_1")))

        OrganizationSelection.store(nil, userId: "user_1", defaults: defaults)
        XCTAssertNil(OrganizationSelection.load(userId: "user_1", defaults: defaults))
        XCTAssertNil(defaults.object(forKey: OrganizationSelection.storageKey(userId: "user_1")))
    }

    func testStoredValueSurvivesResolveOnlyWhileStillAMembership() throws {
        // The end-to-end rule loadMe applies: store a switch, then resolve it
        // against a membership list that no longer contains it.
        let suite = "OrganizationSelectionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        OrganizationSelection.store("org_beta", userId: "user_1", defaults: defaults)
        let stored = OrganizationSelection.load(userId: "user_1", defaults: defaults)
        XCTAssertEqual(OrganizationSelection.resolve(stored: stored, memberships: memberships), beta)
        XCTAssertEqual(
            OrganizationSelection.resolve(stored: stored, memberships: [Membership(role: "OWNER", organization: acme)]),
            acme
        )
    }
}
