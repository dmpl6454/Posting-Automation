import SwiftUI

/// Account → Delete Account (App Store guideline 5.1.1(v)). Calls
/// `user.deleteAccount`, which closes the account immediately; on success the
/// app signs out. Needs the password (when the account has one) and the word
/// DELETE, so it can't happen by accident.
struct DeleteAccountView: View {
    @Environment(SessionStore.self) private var session
    @State private var password = ""
    @State private var confirm = ""
    @State private var deleting = false
    @State private var error: String?
    @State private var asking = false

    private var hasPassword: Bool { session.user?.hasPassword ?? true }
    private var ready: Bool { confirm == "DELETE" && (!hasPassword || !password.isEmpty) && !deleting }

    var body: some View {
        Form {
            Section {
                Text("This permanently closes your account and signs you out everywhere.")
                Label("Workspaces only you use are shut down: their channels are disconnected and scheduled posts are cancelled. Their posts and media are deleted within 30 days.", systemImage: "trash")
                Label("You leave any workspaces you share with others.", systemImage: "person.2")
            }
            .font(.subheadline)
            if hasPassword {
                Section("Password") {
                    SecureField("Your password", text: $password)
                        .textContentType(.password)
                        .accessibilityIdentifier("delete.password")
                }
            }
            Section {
                TextField("Type DELETE", text: $confirm)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("delete.confirm")
            } header: { Text("Confirm") }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            Section {
                Button(role: .destructive) { asking = true } label: {
                    HStack { Text("Delete Account"); if deleting { Spacer(); ProgressView() } }
                }
                .disabled(!ready)
                .accessibilityIdentifier("delete.submit")
            } footer: {
                Text("Questions? support@postautomation.co.in")
            }
        }
        .navigationTitle("Delete Account")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete your account? This can't be undone.", isPresented: $asking, titleVisibility: .visible) {
            Button("Delete Account", role: .destructive) { Task { await delete() } }
        }
    }

    private struct Input: Encodable { var password: String?; let confirm: String }
    private struct Output: Decodable { let success: Bool }

    private func delete() async {
        deleting = true
        error = nil
        defer { deleting = false }
        do {
            let _: Output = try await TRPCClient.shared.mutate("user.deleteAccount",
                input: Input(password: hasPassword ? password : nil, confirm: "DELETE"))
            await session.signOut()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
