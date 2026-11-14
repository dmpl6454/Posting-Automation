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
    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "house") }
            PostsView()
                .tabItem { Label("Posts", systemImage: "doc.text") }
            ComposeView()
                .tabItem { Label("Compose", systemImage: "square.and.pencil") }
            InsightsView()
                .tabItem { Label("Insights", systemImage: "chart.bar") }
            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
        }
        // A workspace switch rebuilds every tab, so nothing from the previous
        // workspace stays on screen.
        .id(session.activeOrganization?.id ?? "none")
    }
}

/// The fifth tab: everything that doesn't fit in the tab bar. Later phases
/// (Comments, Messages, Media…) add their rows here.
struct MoreView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { NotificationsView() } label: { Label("Notifications", systemImage: "bell") }
                    NavigationLink { MediaLibraryView() } label: { Label("Media library", systemImage: "photo.on.rectangle") }
                    NavigationLink { ChannelGroupsView() } label: { Label("Channel groups", systemImage: "square.stack.3d.up") }
                }
                Section {
                    NavigationLink { CommentsInboxView() } label: { Label("Comments", systemImage: "bubble.left.and.bubble.right") }
                    NavigationLink { MentionsView() } label: { Label("Mentions", systemImage: "at") }
                    NavigationLink { MessagesView() } label: { Label("Messages", systemImage: "envelope") }
                }
                NavigationLink { ChannelsView(embedded: true) } label: {
                    Label("Channels", systemImage: "antenna.radiowaves.left.and.right")
                }
                NavigationLink { ReportsView() } label: {
                    Label("Reports", systemImage: "tablecells")
                }
                NavigationLink { AccountView(embedded: true) } label: {
                    Label("Account", systemImage: "person.crop.circle")
                }
            }
            .navigationTitle("More")
        }
    }
}

/// A NavigationStack unless the view is pushed inside someone else's.
struct MaybeNavigationStack<Content: View>: View {
    let embedded: Bool
    @ViewBuilder let content: () -> Content
    var body: some View {
        if embedded { content() } else { NavigationStack { content() } }
    }
}

struct AccountView: View {
    var embedded = false
    @Environment(SessionStore.self) private var session
    @State private var signingOut = false

    var body: some View {
        MaybeNavigationStack(embedded: embedded) {
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
                                Button {
                                    session.switchOrganization(to: m.organization)
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading) {
                                            Text(m.organization.name).foregroundStyle(.primary)
                                            Text(m.role.capitalized).font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        if m.organization.id == session.activeOrganization?.id {
                                            Image(systemName: "checkmark").foregroundStyle(.tint)
                                        }
                                    }
                                }
                                .accessibilityIdentifier("workspace.\(m.organization.name)")
                            }
                        } header: {
                            Text("Workspaces")
                        } footer: {
                            if user.memberships.count > 1 { Text("Tap a workspace to switch. Every tab reloads with its posts, channels and insights.") }
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
