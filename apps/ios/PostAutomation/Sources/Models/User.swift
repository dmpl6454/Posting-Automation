import Foundation

// `user.me` returns the Prisma User row (minus `password`, plus `hasPassword`)
// with `memberships` ordered OWNER-first / oldest-first — memberships[0] is the
// same default org the server picks when no x-organization-id header is sent.

struct Organization: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let plan: String?
}

struct Membership: Decodable, Hashable {
    let role: String            // OWNER | ADMIN | MEMBER
    let organization: Organization
}

struct User: Decodable, Hashable, Identifiable {
    let id: String
    let email: String
    let name: String?
    let image: String?
    let isSuperAdmin: Bool?
    let appRole: String?        // USER | ADMIN
    let hasPassword: Bool?
    let memberships: [Membership]

    var firstName: String {
        if let name, let first = name.split(separator: " ").first { return String(first) }
        return email.split(separator: "@").first.map(String.init) ?? "there"
    }

    var defaultOrganization: Organization? { memberships.first?.organization }
}
