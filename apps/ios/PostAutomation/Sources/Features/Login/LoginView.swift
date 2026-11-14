import SwiftUI

struct LoginView: View {
    @Environment(SessionStore.self) private var session
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    // The button is NEVER silently disabled: a disabled button with no reason
    // reads as "the app is broken". Problems are explained on tap instead.
    // (On a real iPhone, Password AutoFill can fill the field without
    // updating the SwiftUI binding, which used to leave the button grey.)

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
                            .onSubmit { Task { await submit() } }
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
                    .disabled(submitting)
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
        guard !submitting else { return }
        if let problem = LoginRules.problem(email: email, password: password) {
            error = problem
            focus = LoginRules.normalizedEmail(email).isEmpty || !LoginRules.normalizedEmail(email).contains("@") ? .email : .password
            return
        }
        submitting = true
        error = nil
        session.lastError = nil
        defer { submitting = false }
        do {
            try await session.signIn(email: LoginRules.normalizedEmail(email), password: password)
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

/// Pure, unit-tested sign-in checks.
enum LoginRules {
    /// Trimmed and lowercased — keyboards and AutoFill add trailing spaces, and
    /// the server stores emails lowercased.
    static func normalizedEmail(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Why sign-in can't be attempted yet, or nil.
    static func problem(email: String, password: String) -> String? {
        let e = normalizedEmail(email)
        if e.isEmpty { return "Enter your email address." }
        if !e.contains("@") || e.hasPrefix("@") || e.hasSuffix("@") {
            return "Sign in with the email address of your PostAutomation account (not a username or phone number)."
        }
        if password.isEmpty {
            return "Enter your password. If you used AutoFill, tap the password field and type it in."
        }
        return nil
    }
}
