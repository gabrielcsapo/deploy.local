#if os(iOS)
import SwiftUI
import DeployCore

struct V2InboxView: View {
    @Bindable var store: V2Store
    @Binding var answered: Bool
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
                                V2Row(title: item.title, subtitle: answerLabel(item), trailing: V2Labels.outcome(item), avatar: V2Labels.agentName(item))
                                Divider().padding(.leading, 52)
                            }
                        }
                    }
                }
                if store.answered.isEmpty { V2Empty(title: "No answered decisions", message: "Answers from every device appear here.") }
            } else {
                ForEach(store.waiting, id: \.id) { item in
                    if V2DesignReview.project(of: item.id) != nil { V2DesignCard(store: store, item: item) }
                    else { V2Decision(item: item, store: store) }
                }
            }
        }.navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
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
    @State private var notifications = false
    @State private var devices = false
    @State private var approvals = false
    @AppStorage(V2Appearance.defaultsKey) private var appearance = V2Appearance.system
    @Environment(\.colorScheme) private var scheme
    private var agentNames: String {
        store.snapshot.agents.isEmpty ? "No agents" : store.snapshot.agents.map(\.name).joined(separator: ", ")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Settings").font(.system(size: 28, weight: .bold)).tracking(-0.56)
                .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    V2Group {
                        V2Row(title: store.snapshot.account?.username ?? store.connection.username,
                              subtitle: "Signed in on this iPhone",
                              avatar: store.snapshot.account?.username ?? store.connection.username, compact: true)
                    }
                    V2NotificationControls(store: store, compact: true).padding(.top, 4)
                    V2Group {
                        Button { notifications = true } label: {
                            V2Row(title: "Notification settings", icon: "bell", chevron: true, compact: true)
                        }
                        Divider()
                        Button { devices = true } label: {
                            V2Row(title: "Paired devices", icon: "iphone", chevron: true, compact: true)
                        }
                    }
                    V2Group {
                        Button { approvals = true } label: {
                            V2Row(title: "What agents may do", subtitle: agentNames, icon: "shield", chevron: true, compact: true)
                        }
                        Divider()
                        Button { backups = true } label: {
                            V2Row(title: "Backups", subtitle: "Restore to a copy", icon: "arrow.down.to.line", chevron: true, compact: true)
                        }
                        Divider()
                        Menu {
                            Picker("Appearance", selection: $appearance) {
                                ForEach(V2Appearance.allCases, id: \.self) { choice in
                                    Text(choice.label).tag(choice)
                                }
                            }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "slider.horizontal.3").foregroundStyle(WorkspaceStyle.secondary(scheme)).frame(width: 20)
                                Text("Appearance")
                                Spacer(minLength: 4)
                                Text(appearance.label)
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                            }.font(.system(size: 17)).padding(.horizontal, 16).frame(minHeight: 44).contentShape(Rectangle())
                        }.accessibilityLabel("Appearance").accessibilityValue(appearance.label)
                    }
                    Text("Screen use, removing data and secrets stay on a computer.")
                        .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        .padding(.horizontal, 16).padding(.top, 2)
                }.padding(.horizontal, 16).padding(.bottom, 8)
            }.scrollIndicators(.hidden)
            V2Group {
                Button(role: .destructive, action: signOut) {
                    Text("Sign out").font(.system(size: 17)).foregroundStyle(WorkspaceStyle.danger(scheme))
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
            }.padding(.horizontal, 16).padding(.vertical, 8)
        }.buttonStyle(.plain).foregroundStyle(WorkspaceStyle.text(scheme)).background(WorkspaceStyle.canvas(scheme))
        .sheet(isPresented: $backups) { NavigationStack { V2BackupsView(store: store).toolbar { Button("Done") { backups = false } } } }
        .sheet(isPresented: $notifications) { V2NotificationSettings(store: store) }
        .sheet(isPresented: $devices) { V2DevicesView(store: store) }
        .sheet(isPresented: $approvals) { V2SettingsApprovals(store: store) }
        .task {
            if V2Evidence.board == "RestorePhone" { backups = true }
            if V2Evidence.board == "SettingsApprovalsPhone" { approvals = true }
        }
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
