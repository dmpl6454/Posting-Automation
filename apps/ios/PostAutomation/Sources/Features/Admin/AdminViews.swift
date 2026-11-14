import SwiftUI

private struct Ignored: Decodable {}
private struct IdInput: Encodable { let id: String }

/// A dismissible alert driven by an optional string.
private extension View {
    func noticeAlert(_ text: Binding<String?>) -> some View {
        alert(text.wrappedValue ?? "", isPresented: Binding(get: { text.wrappedValue != nil }, set: { if !$0 { text.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }
}

// MARK: Home

/// The web's /admin, for super admins. Hidden for everyone else, and every
/// call is `superAdminProcedure`, so the server refuses non-admins anyway.
struct AdminHomeView: View {
    @State private var overview: AdminOverview?
    @State private var errors: ErrorStats?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if let o = overview {
                Section("Platform") {
                    LabeledContent("Users", value: "\(o.users)")
                    LabeledContent("Organizations", value: "\(o.organizations)")
                    LabeledContent("Channels", value: "\(o.channels)")
                    LabeledContent("Agents", value: "\(o.agents)")
                    ForEach(o.posts.keys.sorted(), id: \.self) { k in
                        LabeledContent("Posts · " + k.capitalized, value: "\(o.posts[k] ?? 0)")
                    }
                }
            }
            Section {
                NavigationLink { AdminUsersView() } label: { Label("Users", systemImage: "person.2") }
                NavigationLink { AdminOrgsView() } label: { Label("Organizations", systemImage: "building.2") }
                NavigationLink { AdminQueuesView() } label: {
                    HStack {
                        Label("Queues", systemImage: "tray.full")
                        Spacer()
                        let failed = AdminRules.queueRows(overview?.queueHealth ?? [:]).map(\.failed).reduce(0, +)
                        if failed > 0 { Text("\(failed) failed").font(.caption).foregroundStyle(.red) }
                    }
                }
                NavigationLink { MonitoringView() } label: {
                    HStack {
                        Label("Error monitoring", systemImage: "exclamationmark.triangle")
                        Spacer()
                        if let n = errors?.unresolved, n > 0 { Text("\(n) open").font(.caption).foregroundStyle(.orange) }
                    }
                }
                NavigationLink { AuditLogView() } label: { Label("Audit log", systemImage: "list.bullet.rectangle") }
            } footer: {
                Text("Impersonation, deleting users or organizations, and agent/channel/media admin stay on the web.")
            }
        }
        .navigationTitle("Admin")
        .refreshable { await load() }
        .task { await load() }
        .overlay { if overview == nil && error == nil { ProgressView() } }
    }

    private func load() async {
        do {
            async let o: AdminOverview = TRPCClient.shared.query("admin.overview.stats")
            async let e: ErrorStats = TRPCClient.shared.query("monitor.stats")
            overview = try await o
            errors = try? await e
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: Users

struct AdminUsersView: View {
    @State private var search = ""
    @State private var users: [AdminUser] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            ForEach(users) { u in
                NavigationLink { AdminUserDetailView(user: u) { updated in
                    if let i = users.firstIndex(where: { $0.id == updated.id }) { users[i] = updated }
                } } label: { row(u) }
            }
            if nextCursor != nil { HStack { Spacer(); ProgressView(); Spacer() }.onAppear { Task { await load(more: true) } } }
        }
        .navigationTitle("Users")
        .searchable(text: $search, prompt: "Name or email")
        .textInputAutocapitalization(.never)
        .task(id: search) {
            if !search.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            if !Task.isCancelled { await load(more: false) }
        }
        .refreshable { await load(more: false) }
        .overlay { if loading && users.isEmpty { ProgressView() } }
    }

    private func row(_ u: AdminUser) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(u.display).lineLimit(1)
                if u.isSuperAdmin { adminBadge("Super admin", .purple) }
                else if u.appRole == "ADMIN" { adminBadge("Admin", .blue) }
                if u.isBanned { adminBadge("Banned", .red) }
            }
            Text(u.email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private struct ListInput: Encodable { let limit: Int; var cursor: String?; var search: String? }

    private func load(more: Bool) async {
        if more && loading { return }
        loading = true
        defer { loading = false }
        let q = search.trimmingCharacters(in: .whitespaces)
        do {
            let p: AdminPage<AdminUser> = try await TRPCClient.shared.query("admin.users.list",
                input: ListInput(limit: 30, cursor: more ? nextCursor : nil, search: q.isEmpty ? nil : q))
            users = more ? users + p.items : p.items
            nextCursor = p.nextCursor
            error = nil
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }
}

func adminBadge(_ text: String, _ color: Color) -> some View {
    Text(text).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2)
        .background(color.opacity(0.15), in: Capsule()).foregroundStyle(color)
}

struct AdminUserDetailView: View {
    @Environment(SessionStore.self) private var session
    @State var user: AdminUser
    let onChange: (AdminUser) -> Void
    @State private var detail: AdminUserDetail?
    @State private var busy = false
    @State private var notice: String?
    @State private var confirm: Action?

    enum Action: Identifiable { case ban, superAdmin; var id: Int { hashValue } }

    private var me: String? { session.user?.id }

    var body: some View {
        Form {
            Section {
                LabeledContent("Email", value: user.email)
                if let d = user.createdAt { LabeledContent("Joined", value: d.formatted(date: .abbreviated, time: .omitted)) }
            }
            Section {
                Picker("Access", selection: Binding(get: { user.appRole ?? "USER" }, set: { new in Task { await setRole(new) } })) {
                    Text("User").tag("USER"); Text("Admin").tag("ADMIN")
                }
                .disabled(busy || !AdminRules.appRoleEditable(user))
            } header: { Text("Access") } footer: {
                Text(user.isSuperAdmin ? "Super admins have every permission, so this setting has no effect for them."
                     : "User: Content Studio, Super Agent, Media, Insights, Channels. Admin: everything.")
            }
            Section {
                Button(user.isSuperAdmin ? "Remove super admin" : "Make super admin") { confirm = .superAdmin }
                    .disabled(busy || !AdminRules.canToggleSuperAdmin(target: user, me: me))
                Button(user.isBanned ? "Unban user" : "Ban user", role: user.isBanned ? nil : .destructive) { confirm = .ban }
                    .disabled(busy || !AdminRules.canToggleBan(target: user, me: me))
            } footer: {
                if user.id == me { Text("You can't change your own super-admin or ban status here.") }
            }
            if let d = detail, !d.memberships.isEmpty {
                Section("Workspaces") {
                    ForEach(d.memberships) { m in
                        LabeledContent(m.organization.name, value: m.role.capitalized + (m.organization.plan.map { " · \($0.capitalized)" } ?? ""))
                    }
                }
            }
        }
        .navigationTitle(user.display)
        .navigationBarTitleDisplayMode(.inline)
        .task { detail = try? await TRPCClient.shared.query("admin.users.getById", input: IdInput(id: user.id)) }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            if let action = confirm {
                Button(confirmTitle, role: action == .ban && !user.isBanned ? .destructive : nil) { Task { await toggle(action) } }
            }
        } message: { Text(confirmMessage) }
        .noticeAlert($notice)
    }

    private var confirmTitle: String {
        switch confirm {
        case .ban: return user.isBanned ? "Unban \(user.display)?" : "Ban \(user.display)?"
        case .superAdmin: return user.isSuperAdmin ? "Remove super admin?" : "Make super admin?"
        case nil: return ""
        }
    }
    private var confirmMessage: String {
        switch confirm {
        case .ban: return user.isBanned ? "They can sign in again." : "They can no longer sign in."
        case .superAdmin: return user.isSuperAdmin ? "They lose access to the admin panel." : "They get full access to every workspace's admin tools."
        case nil: return ""
        }
    }

    private struct RoleInput: Encodable { let userId: String; let appRole: String }
    private struct UserInput: Encodable { let userId: String }
    private struct RoleOutput: Decodable { let appRole: String }

    private func setRole(_ role: String) async {
        guard role != user.appRole else { return }
        busy = true
        defer { busy = false }
        do {
            let r: RoleOutput = try await TRPCClient.shared.mutate("admin.users.setAppRole", input: RoleInput(userId: user.id, appRole: role))
            user.appRole = r.appRole
            onChange(user)
        } catch {
            notice = error.localizedDescription
        }
    }

    /// The server TOGGLES, so a blind retry could undo the change. After any
    /// outcome we re-read the user rather than assume.
    private func toggle(_ action: Action) async {
        busy = true
        defer { busy = false }
        do {
            let path = action == .ban ? "admin.users.toggleBan" : "admin.users.toggleSuperAdmin"
            let _: Ignored = try await TRPCClient.shared.mutate(path, input: UserInput(userId: user.id))
        } catch {
            notice = error.localizedDescription
        }
        await reread()
    }

    private struct ListInput: Encodable { let limit: Int; let search: String }
    private func reread() async {
        if let p: AdminPage<AdminUser> = try? await TRPCClient.shared.query("admin.users.list", input: ListInput(limit: 20, search: user.email)),
           let fresh = p.items.first(where: { $0.id == user.id }) {
            user = fresh
            onChange(fresh)
        }
    }
}

// MARK: Organizations

struct AdminOrgsView: View {
    @State private var search = ""
    @State private var orgs: [AdminOrg] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var metaApps: [MetaAppOption] = []

    var body: some View {
        List {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            ForEach(orgs) { o in
                NavigationLink { AdminOrgDetailView(org: o, metaApps: metaApps) { updated in
                    if let i = orgs.firstIndex(where: { $0.id == updated.id }) { orgs[i] = updated }
                } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack { Text(o.name).lineLimit(1); adminBadge(o.plan.capitalized, .blue) }
                        Text("\(o._count?.members ?? 0) members · \(o._count?.channels ?? 0) channels · \(o._count?.posts ?? 0) posts")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if nextCursor != nil { HStack { Spacer(); ProgressView(); Spacer() }.onAppear { Task { await load(more: true) } } }
        }
        .navigationTitle("Organizations")
        .searchable(text: $search, prompt: "Name or slug")
        .task(id: search) {
            if !search.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            if !Task.isCancelled { await load(more: false) }
        }
        .task { metaApps = (try? await TRPCClient.shared.query("admin.orgs.metaApps")) ?? [] }
        .refreshable { await load(more: false) }
        .overlay { if loading && orgs.isEmpty { ProgressView() } }
    }

    private struct ListInput: Encodable { let limit: Int; var cursor: String?; var search: String? }

    private func load(more: Bool) async {
        if more && loading { return }
        loading = true
        defer { loading = false }
        let q = search.trimmingCharacters(in: .whitespaces)
        do {
            let p: AdminPage<AdminOrg> = try await TRPCClient.shared.query("admin.orgs.list",
                input: ListInput(limit: 30, cursor: more ? nextCursor : nil, search: q.isEmpty ? nil : q))
            orgs = more ? orgs + p.items : p.items
            nextCursor = p.nextCursor
            error = nil
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }
}

struct AdminOrgDetailView: View {
    @State var org: AdminOrg
    let metaApps: [MetaAppOption]
    let onChange: (AdminOrg) -> Void
    @State private var pendingPlan: String?
    @State private var pendingMeta: String??
    @State private var busy = false
    @State private var notice: String?

    var body: some View {
        Form {
            Section {
                LabeledContent("Members", value: "\(org._count?.members ?? 0)")
                LabeledContent("Channels", value: "\(org._count?.channels ?? 0)")
                LabeledContent("Posts", value: "\(org._count?.posts ?? 0)")
            }
            Section {
                Picker("Plan", selection: Binding(get: { org.plan }, set: { if $0 != org.plan { pendingPlan = $0 } })) {
                    ForEach(AdminRules.plans, id: \.self) { Text($0.capitalized).tag($0) }
                }
                .disabled(busy)
            } footer: { Text("Takes effect immediately. Billing isn't charged from here.") }
            if !metaApps.isEmpty {
                Section {
                    Picker("Meta app for new connections", selection: Binding(
                        get: { org.metaAppId ?? "" },
                        set: { new in let v = new.isEmpty ? nil : new; if v != org.metaAppId { pendingMeta = .some(v) } })) {
                        ForEach(metaApps) { a in Text(a.legacy ? "\(a.appId) (default)" : a.appId).tag(a.legacy ? "" : a.appId) }
                    }
                    .disabled(busy)
                } footer: {
                    Text("Only NEW Facebook/Instagram connections use this app. Existing channels keep the app that connected them.")
                }
            }
        }
        .navigationTitle(org.name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Change \(org.name) to \(pendingPlan?.capitalized ?? "")?", isPresented: Binding(get: { pendingPlan != nil }, set: { if !$0 { pendingPlan = nil } }), titleVisibility: .visible) {
            Button("Change plan") { if let p = pendingPlan { Task { await changePlan(p) } } }
        }
        .confirmationDialog("Change the Meta app for new connections?", isPresented: Binding(get: { pendingMeta != nil }, set: { if !$0 { pendingMeta = nil } }), titleVisibility: .visible) {
            Button("Change Meta app") { if let m = pendingMeta { Task { await setMeta(m) } } }
        } message: { Text("An app without approved permissions will let users connect but not publish.") }
        .noticeAlert($notice)
    }

    private struct PlanInput: Encodable { let organizationId: String; let plan: String }
    private struct MetaInput: Encodable {
        let organizationId: String; let metaAppId: String?
        // null must be SENT (it restores the default app), not left out.
        func encode(to e: Encoder) throws {
            var c = e.container(keyedBy: CodingKeys.self)
            try c.encode(organizationId, forKey: .organizationId)
            try c.encode(metaAppId, forKey: .metaAppId)
        }
        enum CodingKeys: String, CodingKey { case organizationId, metaAppId }
    }

    private func changePlan(_ plan: String) async {
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("admin.orgs.changePlan", input: PlanInput(organizationId: org.id, plan: plan))
            org.plan = plan
            onChange(org)
        } catch { notice = error.localizedDescription }
    }

    private func setMeta(_ id: String?) async {
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("admin.orgs.setMetaApp", input: MetaInput(organizationId: org.id, metaAppId: id))
            org.metaAppId = id
            onChange(org)
        } catch { notice = error.localizedDescription }
    }
}

// MARK: Queues

struct AdminQueuesView: View {
    @State private var rows: [AdminRules.QueueRow] = []
    @State private var failed: [FailedJob] = []
    @State private var error: String?
    @State private var loading = false
    @State private var acting: String?
    @State private var confirmRetry: FailedJob?
    @State private var confirmDelete: FailedJob?
    @State private var notice: String?

    var body: some View {
        List {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Section("Queues") {
                ForEach(rows) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(AdminRules.humanQueue(r.name)).font(.subheadline)
                        if r.unreadable {
                            Text("Couldn't read this queue").font(.caption).foregroundStyle(.orange)
                        } else {
                            Text("\(r.waiting) waiting · \(r.active) active · \(r.delayed) delayed · \(r.failed) failed")
                                .font(.caption).foregroundStyle(r.failed > 0 ? .red : .secondary)
                        }
                    }
                }
            }
            Section {
                if failed.isEmpty && !loading { Text("No failed jobs.").foregroundStyle(.secondary) }
                ForEach(failed) { j in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(AdminRules.humanQueue(j.queue)).font(.caption.weight(.semibold))
                            Text("#\(j.jobId)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            Spacer()
                            if let t = j.timestamp { Text(Date(timeIntervalSince1970: t / 1000), format: .relative(presentation: .named)).font(.caption2).foregroundStyle(.secondary) }
                        }
                        Text(j.failedReason ?? "No reason recorded").font(.caption).foregroundStyle(.secondary).lineLimit(4)
                        HStack(spacing: 16) {
                            Button("Retry") { confirmRetry = j }
                            Button("Delete", role: .destructive) { confirmDelete = j }
                        }
                        .font(.caption.weight(.semibold)).buttonStyle(.borderless).disabled(acting != nil)
                    }
                }
            } header: { Text("Failed jobs") }
        }
        .navigationTitle("Queues")
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && rows.isEmpty { ProgressView() } }
        .confirmationDialog("Retry this job?", isPresented: Binding(get: { confirmRetry != nil }, set: { if !$0 { confirmRetry = nil } }), titleVisibility: .visible) {
            Button("Retry") { if let j = confirmRetry { Task { await act(j, "admin.queues.retryJob") } } }
        } message: { Text(confirmRetry.flatMap { AdminRules.retryWarning(queueName: $0.queueName) } ?? "It runs again from the start.") }
        .confirmationDialog("Delete this failed job?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete job", role: .destructive) { if let j = confirmDelete { Task { await act(j, "admin.queues.deleteJob") } } }
        } message: { Text("It's removed from the queue and won't run again. This can't be undone.") }
        .noticeAlert($notice)
    }

    private struct FailedInput: Encodable { let limit: Int }
    private struct JobInput: Encodable { let queueName: String; let jobId: String }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let s: [String: JSONValue] = TRPCClient.shared.query("admin.queues.stats")
            async let f: [FailedJob] = TRPCClient.shared.query("admin.queues.failedJobs", input: FailedInput(limit: 20))
            rows = AdminRules.queueRows(try await s)
            failed = (try await f).sorted { ($0.timestamp ?? 0) > ($1.timestamp ?? 0) }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func act(_ j: FailedJob, _ path: String) async {
        acting = j.id
        defer { acting = nil }
        do {
            let _: Ignored = try await TRPCClient.shared.mutate(path, input: JobInput(queueName: j.queueName, jobId: j.jobId))
        } catch {
            notice = error.localizedDescription
        }
        await load()
    }
}

// MARK: Monitoring

struct MonitoringView: View {
    @State private var source = "all"
    @State private var severity = "all"
    @State private var stats: ErrorStats?
    @State private var errors: [ErrorLogEntry] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var confirmAll = false
    @State private var notice: String?

    var body: some View {
        List {
            if let s = stats {
                Section {
                    LabeledContent("Unresolved", value: "\(s.unresolved)")
                    LabeledContent("Seen in 24 h", value: "\(s.last24h)")
                    LabeledContent("Seen in 7 days", value: "\(s.lastWeek)")
                }
            }
            Section {
                Picker("Source", selection: $source) { ForEach(AdminRules.errorSources, id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Severity", selection: $severity) { ForEach(AdminRules.severities, id: \.self) { Text($0.capitalized).tag($0) } }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Section {
                if errors.isEmpty && !loading { Text("Nothing unresolved here.").foregroundStyle(.secondary) }
                ForEach(errors) { e in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            adminBadge(e.severity.capitalized, e.severity == "critical" ? .red : (e.severity == "warning" ? .orange : .pink))
                            Text(e.source).font(.caption).foregroundStyle(.secondary)
                            if let n = e.occurrences, n > 1 { Text("×\(n)").font(.caption).foregroundStyle(.secondary) }
                            Spacer()
                            if let d = e.lastSeenAt { Text(d, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(.secondary) }
                        }
                        Text(e.message).font(.caption).lineLimit(5).textSelection(.enabled)
                        if let p = e.endpoint { Text(p).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    .swipeActions { Button("Resolve") { Task { await resolve(e) } }.tint(.green) }
                }
                if nextCursor != nil { HStack { Spacer(); ProgressView(); Spacer() }.onAppear { Task { await load(more: true) } } }
            } header: { Text("Unresolved") } footer: {
                Text("Swipe left to resolve. Resolving marks an error as seen; it doesn't fix it.")
            }
        }
        .navigationTitle("Monitoring")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Resolve all") { confirmAll = true }.disabled(errors.isEmpty)
            }
        }
        .confirmationDialog("Resolve every unresolved error matching this filter?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Resolve all") { Task { await resolveAll() } }
        } message: { Text("This covers all matching errors, not only the ones loaded on screen.") }
        .task(id: "\(source)|\(severity)") { await load(more: false) }
        .refreshable { await load(more: false) }
        .noticeAlert($notice)
    }

    private struct ListInput: Encodable { let source: String; let severity: String; let resolved: Bool; let limit: Int; var cursor: String? }
    private struct ResolveInput: Encodable { let id: String }
    private struct AllInput: Encodable { let source: String; let severity: String }

    private func load(more: Bool) async {
        if more && loading { return }
        loading = true
        defer { loading = false }
        do {
            let p: ErrorLogPage = try await TRPCClient.shared.query("monitor.list",
                input: ListInput(source: source, severity: severity, resolved: false, limit: 50, cursor: more ? nextCursor : nil))
            errors = more ? errors + p.errors : p.errors
            nextCursor = p.nextCursor
            if !more { stats = try? await TRPCClient.shared.query("monitor.stats") }
            error = nil
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }

    private func resolve(_ e: ErrorLogEntry) async {
        do {
            let _: Ignored = try await TRPCClient.shared.mutate("monitor.resolve", input: ResolveInput(id: e.id))
            errors.removeAll { $0.id == e.id }
            stats?.unresolved = max(0, (stats?.unresolved ?? 1) - 1)
        } catch { notice = error.localizedDescription }
    }

    private func resolveAll() async {
        do {
            let r: UpdateCount = try await TRPCClient.shared.mutate("monitor.resolveAll", input: AllInput(source: source, severity: severity))
            notice = "Resolved \(r.count) error\(r.count == 1 ? "" : "s")."
        } catch { notice = error.localizedDescription }
        await load(more: false)
    }
}

// MARK: Audit log

struct AuditLogView: View {
    @State private var action = ""
    @State private var items: [AuditEntry] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            ForEach(items) { a in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(a.action).font(.subheadline.monospaced()).lineLimit(1)
                        Spacer()
                        if let d = a.createdAt { Text(d, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(.secondary) }
                    }
                    Text([a.user?.name ?? a.user?.email, a.organization?.name, a.entityType].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            if nextCursor != nil { HStack { Spacer(); ProgressView(); Spacer() }.onAppear { Task { await load(more: true) } } }
        }
        .navigationTitle("Audit log")
        .searchable(text: $action, prompt: "Filter by action, e.g. channel")
        .textInputAutocapitalization(.never)
        .task(id: action) {
            if !action.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            if !Task.isCancelled { await load(more: false) }
        }
        .refreshable { await load(more: false) }
        .overlay { if loading && items.isEmpty { ProgressView() } }
    }

    private struct ListInput: Encodable { let limit: Int; var cursor: String?; var action: String? }

    private func load(more: Bool) async {
        if more && loading { return }
        loading = true
        defer { loading = false }
        let q = action.trimmingCharacters(in: .whitespaces)
        do {
            let p: AdminPage<AuditEntry> = try await TRPCClient.shared.query("admin.audit.list",
                input: ListInput(limit: 40, cursor: more ? nextCursor : nil, action: q.isEmpty ? nil : q))
            items = more ? items + p.items : p.items
            nextCursor = p.nextCursor
            error = nil
        } catch {
            if more { nextCursor = nil } else { self.error = error.localizedDescription }
        }
    }
}
