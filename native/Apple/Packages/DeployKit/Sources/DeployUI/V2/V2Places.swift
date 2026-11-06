#if os(iOS)
import SwiftUI
import DeployCore

struct V2InboxView: View {
    @Bindable var store: V2Store
    @Binding var answered: Bool
    @State private var reviewItem: InboxItem?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        V2Page(title: "Waiting on you") {
            Picker("Decisions", selection: $answered) {
                Text("Waiting \(store.waiting.count)").tag(false)
                Text("Answered").tag(true)
            }.pickerStyle(.segmented)
            if answered {
                ForEach(days, id: \.self) { day in
                    V2Group(title: day) {
                        ForEach(store.answered.filter { dayLabel($0.answer?.at ?? $0.createdAt) == day }, id: \.id) { item in
                            VStack(alignment: .leading, spacing: 0) {
                                V2Row(title: item.title, subtitle: answerLabel(item), trailing: V2Labels.outcome(item), identity: store.snapshot.agents.first { $0.id == item.from }?.identity ?? .from(id: item.from))
                                Divider().padding(.leading, 52)
                            }
                        }
                    }
                }
                if store.answered.isEmpty { V2Empty(title: "No answered decisions", message: "Answers from every device appear here.") }
            } else {
                ForEach(store.waiting, id: \.id) { item in
                    if V2DesignReview.project(of: item.id) != nil { Button { reviewItem = item } label: { V2DesignWaitingRow(store: store, item: item) }.buttonStyle(.plain) }
                    else { V2Decision(item: item, store: store) }
                }
            }
        }.navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
            .designReview(item: $reviewItem, store: store)
    }
    private var days: [String] { store.answered.map { dayLabel($0.answer?.at ?? $0.createdAt) }.reduce(into: []) { if !$0.contains($1) { $0.append($1) } } }
    private func dayLabel(_ value: String) -> String {
        guard let date = V2Store.date(value) else { return "Earlier" }
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return V2Labels.shortDate(value)
    }
    private func answerLabel(_ item: InboxItem) -> String {
        guard let answer = item.answer else { return "Answered" }
        return "\(answer.by) · \(answer.on == .iphone ? "This iPhone" : answer.on.rawValue.capitalized) · \(V2Labels.shortDate(answer.at))"
    }
}
struct V2LiveView: View {
    @Bindable var store: V2Store
    let open: (String) -> Void
    var body: some View {
        V2Page(title: "Live") {
            ForEach(store.waiting.filter { $0.kind == .rollback }, id: \.id) { item in V2Decision(item: item, store: store) }
            ForEach(store.snapshot.live?.computers ?? []) { computer in
                V2Group(title: "\(computer.name) · \(computer.online ? "online" : "offline")") {
                    ForEach(computer.apps) { app in
                        Button { open(app.id) } label: { V2Row(title: app.name, subtitle: app.summary, state: app.state) }
                        if app.id != computer.apps.last?.id { Divider().padding(.leading, 46) }
                    }
                }.opacity(store.online ? 1 : 0.45)
            }
            if store.snapshot.live?.computers.isEmpty == true { V2Empty(title: "No apps running", message: "Apps appear here after you start a release.") }
        }.refreshable { await store.refresh() }
    }
}
struct V2WorkerView: View {
    @Bindable var store: V2Store
    let appId: String
    @State private var detail: V2LiveDetail?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    private var app: V2LiveApp? { detail?.app ?? store.snapshot.live?.computers.flatMap(\.apps).first { $0.id == appId } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let app {
                        HStack { V2Status(state: app.state); Text([app.kind.rawValue.capitalized, app.project, app.release].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 13)).foregroundStyle(.secondary) }
                        V2Group(title: "Health") {
                            if let jobs = app.jobs { V2Row(title: "Jobs", subtitle: "\(Int(jobs.failRate * 100))% failing · usually \(Int(jobs.baselineFailRate * 100))%", icon: "chart.line.uptrend.xyaxis") }
                            if let queue = app.queue { Divider(); V2Row(title: "Queue", subtitle: "\(Int(queue.depth).formatted()) waiting · oldest \(Int(queue.oldestSec / 60)) min", icon: "tray") }
                            if let process = app.restarts { Divider(); V2Row(title: "Process", subtitle: "Restarted \(Int(process.count)) times in \(Int(process.windowSec / 60)) min", icon: "arrow.clockwise") }
                            if let heartbeat = app.heartbeatAt { Divider(); V2Row(title: "Heartbeat", subtitle: V2Store.date(heartbeat)?.formatted(.relative(presentation: .named)) ?? heartbeat, icon: "checkmark.circle") }
                            if let http = app.http { V2Row(title: "HTTP \(Int(http.status))", subtitle: "\(Int(http.p95ms)) ms p95 · \(Int(http.reqPerMin)) req/min", icon: "network") }
                            if app.jobs == nil && app.http == nil { V2Row(title: "Status", subtitle: app.summary, icon: "waveform.path.ecg") }
                        }
                        if let release = app.release {
                            V2Group(title: "Release \(release)") {
                                ForEach(store.snapshot.live?.computers.flatMap(\.apps).filter { $0.project == app.project && $0.release == release } ?? []) { sibling in V2Row(title: sibling.name, subtitle: sibling.kind == .worker ? "Worker" : "Web app", state: sibling.state) }
                            }
                        }
                        if let decision = store.waiting.first(where: { $0.kind == .rollback && $0.projectId == app.project }) { V2Decision(item: decision, store: store) }
                    }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
                }.padding(16).opacity(store.online ? 1 : 0.45)
            }.background(Color(.systemGroupedBackground)).navigationTitle(app?.name ?? appId).navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
                .task { do { detail = try await store.client.liveApp(appId) } catch { self.error = coordinatorErrorDescription(error) } }
        }
    }
}
struct V2ProjectsView: View {
    @Bindable var store: V2Store
    @Bindable var workspace: WorkspaceStore
    @State private var selected: V2Project?
    var body: some View {
        NavigationStack {
            V2Page(title: "Projects") {
                V2Group(title: "Projects") {
                    ForEach(store.snapshot.projects) { project in
                        Button { selected = project } label: { V2Row(title: project.name, subtitle: project.summary ?? summary(project.id), icon: "folder") }
                        if project.id != store.snapshot.projects.last?.id { Divider().padding(.leading, 46) }
                    }
                }
                if store.snapshot.projects.isEmpty { V2Empty(title: "No projects yet", message: "Describe what you want to build in Work.") }
                if let project = selected ?? store.snapshot.projects.first { V2ProjectSection(store: store, project: project) }
                if let error = store.projectsError { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
            }.opacity(store.online ? 1 : 0.45)
        }
    }
    private func summary(_ id: String) -> String {
        let apps = store.snapshot.live?.computers.flatMap(\.apps).filter { $0.project == id } ?? []
        if apps.isEmpty { return "\(store.tasks.filter { $0.projectId == id }.count) tasks" }
        let failing = apps.filter { $0.state == .failing }.count
        return failing > 0 ? "\(failing) of \(apps.count) apps failing" : "\(apps.count) apps · Live"
    }
}
struct V2ComputersView: View {
    @Bindable var store: V2Store
    var body: some View {
        V2Page(title: "Computers") {
            if let error = store.computersError { Text(error).font(.system(size: 15)).foregroundStyle(.secondary) }
            V2Group(title: "\(store.snapshot.computers.filter { $0.online == true }.count) online") {
                ForEach(store.snapshot.computers) { computer in
                    V2Row(title: computer.name, subtitle: roles(computer), icon: "desktopcomputer", trailing: computer.online == true ? "Online" : computer.online == false ? "Offline" : "Unavailable")
                    if computer.id != store.snapshot.computers.last?.id { Divider().padding(.leading, 46) }
                }
            }
            V2Group(title: "Models") {
                ForEach(store.snapshot.workspace?.workers ?? []) { worker in
                    ForEach(worker.modelOptions ?? [], id: \.id) { provider in
                        ForEach(provider.models) { model in V2Row(title: model.name, subtitle: "\(provider.id.capitalized) · \(worker.name)", icon: "cpu") }
                    }
                }
            }
            Text("Add or remove computers, and change model defaults, on a computer.").font(.system(size: 13)).foregroundStyle(.secondary)
        }.opacity(store.online ? 1 : 0.45)
    }
    private func roles(_ computer: V2Computer) -> String {
        if computer.kind == "coordinator" { return "Coordinator" }
        let names = ["coordinator": "Coordinator", "take-tasks": "Take tasks", "run-apps": "Run apps", "serve-models": "Serve models", "use-screen": "Use the screen"]
        return computer.roles?.compactMap { names[$0] }.joined(separator: " · ") ?? "Roles unavailable"
    }
}
enum V2Appearance: String, CaseIterable {
    case system, light, dark
    static let defaultsKey = "deploy.v2.appearance"
    var label: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self { case .system: nil; case .light: .light; case .dark: .dark }
    }
}

struct V2SettingsView: View {
    @Bindable var store: V2Store
    @Bindable var workspace: WorkspaceStore
    @State private var backups = false
    @State private var packages = false
    @State private var packageSummary: String?
    @State private var summaryRefresh = 0
    @State private var notifications = false
    @State private var devices = false
    @State private var approvals = false
    @State private var approvalRules: V2Approvals?
    @State private var forgetCertificate = false
    @AppStorage(V2Appearance.defaultsKey) private var appearance = V2Appearance.system
    @Environment(\.colorScheme) private var scheme
    private var agentSummary: String {
        let agents = store.snapshot.agents
        guard !agents.isEmpty else { return "No agents" }
        let names = agents.map(\.name).joined(separator: ", ")
        guard let approvalRules else { return names }
        // Include project overrides: an allowed override must not read as "all ask first".
        let ids = Set(agents.map(\.id))
        let allAsk = approvalRules.rules.filter { ids.contains($0.agent) }.allSatisfy { $0.mode == .ask }
        return allAsk ? "\(names) · all ask first" : names
    }
    private var accountName: String { store.snapshot.account?.username ?? store.connection.username }
    private var coordinatorName: String {
        store.snapshot.live?.computers.first(where: { $0.roles.contains(.coordinator) })?.name
            ?? store.snapshot.computers.first(where: { $0.kind == "coordinator" })?.name
            ?? "your coordinator"
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Settings").font(.system(size: 28, weight: .bold)).tracking(-0.56)
                    .frame(minHeight: 34)
                    // The board leaves a 44 pt navigation area below the system safe area.
                    .padding(.horizontal, 20).padding(.top, 52).padding(.bottom, 16)
                    .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 0) {
                    V2SettingsGroup {
                        V2SettingsRow(title: accountName,
                                      subtitle: "Signed in on this iPhone · \(coordinatorName)",
                                      avatar: accountName) { EmptyView() }
                        if let certificate = V2CoordinatorTrust.checked(for: store.connection) {
                            Divider()
                            HStack(spacing: 14) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("SER's certificate").font(.system(size: 16, weight: .medium))
                                    Text("Checked by you on \(certificate.checkedAt.formatted(date: .long, time: .omitted))")
                                        .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                Button("Forget", role: .destructive) { forgetCertificate = true }
                                    .font(.system(size: 16)).foregroundStyle(WorkspaceStyle.danger(scheme)).frame(minWidth: 44, minHeight: 44)
                            }.padding(.horizontal, 16).frame(minHeight: 80)
                        }
                    }
                    V2NotificationControls(store: store, openSettings: { notifications = true })
                    V2SettingsGroup(title: "Devices") {
                        Button { devices = true } label: {
                            V2SettingsRow(title: "Paired devices", subtitle: "Phones and computers signed in as you", icon: "iphone") { V2SettingsChevron() }
                        }
                    }
                    V2SettingsGroup(title: "Agents and data") {
                        Button { approvals = true } label: {
                            V2SettingsRow(title: "What agents may do", subtitle: agentSummary, icon: "shield") { V2SettingsChevron() }
                        }
                        Divider()
                        Button { backups = true } label: {
                            V2SettingsRow(title: "Backups", subtitle: "Restore an app to a copy", icon: "arrow.down.to.line") { V2SettingsChevron() }
                        }
                        Divider()
                        Button { packages = true } label: {
                            V2SettingsRow(title: "Packages", subtitle: packageSummary ?? "Checking…", icon: "shippingbox") { V2SettingsChevron() }
                        }
                    }
                    V2SettingsGroup(title: "Display") {
                        Menu {
                            Picker("Appearance", selection: $appearance) {
                                ForEach(V2Appearance.allCases, id: \.self) { choice in
                                    Text(choice.label).tag(choice)
                                }
                            }
                        } label: {
                            V2SettingsRow(title: "Appearance", icon: "slider.horizontal.3") {
                                HStack(spacing: 6) {
                                    Text(appearance.label).font(.system(size: 16))
                                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                                }.foregroundStyle(WorkspaceStyle.tertiary(scheme)).frame(minHeight: 44)
                            }
                        }.accessibilityLabel("Appearance").accessibilityValue(appearance.label)
                    }
                    Text("Screen use, removing data and secrets stay on a computer.")
                        .font(.system(size: 13)).lineSpacing(2).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        .padding(.horizontal, 16).padding(.top, 12)
                    Text("Credits\nAgent avatars: Glyphs by Matt Houser, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), via DiceBear")
                        .font(.system(size: 13)).lineSpacing(2).foregroundStyle(WorkspaceStyle.tertiary(scheme)).tint(WorkspaceStyle.accent(scheme))
                        .padding(.horizontal, 16).padding(.top, 12)
                    V2SettingsGroup {
                        Button(role: .destructive, action: signOut) {
                            Text("Sign out").font(.system(size: 16, weight: .medium)).foregroundStyle(WorkspaceStyle.danger(scheme))
                                .frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
                        }
                    }.padding(.top, 36)
                }.padding(.horizontal, 16).padding(.bottom, 32)
            }
        }.defaultScrollAnchor(V2Evidence.board == "SettingsPackagesRowPhone" ? .bottom : .top)
        .scrollIndicators(.hidden).buttonStyle(.plain).foregroundStyle(WorkspaceStyle.text(scheme)).background(WorkspaceStyle.canvas(scheme))
        .confirmationDialog("Forget SER's certificate?", isPresented: $forgetCertificate, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { forget() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This removes this app's saved certificate trust for \(store.connection.origin.replacingOccurrences(of: "https://", with: "")) and signs you out of this connection. Your next password sign-in checks again unless iOS already trusts it. Other apps are unaffected.")
        }
        .sheet(isPresented: $backups) { NavigationStack { V2BackupsView(store: store).toolbar { Button("Done") { backups = false } } } }
        .sheet(isPresented: $packages, onDismiss: { summaryRefresh += 1 }) { NavigationStack { V2PackagesView(store: store).toolbar { Button("Done") { packages = false } } } }
        .sheet(isPresented: $notifications) { V2NotificationSettings(store: store) }
        .sheet(isPresented: $devices) { V2DevicesView(store: store) }
        .sheet(isPresented: $approvals, onDismiss: { summaryRefresh += 1 }) { V2SettingsApprovals(store: store) }
        .task {
            if V2Evidence.board == "PackagesPhone" || V2Evidence.board == "PackageVersionsPhone" { packages = true }
            if V2Evidence.board == "RestorePhone" { backups = true }
            if V2Evidence.board == "SettingsApprovalsPhone" { approvals = true }
            if V2Evidence.agentsBoard == .rules { approvals = true }
        }
        // Not keyed on snapshot.updatedAt: that changes with every event, and these read the whole
        // package cache. Each minute matches web, and so does npmjs.org's own check.
        .task(id: "\(summaryRefresh)-\(store.online)") {
            while !Task.isCancelled {
                await refreshSummaries()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
    private func refreshSummaries() async {
        // A failed read leaves the real names visible without guessing at permissions.
        let rules = try? await store.client.approvals()
        guard !Task.isCancelled else { return }
        approvalRules = rules
        do {
            async let list = store.client.packages()
            async let status = store.client.packageCopies()
            let (items, copies) = try await (list, status)
            guard !Task.isCancelled else { return }
            packageSummary = copies.summary(privateCount: items.count)
        } catch {
            guard !Task.isCancelled else { return }
            packageSummary = "Could not be checked"
        }
    }
    private func forget() {
        do {
            try V2CertificateVault.clear(origin: store.connection.origin)
            store.suspend(); workspace.disconnect()
        } catch { store.error = coordinatorErrorDescription(error) }
    }
    private func signOut() {
        Task {
            if let token = UserDefaults.standard.string(forKey: "deploy.apns.token") {
                do { try await store.client.removeDevice(token: token) }
                catch { store.error = "Could not remove notifications. Reconnect before signing out."; return }
            }
            store.suspend(); V2PairingVault.clear(); workspace.disconnect()
        }
    }
}

import UserNotifications
#endif
