#if os(iOS)
import SwiftUI
import DeployCore

public struct DeployV2Root: View {
    @Bindable private var workspace: WorkspaceStore
    @State private var store: V2Store?
    @State private var connect = false
    @Environment(\.scenePhase) private var scenePhase
    private let paired: (Connection) -> Void
    public init(store: WorkspaceStore, paired: @escaping (Connection) -> Void = { _ in }) { workspace = store; self.paired = paired }
    public var body: some View {
        Group {
            if let store { V2Tabs(store: store, workspace: workspace, paired: paired) }
            else {
                VStack(spacing: 24) {
                    Text("deploy.local").font(.system(size: 22, weight: .semibold))
                    Text("Your computers. Your apps.").foregroundStyle(.secondary)
                    Button("Sign in") { connect = true }.buttonStyle(V2ActionStyle(primary: true))
                }.padding(32).sheet(isPresented: $connect) { V2SignIn(workspace: workspace, connected: paired) }
            }
        }.task(id: workspace.connection) {
            self.store?.suspend()
            guard let connection = workspace.connection else { self.store = nil; return }
            workspace.suspend()
            if V2Evidence.board == nil, let paired = V2PairingVault.load(), paired.connection != connection { V2PairingVault.clear() }
            let next = V2Store(connection: connection)
            self.store = next
            await next.start()
        }.onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store?.start() } }
            else if phase == .background { store?.suspend() }
        }
    }
}

private enum V2Tab: String, CaseIterable { case work = "Work", projects = "Projects", live = "Live", computers = "Computers", settings = "Settings"
    var icon: String {
        switch self { case .work: "bubble.left"; case .projects: "folder"; case .live: "waveform.path.ecg"; case .computers: "desktopcomputer"; case .settings: "slider.horizontal.3" }
    }
}
struct V2Tabs: View {
    @Bindable var store: V2Store
    @Bindable var workspace: WorkspaceStore
    let paired: (Connection) -> Void
    @State private var tab = V2Tab.work
    @State private var compose = false
    @State private var inbox = false
    @State private var answered = false
    @State private var task: String?
    @State private var agent: String?
    @State private var app: String?
    @State private var decision: String?
    @State private var signIn = false
    @State private var evidenceOpened = false
    @State private var evidenceAgentTask: String?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch tab {
                case .work: work
                case .projects: V2ProjectsView(store: store, workspace: workspace)
                case .live: V2LiveView(store: store, open: { app = $0 })
                case .computers: V2ComputersView(store: store)
                case .settings: V2SettingsView(store: store, workspace: workspace)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if tab == .work { composerButton }
            Divider()
            HStack(spacing: 0) {
                ForEach(V2Tab.allCases, id: \.self) { item in
                    Button { tab = item } label: {
                        VStack(spacing: 5) {
                            Image(systemName: item.icon).font(.system(size: 19))
                            Text(item.rawValue).font(.system(size: 10))
                        }.frame(maxWidth: .infinity, minHeight: 54)
                            .foregroundStyle(tab == item ? WorkspaceStyle.text(scheme) : WorkspaceStyle.tertiary(scheme))
                    }.accessibilityAddTraits(tab == item ? .isSelected : [])
                }
            }.padding(.top, 5).background(WorkspaceStyle.sidebar(scheme))
        }.background(WorkspaceStyle.canvas(scheme)).foregroundStyle(WorkspaceStyle.text(scheme)).tint(WorkspaceStyle.text(scheme))
            .sheet(isPresented: $compose) { V2ComposerSheet(store: store) }
            .sheet(isPresented: $inbox) { NavigationStack { V2InboxView(store: store, answered: $answered) } }
            .sheet(isPresented: Binding(get: { task != nil }, set: { if !$0 { task = nil } })) {
                if let task { V2ConversationView(store: store, taskId: task) }
            }
            .sheet(isPresented: Binding(get: { agent != nil }, set: { if !$0 { agent = nil } })) {
                if let agent { V2ConversationView(store: store, taskId: evidenceAgentTask ?? store.snapshot.agentTasks[agent], agent: agent) }
            }
            .sheet(isPresented: Binding(get: { app != nil }, set: { if !$0 { app = nil } })) {
                if let app { V2WorkerView(store: store, appId: app) }
            }
            .sheet(isPresented: Binding(get: { decision != nil }, set: { if !$0 { decision = nil } })) {
                if let item = store.snapshot.inbox.first(where: { $0.id == decision }) {
                    if V2DesignReview.project(of: item.id) != nil {
                        // A design review shows its boards, Before and After.
                        NavigationStack { V2DesignReviewView(store: store, item: item) }
                    } else {
                        NavigationStack { ScrollView { V2Decision(item: item, store: store).padding(16) }.navigationTitle(item.from.capitalized).navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { decision = nil } } }
                    }
                }
            }
            .sheet(isPresented: $signIn) { V2SignIn(workspace: workspace, connected: paired) }
            .task {
                let route = UserDefaults.standard.dictionary(forKey: "deploy.v2.notificationRoute") as? [String: String] ?? [:]
                decision = route["inboxItemId"]; app = route["appId"]
                UserDefaults.standard.removeObject(forKey: "deploy.v2.notificationRoute")
            }
            .onChange(of: store.snapshot.updatedAt) { _, _ in openEvidence() }
            .onChange(of: store.selectedTaskId) { _, id in if id != nil { task = id } }
            .onChange(of: store.openedInboxId) { _, id in decision = id }
            .onChange(of: store.openedAppId) { _, id in app = id }
            .onReceive(NotificationCenter.default.publisher(for: .v2OpenNotification)) { notification in
                if let id = notification.userInfo?["inboxItemId"] as? String { decision = id }
                if let id = notification.userInfo?["appId"] as? String { tab = .live; app = id }
                Task { await store.refresh() }
            }
    }
    private func openEvidence() {
        guard !evidenceOpened, let board = V2Evidence.board else { return }
        evidenceOpened = true
        switch board {
        case "SignInPhone": signIn = true
        case "ComposePhone": compose = true
        case "TaskPhone": task = "sync"
        case "NewProductPhone", "TaskInfoPhone", "ShipPhone": task = "meal"
        case "AskPhone": task = "ask"
        case "ChangesPhone", "AttachPhone", "AttachedPhone", "ModelPhone": task = "meal"
        case "AnsweredPhone": answered = true; inbox = true
        case "LivePhone": tab = .live
        case "WorkerPhone": tab = .live; app = "home-gym-sync"
        case "Phone", "RollbackPhone": evidenceAgentTask = "warden"; agent = "warden"
        case "ScoutPhone", "AgentInfoPhone", "AgentMenuPhone": evidenceAgentTask = "scout"; agent = "scout"
        case "ProjectPhone", "ReleasesPhone", "ReleasePhone", "ReleaseFailedPhone": tab = .projects
        case "ComputePhone": tab = .computers
        case "SettingsPhone", "RestorePhone": tab = .settings
        default: break
        }
    }
    private var work: some View {
        V2Page(title: "Work", action: { compose = true }) {
            if store.needsAuthentication {
                Button("Sign in again") { signIn = true }.buttonStyle(V2ActionStyle(primary: true))
            } else if !store.online {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Can’t reach \(coordinator)", systemImage: "cloud")
                    Text(store.snapshot.updatedAt.map { "Last heard from at \($0.formatted(date: .omitted, time: .shortened)). Retrying." } ?? "Connecting to your home coordinator…").font(.system(size: 13))
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(WorkspaceStyle.warning(scheme).opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.warning(scheme).opacity(0.25)))
            }
            if store.online {
                V2Group(title: "Agents") {
                    Button { agent = "scout" } label: { V2Row(title: "Scout", subtitle: "Working on \(store.tasks.filter { ["running", "checking"].contains($0.status) }.count) tasks", avatar: "Scout") }
                    Divider().padding(.leading, 52)
                    Button { agent = "warden" } label: { V2Row(title: "Warden", subtitle: liveSummary, avatar: "Warden") }
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(store.online ? "Waiting on you · \(store.waiting.count)" : "Waiting on you · last known").font(.system(size: 13)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Answered") { answered = true; inbox = true }.font(.system(size: 13))
                }.padding(.horizontal, 12)
                if store.waiting.isEmpty { V2Empty(title: "Nothing waiting", message: "Decisions from your agents appear here.") }
                else {
                    V2Group {
                        ForEach(store.waiting, id: \.id) { item in
                            Button { decision = item.id } label: { V2Row(title: item.title, subtitle: "\(item.from.capitalized) · \(item.text)", attention: true) }
                            if item.id != store.waiting.last?.id { Divider().padding(.leading, 46) }
                        }
                    }.opacity(store.online ? 1 : 0.45)
                }
            }
            if store.online {
                V2Group(title: "Today") {
                    ForEach(store.today) { item in
                        Button { task = item.id } label: { V2Row(title: item.title, subtitle: taskSubtitle(item), icon: item.status == "running" ? "arrow.trianglehead.2.clockwise.rotate.90" : "checkmark") }
                        if item.id != store.today.last?.id { Divider().padding(.leading, 46) }
                    }
                    if store.today.isEmpty { V2Empty(title: "What would you like to do?", message: "Ask a question or describe a change.").padding(.horizontal, 16) }
                }
            } else {
                Text("You can read these, but answers need \(coordinator). Anything you write is sent when it’s back.").font(.system(size: 13)).foregroundStyle(.secondary)
                Text("Only on your home network. Away from home, this is what you’ll see.").font(.system(size: 13)).foregroundStyle(.secondary)
            }
            if !store.snapshot.drafts.isEmpty {
                V2Group(title: "Queued drafts") {
                    ForEach(store.snapshot.drafts) { draft in
                        Button { store.recoverDraft(draft.id); compose = true } label: { V2Row(title: draft.text, subtitle: draft.rejected ? "Saved on this iPhone · review draft" : "Sends when connected", icon: "clock") }.disabled(!draft.rejected)
                    }
                }
            }
            if let error = store.error, store.online { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
            if let notice = store.notice { Text(notice).font(.system(size: 13)).foregroundStyle(.secondary) }
        }.refreshable { await store.refresh() }
    }
    private var coordinator: String { store.snapshot.live?.computers.first(where: { $0.roles.contains(.coordinator) })?.name ?? "your coordinator" }
    private var liveSummary: String { store.snapshot.live.map { "Watching \($0.summary.running) apps · \($0.summary.failing) failing" } ?? "Health unavailable" }
    private func taskSubtitle(_ task: V2Task) -> String {
        let computer = store.snapshot.workspace?.workers.first { $0.id == task.workerId }?.name
        return [task.status.capitalized, computer].compactMap { $0 }.joined(separator: " · ")
    }
    private var composerButton: some View {
        Button { compose = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus")
                Text(store.online ? "Ask, build, or follow up…" : "Sends when \(coordinator) is back").font(.system(size: 15)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 28))
            }.padding(.horizontal, 12).frame(minHeight: 46)
                .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(WorkspaceStyle.line(scheme)))
        }.padding(.horizontal, 12).padding(.vertical, 8)
    }
}

extension Notification.Name { public static let v2OpenNotification = Notification.Name("deploy.v2.openNotification") }
#endif
