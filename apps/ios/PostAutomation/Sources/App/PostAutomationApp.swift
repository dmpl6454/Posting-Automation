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
    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "house") }
            PostsView()
                .tabItem { Label("Posts", systemImage: "doc.text") }
            ComposeView()
                .tabItem { Label("Compose", systemImage: "square.and.pencil") }
            ChannelsView()
                .tabItem { Label("Channels", systemImage: "antenna.radiowaves.left.and.right") }
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
    }
}

struct AccountView: View {
    @Environment(SessionStore.self) private var session
    @State private var signingOut = false

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
                        Section("Workspaces") {
                            ForEach(user.memberships, id: \.organization.id) { m in
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(m.organization.name)
                                        Text(m.role.capitalized).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if m.organization.id == user.defaultOrganization?.id {
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                            }
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
