import SwiftUI

@main
struct PostAutomationApp: App {
    @State private var session = SessionStore()

    init() {
        // UI tests pass `--reset-session` so they always start on the login
        // screen, regardless of whether a real session cookie is persisted from
        // a previous manual run on the same simulator.
        if CommandLine.arguments.contains("--reset-session") {
            AuthService.shared.clearCookies()
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .task { await session.bootstrap() }
        }
    }
}

struct RootView: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        switch session.state {
        case .loading:
            ProgressView("Loading…")
                .accessibilityIdentifier("root.loading")
        case .signedOut:
            LoginView()
                .transition(.opacity)
        case .signedIn:
            RootTabView()
                .transition(.opacity)
        }
    }
}

struct RootTabView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "house") }
                // Unread notifications live behind the Home bell; `badge(0)`
                // renders nothing, so a clean inbox shows a plain tab.
                .badge(session.unreadNotifications)
            PostsView()
                .tabItem { Label("Posts", systemImage: "doc.text") }
            ComposeView()
                .tabItem { Label("Compose", systemImage: "square.and.pencil") }
            ChannelsView()
                .tabItem { Label("Channels", systemImage: "antenna.radiowaves.left.and.right") }
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .onChange(of: scenePhase) { _, newPhase in
            // Coming back to the foreground: the worker may have written publish
            // outcomes while the app was suspended, and the badge is the only
            // thing on screen that would not otherwise notice.
            guard newPhase == .active, session.state == .signedIn else { return }
            Task { await session.refreshUnreadCount() }
        }
    }
}

struct AccountView: View {
    @Environment(SessionStore.self) private var session
    @State private var signingOut = false
    /// The workspace a switch is in flight for. Non-nil disables every row so a
    /// second tap cannot race the first one's header re-pin and refresh.
    @State private var switchingTo: String?

    var body: some View {
        NavigationStack {
            List {
                if let user = session.user {
                    Section("Signed in as") {
                        LabeledContent("Name", value: user.name ?? "—")
                        LabeledContent("Email", value: user.email)
                        if let role = user.appRole { LabeledContent("Access", value: role.capitalized) }
                    }
                    if !user.memberships.isEmpty {
                        Section {
                            ForEach(user.memberships, id: \.organization.id) { m in
                                WorkspaceChooserRow(
                                    membership: m,
                                    isActive: m.organization.id == session.activeOrganizationId,
                                    isSwitching: switchingTo == m.organization.id
                                ) {
                                    switchingTo = m.organization.id
                                    Task {
                                        await session.switchOrganization(to: m.organization.id)
                                        switchingTo = nil
                                    }
                                }
                                .disabled(switchingTo != nil)
                                .accessibilityIdentifier("account.workspace." + m.organization.id)
                            }
                        } header: {
                            Text("Workspaces")
                        } footer: {
                            Text("Posts, channels and notifications are scoped to the selected workspace.")
                        }
                    }
                }
                Section {
                    Button(role: .destructive) {
                        signingOut = true
                        Task { await session.signOut(); signingOut = false }
                    } label: {
                        HStack { Text("Sign Out"); if signingOut { Spacer(); ProgressView() } }
                    }
                    .disabled(signingOut)
                }
                Section {
                    LabeledContent("API", value: APIConfig.baseURL.host ?? "")
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                }
                .font(.footnote)
            }
            .navigationTitle("Account")
        }
    }
}

/// One membership in the Workspaces chooser: name, role, and a checkmark on the
/// active workspace (a spinner while a switch to this one is in flight).
private struct WorkspaceChooserRow: View {
    let membership: Membership
    let isActive: Bool
    let isSwitching: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(membership.organization.name)
                        .foregroundStyle(.primary)
                    Text(membership.role.capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if isSwitching {
                    ProgressView()
                } else if isActive {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Active workspace")
                }
            }
            // The Spacer is not hittable on its own: without this a tap on the
            // empty right half of the row would do nothing.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
