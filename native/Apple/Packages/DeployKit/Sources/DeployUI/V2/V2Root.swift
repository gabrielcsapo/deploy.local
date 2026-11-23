#if os(iOS)
import SwiftUI
import DeployCore

public struct DeployV2Root: View {
    @Bindable private var workspace: WorkspaceStore
    @State private var store: V2Store?
    @State private var connect = false
    @AppStorage(V2Appearance.defaultsKey) private var appearance = V2Appearance.system
    @Environment(\.scenePhase) private var scenePhase
    private let paired: (Connection) -> Void
    public init(store: WorkspaceStore, paired: @escaping (Connection) -> Void = { _ in }) { workspace = store; self.paired = paired }
    public var body: some View {
        Group {
            if let store {
                if V2Evidence.reviewBoard { V2ReviewEvidenceView(store: store) }
                else { V2Tabs(store: store, workspace: workspace, paired: paired) }
            }
            else {
                VStack(spacing: 24) {
                    Text("deploy.local").font(.system(size: 22, weight: .semibold))
                    Text("Your computers. Your apps.").foregroundStyle(.secondary)
                    Button("Sign in") { connect = true }.buttonStyle(V2ActionStyle(primary: true))
                }.padding(32).sheet(isPresented: $connect) { V2SignIn(workspace: workspace, connected: paired) }
            }
        }.preferredColorScheme(appearance.colorScheme)
        .task(id: workspace.connection) {
            self.store?.projectTracer.close()
            self.store?.suspend()
            guard let connection = workspace.connection else { self.store = nil; return }
            workspace.suspend()
            if V2Evidence.board == nil, let paired = V2PairingVault.load(), paired.connection != connection { V2PairingVault.clear() }
            await V2Evidence.prepareLoadingCache(connection: connection)
            let next = V2Store(connection: connection, cacheDirectory: V2Evidence.cacheDirectory)
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
    @State private var openedTab = false
    @State private var compose = false
    @State private var inbox = false
    @State private var search = false
    @State private var answered = false
    @State private var workSlowKey: String?
    @State private var task: String?
    @State private var agent: String?
    @State private var newAgent = false
    @State private var createdAgent: String?
    @State private var app: String?
    @State private var decision: String?
    private var designDecision: Bool { decision.flatMap(V2DesignReview.project(of:)) != nil }
    @State private var signIn = false
    @State private var evidenceOpened = false
    @State private var evidenceAgentTask: String?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch tab {
                case .work: work.task(id: workStates.map(\.pending)) {
                    // A banner slot only exists while it has something to say, so rows never shift.
                    while !Task.isCancelled {
                        workSlowKey = workKeys.first { store.loadState($0).isSlow() }
                        guard workStates.contains(where: \.pending) else { return }
                        try? await Task.sleep(for: .seconds(1))
                    }
                }
                case .projects: V2ProjectsView(store: store, workspace: workspace, requestedApp: $app)
                case .live: V2LiveView(store: store, open: { app = $0; tab = .projects })
                case .computers: V2ComputersView(store: store)
                case .settings: V2SettingsView(store: store, workspace: workspace)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if tab == .work, !workUnavailable { composerButton }
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
            .fullScreenCover(isPresented: $search) {
                V2SearchView(store: store, initialText: V2Evidence.board == "SearchPhone" ? "workouts.started" : "", openTask: { task = $0 }, openAgent: { agent = $0 })
            }
            .sheet(isPresented: $newAgent, onDismiss: {
                if let createdAgent { agent = createdAgent; self.createdAgent = nil }
            }) {
                V2NewAgentSheet(store: store) { createdAgent = $0.id; newAgent = false }
            }
            .sheet(isPresented: $inbox) { NavigationStack { V2InboxView(store: store, answered: $answered) } }
            .sheet(isPresented: Binding(get: { task != nil }, set: { if !$0 { task = nil } })) {
                if let task { V2ConversationView(store: store, taskId: task) }
            }
            .sheet(isPresented: Binding(get: { agent != nil }, set: { if !$0 { agent = nil } })) {
                if let agent { V2ConversationView(store: store, taskId: evidenceAgentTask ?? store.snapshot.agentTasks[agent], agent: agent) }
            }
            .sheet(isPresented: Binding(get: { decision != nil && !designDecision }, set: { if !$0 { decision = nil } })) {
                if let item = store.snapshot.inbox.first(where: { $0.id == decision }) {
                    if item.kind == .question {
                        NavigationStack {
                            ScrollView { V2Decision(item: item, store: store, inSheet: true).padding(16) }
                                .background(WorkspaceStyle.surface(scheme))
                                .toolbar(.hidden, for: .navigationBar)
                        }.presentationDetents([.large]).presentationDragIndicator(.visible)
                    } else {
                        NavigationStack { ScrollView { V2Decision(item: item, store: store).padding(16) }.navigationTitle(V2Labels.agentName(item)).navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { decision = nil } } }
                    }
                }
            }
            // A design review is a page of its own, full screen: its boards, Before and After.
            .designReview(item: Binding(
                get: { designDecision ? store.snapshot.inbox.first { $0.id == decision } : nil },
                set: { decision = $0?.id }
            ), store: store)
            .sheet(isPresented: $signIn) { V2SignIn(workspace: workspace, connected: paired) }
            .task {
                guard V2Evidence.agentsBoard == nil else { return }
                let route = UserDefaults.standard.dictionary(forKey: "deploy.v2.notificationRoute") as? [String: String] ?? [:]
                decision = route["inboxItemId"]; app = route["appId"]
                if app != nil { tab = .projects }
                UserDefaults.standard.removeObject(forKey: "deploy.v2.notificationRoute")
            }
            .task { openEvidence() }
            .traceDisplayTick(modalOpen ? nil : "screen." + tab.rawValue.lowercased() + ".present") { store.projectTracer.start($0) }
            .task(id: tab) {
                // start() owns the first foreground read. Subsequent visits read only this place.
                if !openedTab { openedTab = true; return }
                let interaction = store.projectTracer.start("screen." + tab.rawValue.lowercased() + ".open")
                await InteractionScope.$current.withValue(interaction) { await store.refreshResources(visibleKeys) }
                interaction.finish(Task.isCancelled ? "navigation.left" : "refresh.finished", outcome: Task.isCancelled ? "cancelled" : "ok")
            }
            .onChange(of: tab) { old, _ in
                let keys: [String]
                switch old {
                case .work: keys = workKeys
                case .projects: keys = ["projects", "live"]
                case .live: keys = ["live"]
                case .computers: keys = ["computers", "workspace"]
                case .settings: keys = []
                }
                store.leaveResources(keys)
            }
            .onChange(of: modalOpen) { _, opened in
                store.leaveResources(visibleKeys)
                if !opened { Task { await store.refreshResources(visibleKeys) } }
            }
            .onChange(of: store.snapshot.updatedAt) { _, _ in openEvidence() }
            .onChange(of: store.selectedTaskId) { _, id in if id != nil { task = id } }
            .onChange(of: store.openedInboxId) { _, id in decision = id }
            .onChange(of: store.openedAppId) { _, id in if let id { app = id; tab = .projects } }
            .onReceive(NotificationCenter.default.publisher(for: .v2OpenNotification)) { notification in
                if let id = notification.userInfo?["inboxItemId"] as? String { decision = id }
                if let id = notification.userInfo?["appId"] as? String { tab = .projects; app = id }
                Task { await store.refresh() }
            }
    }
    private var modalOpen: Bool { compose || search || newAgent || inbox || task != nil || agent != nil || decision != nil || signIn }
    private var workKeys: [String] { ["agents", "waiting", "workspace"] }
    private var visibleKeys: [String] {
        switch tab {
        case .work: workKeys
        case .projects: ["projects", "live"]
        case .live: ["live"]
        case .computers: ["computers", "workspace"]
        case .settings: []
        }
    }
    private var workStates: [V2LoadState] { workKeys.map { store.loadState($0) } }
    private var workUnavailable: Bool { !workStates.contains(where: \.hasData) && workStates.allSatisfy(\.failed) }
    private func openEvidence() {
        guard !evidenceOpened, let board = V2Evidence.board else { return }
        // This route represents tapping an already known task, not inventing a task title.
        if board == "TaskLoadingPhone", !store.loadState("workspace").hasData { return }
        evidenceOpened = true
        if let board = V2Evidence.agentsBoard {
            switch board {
            case .workEmpty, .work: break
            case .newBlank, .newAgent, .avatar: newAgent = true
            case .approvals, .rules: tab = .settings
            case .mention: task = "sync"
            default: agent = board.agentID
            }
            return
        }
        switch board {
        case "SignInPhone": signIn = true
        case "ComposePhone": compose = true
        case "SearchPhone": search = true
        case "NewAgentPhone", "NewAgentDraftPhone": newAgent = true
        case "TaskPhone", "TaskLoadingPhone": task = "sync"
        case "TaskDeployPhone": task = "tally-reset"
        case "NewProductPhone", "TaskInfoPhone", "ShipPhone": task = "meal"
        case "AskPhone": task = "ask"
        case "ChangesPhone", "AttachPhone", "AttachedPhone", "ModelPhone": task = "meal"
        case "AnsweredPhone": answered = true; inbox = true
        case "LivePhone", "LiveLoadingPhone": tab = .live
        case "WorkerPhone": tab = .projects; app = "home-gym-sync"
        case "Phone", "RollbackPhone": evidenceAgentTask = "warden"; agent = "warden"
        case "ScoutPhone", "AgentInfoPhone", "AgentMenuPhone": evidenceAgentTask = "scout"; agent = "scout"
        case "ProjectsCarePhone", "ProjectsLoadingPhone", "ProjectPhone", "ReleasesPhone", "ReleasePhone", "ReleaseFailedPhone": tab = .projects
        case "ComputePhone": tab = .computers
        case "SettingsPhone", "SettingsApprovalsPhone", "RestorePhone", "PackagesPhone", "PackageVersionsPhone", "SettingsPackagesRowPhone",
             "SettingsArtifactsRowPhone", "ArtifactsPhone", "ArtifactsEmptyPhone", "ArtifactsNewPhone", "ArtifactDocumentPhone": tab = .settings
        default: break
        }
    }
    private var work: some View {
        V2Page(title: "Work", action: { compose = true }, search: { search = true }, loading: workStates) {
            if store.needsAuthentication {
                Button("Sign in again") { signIn = true }.buttonStyle(V2ActionStyle(primary: true))
            }
            if let key = workKeys.first(where: { store.loadState($0).failed }) ?? workSlowKey {
                V2LoadNotice(state: store.loadState(key), copy: .work, lastHeard: store.snapshot.resourceDates[key] ?? store.snapshot.updatedAt) { await store.refreshResources(workKeys) }
            }
            if !workUnavailable {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(!store.loadState("waiting").hasData ? "Waiting on you" : store.loadState("waiting").failed ? "Waiting on you · last known" : "Waiting on you · \(store.waiting.count)").font(.system(size: 13)).foregroundStyle(.secondary)
                        Spacer()
                        if !store.loadState("waiting").showsSkeleton {
                            Button("Answered") { answered = true; inbox = true }.font(.system(size: 13))
                        }
                    }.padding(.horizontal, 12)
                    if store.loadState("waiting").showsSkeleton { V2SkeletonRows(count: 2) }
                    else if !store.loadState("waiting").hasData { EmptyView() }
                    else if store.waiting.isEmpty { V2Empty(title: "Nothing waiting", message: "Decisions from your tasks and agents appear here.") }
                    else {
                        V2Group {
                            // Decisions come first and stay short: the first three, then one row for the rest.
                            ForEach(waitingShown, id: \.id) { item in
                                Button { decision = item.id } label: {
                                    if V2DesignReview.project(of: item.id) != nil { V2DesignWaitingRow(store: store, item: item) }
                                    else { V2Row(title: item.title, subtitle: "\(V2Labels.agentName(item)) · \(item.text)", trailing: V2Evidence.shortDate(item.createdAt), attention: true) }
                                }
                                if item.id != waitingShown.last?.id { Divider().padding(.leading, 46) }
                            }
                            if store.waiting.count > waitingShown.count {
                                Divider().padding(.leading, 16)
                                Button { answered = false; inbox = true } label: {
                                    V2SettingsRow(title: "All \(store.waiting.count) decisions", icon: nil) { V2SettingsChevron() }
                                }
                            }
                        }.opacity(store.loadState("waiting").failed ? 0.55 : 1)
                    }
                }
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Agents").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        Spacer()
                        if !store.loadState("agents").showsSkeleton {
                            Button { newAgent = true } label: {
                                Image(systemName: "plus").font(.system(size: 22)).frame(width: 44, height: 44)
                            }.accessibilityLabel("New agent")
                        }
                    }.frame(minHeight: 44).padding(.leading, 16).padding(.trailing, 4)
                    if store.loadState("agents").showsSkeleton { V2SkeletonRows() }
                    else if !store.loadState("agents").hasData { EmptyView() }
                    else if store.snapshot.agents.isEmpty {
                        Text("Give it a name. Teach it in the chat.").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                            .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
                    } else {
                        V2Group {
                            ForEach(store.snapshot.agents) { item in
                                if item.id != store.snapshot.agents.first?.id { Divider().padding(.leading, 52) }
                                Button { agent = item.id } label: { V2SettingsRow(title: item.name, subtitle: item.lastMessage?.text ?? "Say hello", identity: item.identity) { if let at = item.lastMessage?.at { Text(V2Evidence.shortDate(at)).font(.system(size: 13)).foregroundStyle(.secondary) }; V2SettingsChevron() } }
                            }
                        }
                    }
                }.opacity(store.loadState("agents").failed ? 0.55 : 1)
                if store.loadState("workspace").showsSkeleton {
                    V2Group(title: "Today") { V2SkeletonRows(count: 1) }
                } else if store.loadState("workspace").hasData {
                    if !today.isEmpty {
                        V2Group(title: "Today") {
                            ForEach(today) { item in
                                Button { task = item.id } label: { V2Row(title: item.title, subtitle: taskSubtitle(item), icon: item.status == "running" ? "arrow.trianglehead.2.clockwise.rotate.90" : "checkmark") }
                                if item.id != today.last?.id { Divider().padding(.leading, 46) }
                            }
                        }.opacity(store.loadState("workspace").failed ? 0.55 : 1)
                    }
                }
                if workStates.contains(where: { $0.failed && $0.hasData }) {
                    Text("You can read these, but answers need \(coordinator). Anything you write is sent when it’s back.").font(.system(size: 13)).foregroundStyle(.secondary)
                    Text("deploy.local works on your home network. Away from home, this is what you’ll see.").font(.system(size: 13)).foregroundStyle(.secondary)
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
            }
        }.refreshable { await store.refreshResources(workKeys) }
    }
    private var coordinator: String { store.snapshot.live?.computers.first(where: { $0.roles.contains(.coordinator) })?.name ?? "your coordinator" }
    /// Work shows the first three decisions; the rest open from the row beneath them.
    private var waitingShown: [InboxItem] { Array(store.waiting.prefix(3)) }
    private var today: [V2Task] {
        V2Evidence.agentsBoard == nil ? store.today : store.tasks.filter { V2Evidence.isToday($0.updatedAt) }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private func taskSubtitle(_ task: V2Task) -> String {
        let computer = store.snapshot.workspace?.workers.first { $0.id == task.workerId }?.name
        return [task.status.capitalized, computer].compactMap { $0 }.joined(separator: " · ")
    }
    private var composerButton: some View {
        Button { compose = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus")
                Text(!workStates.contains(where: \.failed) ? "Ask, build, or follow up…" : "Sends when \(coordinator) is back").font(.system(size: 15)).foregroundStyle(.secondary)
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
