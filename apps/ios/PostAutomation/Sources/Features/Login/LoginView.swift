import SwiftUI

struct LoginView: View {
    @Environment(SessionStore.self) private var session
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    private var canSubmit: Bool {
        email.contains("@") && !password.isEmpty && !submitting
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 8) {
                        Image(systemName: "paperplane.circle.fill")
                            .font(.system(size: 56))
                            .foregroundStyle(.tint)
                            .padding(.top, 40)
                        Text("PostAutomation")
                            .font(.largeTitle.weight(.bold))
                        Text("Sign in to manage your social posts")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 12) {
                        TextField("Email", text: $email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focus = .password }
                            .fieldStyle()
                            .accessibilityIdentifier("login.email")

                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .focused($focus, equals: .password)
                            .submitLabel(.go)
                            .onSubmit { if canSubmit { Task { await submit() } } }
                            .fieldStyle()
                            .accessibilityIdentifier("login.password")
                    }

                    if let message = error ?? session.lastError {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("login.error")
                    }

                    Button {
                        Task { await submit() }
                    } label: {
                        Group {
                            if submitting { ProgressView().tint(.white) } else { Text("Sign In").fontWeight(.semibold) }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 22)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("login.submit")

                    Text("Google sign-in isn't available in the app yet. If you signed up with Google, set a password from the web dashboard first.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                .padding(.horizontal, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func submit() async {
        submitting = true
        error = nil
        session.lastError = nil
        defer { submitting = false }
        do {
            try await session.signIn(email: email, password: password)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private extension View {
    func fieldStyle() -> some View {
        self
            .padding(14)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
