import SwiftUI
import DeployCore
#if os(iOS)
import UIKit
#endif

public struct DeployWorkspaceView: View {
    @Bindable private var store: WorkspaceStore
    /// The project sheet, with where it opens: a section, a record and an optional task to link a new pull request to.
    @State private var projectHub: HubTarget?
    @State private var showConnection = false
    @State private var showProject = false
    @State private var showTask = false
    @State private var newTaskProject = ""
    @State private var newTaskDraft = ""
    @State private var newTaskWorkerId = "local"
    @State private var showInspector = false
    @AppStorage("workspace.activity.mode") private var activityMode = "closed"
    @AppStorage("workspace.activity.width") private var activityWidth = 400.0
    @State private var showActivitySheet = false
    @State private var activitySelection: ActivitySelection?
    @State private var conversationSelection: ActivitySelection?
    /// Threads whose computer viewer is open. The viewer belongs to one thread: opening it on one
    /// task never shows it on another task, even in the same project.
    @State private var computerTaskIds: Set<String> = []
    private var showComputer: Bool {
        get { store.selectedTaskId.map(computerTaskIds.contains) ?? false }
        nonmutating set {
            guard let id = store.selectedTaskId else { return }
            if newValue { computerTaskIds.insert(id) } else { computerTaskIds.remove(id) }
        }
    }
    private var showComputerBinding: Binding<Bool> { Binding(get: { showComputer }, set: { showComputer = $0 }) }
    @State private var search = ""
    @State private var searchOpen = false
    @State private var attentionOnly = false
    @State private var allRecents = false
    @FocusState private var searchFocused: Bool
    @State private var confirmTaskOutcome = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var showToolSheet = false
    @State private var taskPanels: [String: String] = [:]
    private var panel: String {
        get { taskPanels[store.selectedTaskId ?? ""] ?? "Changes" }
        nonmutating set { taskPanels[store.selectedTaskId ?? ""] = newValue }
    }
    private var panelBinding: Binding<String> { Binding(get: { panel }, set: { panel = $0 }) }
    private var activitySummary: TaskActivitySummary {
        TaskActivitySummary(jobs: store.detail?.jobs ?? [], activity: store.detail?.activity ?? [])
    }
    @State private var transcriptBookmarks: [String: TranscriptBookmark] = [:]
    @State private var mentionCards: [String: [ProjectWorkItem]] = [:]
    @State private var showAccount = false
    @State private var showComputers = false
    @State private var revokeWorker: Worker?
    @State private var showRepositories = false
    @State private var pendingQuestionTaskIDs: Set<String> = []
    @Environment(\.colorScheme) private var colorScheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var phoneTypeSize
    @Environment(\.displayScale) private var phoneDisplayScale
    @State private var selectedTab = "tasks"
    @State private var taskPath: [PhoneRoute] = []
    @State private var repositoryPath: [PhoneRoute] = []
    private var phoneUsesExpandedTitle: Bool { phoneTypeSize >= .xxLarge }
    private enum PhoneRoute: Hashable { case file(project: String, task: String, path: String), task(String), compose, project(String), settings, review(project: String, section: String, item: String?, task: String?) }
    private var compactWidth: Bool { horizontalSizeClass == .compact }
    #else
    private var compactWidth: Bool { false }
    #endif
    @FocusState private var composerFocused: Bool

    public init(store: WorkspaceStore) { self.store = store }

    public var body: some View {
        Group {
            #if os(iOS)
            if horizontalSizeClass == .compact { phoneShell }
            else { splitWorkspace }
            #else
            splitWorkspace
            #endif
        }
        .tint(WorkspaceStyle.accent(colorScheme))
        .onChange(of: store.selectedTaskId) { _, _ in activitySelection = nil; conversationSelection = nil }
        .task { await store.start() }
        .onChange(of: store.detail?.jobs) { previous, current in
            guard let previous, let current else { return }
            let finished = current.filter { job in !job.isActive && previous.contains { $0.id == job.id && $0.isActive } }
            if !finished.isEmpty { AccessibilityNotification.Announcement(finished.map { "\($0.title): \($0.statusLabel)" }.joined(separator: ". ")).post() }
        }
        .sheet(isPresented: $showActivitySheet) {
            VStack(spacing: 0) {
                HStack { Text("Activity").font(.headline); Spacer(); WorkspaceIconButton(label: "Close Activity", icon: .close) { showActivitySheet = false } }.padding(16)
                activityInspector
            }
            #if os(iOS)
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            #endif
        }
        .task(id: store.state) { await refreshPendingQuestions() }
        .onChange(of: store.connection) { _, _ in pendingQuestionTaskIDs = [] }
        .sheet(isPresented: $showConnection) { ConnectionSheet(store: store) }
        .alert("Revoke \(revokeWorker?.name ?? "task worker")?", isPresented: Binding(get: { revokeWorker != nil }, set: { if !$0 { revokeWorker = nil } }), presenting: revokeWorker) { worker in
            Button("Revoke", role: .destructive) { Task { _ = await store.revokeWorker(id: worker.id) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its task worker disconnects and can’t run tasks or share its desktop until it is enrolled again on that computer. Its task history stays.")
        }
        .sheet(item: $projectHub) { target in
            if let connection = store.connection {
                ProjectHubView(project: target.project, connection: connection, tasks: store.tasks, workers: store.state?.workers ?? [],
                               section: target.section, selected: target.selected, taskOrigin: target.composeTask != nil,
                               fileTaskId: target.fileTaskId, filePath: target.filePath,
                               newTaskFromFile: { ref, path in startFileTask(project: target.project.id, ref: ref, path: path) }) { id in
                    Task { await store.select(id); showTask = false }
                }
            }
        }
        .sheet(isPresented: $showProject) { ProjectSheet(store: store) }
        .sheet(isPresented: $showToolSheet) {
            NavigationStack {
                inspector.navigationTitle("Task inspector")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar { ToolbarItem(placement: .confirmationAction) { WorkspaceIconButton(label: "Close task inspector", icon: .close) { showToolSheet = false } } }
                    .presentationDetents([.large])
            }
        }
        #if os(iOS)
        .sheet(isPresented: showComputerBinding) {
            NavigationStack {
                BrowserPanel(store: store).navigationTitle("Computer control")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { WorkspaceIconButton(label: "Close computer view", icon: .close) { showComputer = false } } }
            }
        }
        #endif
        .onChange(of: store.draft) { _, _ in store.saveDraft() }
        .onDisappear { store.saveDraft() }
    }

    private var splitWorkspace: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn) {
            sidebar
                #if os(macOS)
                .toolbar(removing: .sidebarToggle)
                #endif
                .navigationSplitViewColumnWidth(min: 280, ideal: 292, max: 340)
        } detail: {
            Group {
            if store.connection == nil {
                welcome
            } else {
                VStack(spacing: 0) {
                    connectionBanner
                    if showTask || store.currentTask == nil {
                        NewConversationView(store: store, draft: $newTaskDraft, workerId: $newTaskWorkerId, initialProjectId: newTaskProject) {
                            showTask = false
                        }.id(newTaskProject)
                    } else { workspace }
                }
                    #if os(macOS)
                    .overlay {
                        FloatingComputerViewer(store: store, isPresented: showComputerBinding)
                            .opacity(showTask || store.currentTask == nil ? 0 : 1)
                            .allowsHitTesting(!showTask && store.currentTask != nil)
                            .accessibilityHidden(!showComputer || showTask || store.currentTask == nil)
                    }
                    #endif
                    .navigationTitle("")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .principal) {
                            conversationTitle
                        }
                        ToolbarItem(placement: .topBarTrailing) { taskToolbar }

                    }
                    #endif
            }
            }
            // One canvas from the title bar down: the detail column and the window toolbar above
            // it use the canvas token instead of the system window gray.
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WorkspaceStyle.canvas(colorScheme).ignoresSafeArea())
            #if os(macOS)
            .toolbarBackground(WorkspaceStyle.canvas(colorScheme), for: .windowToolbar)
            .toolbarBackground(.visible, for: .windowToolbar)
            #endif
        }
        #if os(macOS)
        .toolbar(removing: .sidebarToggle)
        #endif
        .onChange(of: store.selectedTaskId) { _, id in if id != nil { compactColumn = .detail } }
        #if os(macOS)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                WorkspaceIconButton(label: "Toggle sidebar", icon: .navigation, pressed: columnVisibility != .detailOnly, shortcut: "⌘⌃S") { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly }
                    .accessibilityLabel("Toggle sidebar").accessibilityIdentifier("toolbar-navigation")
                    .keyboardShortcut("s", modifiers: [.command, .control])
            }.workspaceToolbarChrome()
            ToolbarItem(placement: .principal) { conversationTitle }.workspaceToolbarChrome()
            ToolbarItem(placement: .primaryAction) { taskToolbar }.workspaceToolbarChrome()
        }
        #endif
        .onChange(of: showInspector) { _, shown in if shown { composerFocused = false } }
    }

    #if os(iOS)
    private var phoneShell: some View {
        TabView(selection: $selectedTab) {
            NavigationStack(path: $taskPath) {
                phoneTasks
                    .navigationDestination(for: PhoneRoute.self) { phoneDestination($0) }
            }.tabItem { phoneTab("Tasks", icon: .chat) }.tag("tasks")
            NavigationStack(path: $repositoryPath) {
                phoneRepositories
                    .navigationDestination(for: PhoneRoute.self) { phoneDestination($0) }
            }.tabItem { phoneTab("Repositories", icon: .folder) }.tag("repositories")
            NavigationStack {
                ContentUnavailableView {
                    Label("Applications unavailable", systemImage: "square.grid.2x2")
                } description: {
                    Text("The native app does not yet load applications. View and manage applications on deploy.local in your browser.")
                } actions: {
                    if let origin = store.connection?.origin, let url = URL(string: origin) {
                        Link("Open deploy.local", destination: url)
                    }
                }.navigationTitle("Applications").navigationBarTitleDisplayMode(.large)
            }.tabItem { phoneTab("Applications", icon: .grid) }.tag("applications")
            NavigationStack {
                List {
                    ForEach(store.state?.workers ?? []) { worker in
                        NavigationLink {
                            List {
                                Section("Computer") {
                                    LabeledContent("Name", value: worker.name)
                                    LabeledContent("Platform", value: worker.platform)
                                    LabeledContent("Architecture", value: worker.architecture)
                                    StatusBadge(status: worker.status)
                                }
                                if let permissions = worker.permissions {
                                    Section {
                                        NodePermissionsList(worker: worker, permissions: permissions) { revokeWorker = worker }
                                    } header: { Text("Permissions") } footer: {
                                        Text("Desktop access is always approved on the computer itself.")
                                    }
                                } else if let capture = worker.desktopCapture {
                                    Section("Desktop capture") { Text(capture.reason) }
                                }
                                Section("Providers") { ProviderUsageFooter(worker: worker) }
                                Section {
                                    Text("Open a task’s Changes menu to control its computer.").foregroundStyle(.secondary)
                                }
                            }.navigationTitle(worker.name).navigationBarTitleDisplayMode(.inline)
                        } label: {
                            HStack(spacing: 12) {
                                WorkspaceGlyph(name: .computer, size: 22)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(worker.name).font(.headline).lineLimit(2)
                                    ComputerRoleChips(roles: worker.roles)
                                    Text(worker.permissionsHeadline.map { "\(worker.platform) · \($0)" } ?? worker.platform).font(.subheadline).foregroundStyle(.secondary)
                                    StatusBadge(status: worker.status)
                                }
                            }.frame(minHeight: 44)
                        }
                    }
                }.overlay {
                    if (store.state?.workers ?? []).isEmpty {
                        ContentUnavailableView("No computers", systemImage: "desktopcomputer", description: Text(store.connection == nil ? "Connect to your home coordinator in Settings." : "Connected computers will appear here."))
                    }
                }.navigationTitle("Computers").navigationBarTitleDisplayMode(.large)
            }.tabItem { phoneTab("Computers", icon: .computer) }.tag("computers")
        }
        .onChange(of: store.connection) { _, _ in
            taskPath = []; repositoryPath = []
        }
    }

    private func phoneTab(_ title: String, icon: WorkspaceGlyphName) -> some View {
        // UITabBar accepts images, so render the shared vector glyph as a template image.
        let renderer = ImageRenderer(content: WorkspaceGlyph(name: icon, size: 24).foregroundStyle(WorkspaceStyle.text(.light)))
        renderer.scale = phoneDisplayScale
        return Label {
            Text(title)
        } icon: {
            if let image = renderer.uiImage { Image(uiImage: image).renderingMode(.template) }
        }
    }

    private var phoneTasks: some View {
        List {
            Section {
                Button { phoneCompose() } label: { Label { Text("New task") } icon: { WorkspaceGlyph(name: .compose) } }
            }
            let tree = taskTreeModel
            Section { Text("Projects").font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
            if tree.groups.isEmpty {
                Section { taskTreeEmptyState }
            } else {
                ForEach(tree.groups) { group in
                    TaskTreeGroup(group: group, searching: tree.isSearching || attentionOnly, compact: true, selectedTaskId: store.selectedTaskId,
                                  canCompose: store.connection != nil, needsYou: needsYou, compose: { phoneCompose(group.project?.id ?? "") }) { task in
                        phoneTaskRow(task)
                    }
                }
            }
            Section("Recents") {
                ForEach(visibleRecents) { task in phoneTaskRow(task) }
                if !tree.isSearching && recentTasks.count > 8 { Button(allRecents ? "Show less" : "Show more") { allRecents.toggle() }.buttonStyle(.workspaceLink) }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { connectionBanner }
        .navigationTitle("deploy.local").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, isPresented: $searchOpen, prompt: "Search tasks")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink(value: PhoneRoute.settings) {
                    WorkspaceGlyph(name: .user, size: 24).frame(width: 44, height: 44)
                }.accessibilityLabel("Settings and account")
            }
            ToolbarItem(placement: .topBarTrailing) {
                WorkspaceActionCluster {
                    WorkspaceIconButton(label: "Notifications: tasks needing you", icon: .bell, pressed: attentionOnly) { attentionOnly.toggle() }
                    WorkspaceIconButton(label: "Search tasks", icon: .search) { searchOpen = true }
                }
            }
        }
    }

    private var phoneRepositories: some View {
        List {
            ForEach(store.projects) { project in
                NavigationLink(value: PhoneRoute.project(project.id)) {
                    Label { Text(project.name).lineLimit(2) } icon: { WorkspaceGlyph(name: .folder) }
                        .frame(minHeight: 44)
                }
            }
        }.overlay {
            if store.projects.isEmpty {
                ContentUnavailableView {
                    Label("No repositories", systemImage: "folder")
                } description: { Text("Add a project to browse its repository, issues, pull requests and pipelines.") }
                actions: { Button("Add repository") { showProject = true }.disabled(store.connection == nil) }
            }
        }.navigationTitle("Repositories").navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showProject = true } label: {
                        WorkspaceGlyph(name: .plus, size: 24).frame(width: 44, height: 44)
                    }.accessibilityLabel("Add repository")
                        .disabled(store.connection == nil)
                }
            }
    }

    private func phoneTaskRow(_ task: WorkspaceTask) -> some View {
        NavigationLink(value: PhoneRoute.task(task.id)) {
            TaskTreeRow(task: task, status: taskTreeStatus(task), selected: !showTask && store.selectedTaskId == task.id)
        }
    }

    @ViewBuilder private func phoneDestination(_ route: PhoneRoute) -> some View {
        switch route {
        case .task(let id):
            VStack(spacing: 0) {
                connectionBanner
                if phoneUsesExpandedTitle { phoneConversationTitle.frame(maxWidth: .infinity).padding(16) }
                if store.currentTask?.id == id { workspace }
                else { ProgressView("Loading task…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }
            .toolbar(.hidden, for: .tabBar)
            .toolbarRole(.editor)
            .navigationTitle("Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    if !phoneUsesExpandedTitle { phoneConversationTitle }
                }
                ToolbarItem(placement: .topBarTrailing) { taskToolbar }
            }
            .task(id: id) {
                showTask = false
                if store.selectedTaskId != id { await store.select(id) }
                await store.loadDiff()
            }
        case .compose:
            ScrollView {
                NewConversationView(store: store, draft: $newTaskDraft, workerId: $newTaskWorkerId, initialProjectId: newTaskProject) {
                    showTask = false
                    if let id = store.selectedTaskId { taskPath = [.task(id)] }
                }
            }.navigationTitle("New task").navigationBarTitleDisplayMode(.inline)
                .toolbar(.hidden, for: .tabBar)
        case .project(let id):
            if let project = store.projects.first(where: { $0.id == id }), let connection = store.connection {
                ProjectHubView(project: project, connection: connection, isPushed: true, tasks: store.tasks, workers: store.state?.workers ?? [],
                               newTaskFromFile: { ref, path in startFileTask(project: project.id, ref: ref, path: path) }) { id in
                    selectedTab = "tasks"; taskPath = [.task(id)]
                }
            }
        case .review(let projectId, let section, let item, let task):
            if let project = store.projects.first(where: { $0.id == projectId }), let connection = store.connection {
                ProjectHubView(project: project, connection: connection, isPushed: true, tasks: store.tasks, workers: store.state?.workers ?? [],
                               section: section, selected: item ?? "", taskOrigin: task != nil,
                               newTaskFromFile: { ref, path in startFileTask(project: project.id, ref: ref, path: path) }) { id in
                    taskPath = [.task(id)]
                }.toolbar(.hidden, for: .tabBar)
            }
        case .file(let projectId, let task, let path):
            if let project = store.projects.first(where: { $0.id == projectId }), let connection = store.connection {
                ProjectHubView(project: project, connection: connection, isPushed: true, tasks: store.tasks,
                               workers: store.state?.workers ?? [], fileTaskId: task, filePath: path,
                               newTaskFromFile: { ref, path in startFileTask(project: project.id, ref: ref, path: path) }) { id in
                    taskPath = [.task(id)]
                }.toolbar(.hidden, for: .tabBar)
            }
        case .settings:
            List {
                Section("Account") {
                    Text(store.connection?.username ?? "Not connected").font(.headline)
                    NavigationLink("Connection settings") { ConnectionSheet(store: store, isPushed: true) }
                }
                Section("Provider usage") {
                    ProviderUsageFooter(worker: store.state?.workers.first { $0.id == (store.currentTask?.workerId ?? "local") })
                }
            }.navigationTitle("Settings").navigationBarTitleDisplayMode(.large)
        }
    }

    private var phoneConversationTitle: some View { conversationTitle }


    private func phoneCompose(_ projectId: String = "") {
        newTaskProject = projectId; showTask = true; taskPath.append(.compose)
    }

    #endif

    // Pending questions are task-detail data, not part of the workspace summary.
    private func refreshPendingQuestions() async {
        guard let connection = store.connection else { return }
        let candidates = store.tasks.filter { ["running", "waiting", "starting"].contains($0.status) }
        var pending = pendingQuestionTaskIDs.intersection(Set(candidates.map(\.id)))
        for task in candidates {
            if Task.isCancelled { return }
            if let detail: TaskDetail = try? await WorkspaceClient(connection: connection).request("/api/workspace/tasks/\(task.id)"),
               !Task.isCancelled {
                if detail.questions?.contains(where: { $0.status == "pending" }) == true { pending.insert(task.id) }
                else { pending.remove(task.id) }
            }
        }
        if !Task.isCancelled, store.connection == connection { pendingQuestionTaskIDs = pending }
    }

    private var sidebar: some View {
        HStack(spacing: 0) {
            #if os(macOS)
            utilityRail
            #endif
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("deploy.local").font(WorkspaceStyle.navigation.weight(.semibold))
                    Spacer(minLength: 0)
                    WorkspaceActionCluster {
                        WorkspaceIconButton(label: "Notifications: tasks needing you", icon: .bell, pressed: attentionOnly) { attentionOnly.toggle() }
                        WorkspaceIconButton(label: "Search tasks", icon: .search, pressed: searchOpen, shortcut: "⌘K") {
                            searchOpen.toggle(); if searchOpen { searchFocused = true } else { search = "" }
                        }.keyboardShortcut("k")
                    }
                }.padding(.horizontal, WorkspaceStyle.space3).frame(minHeight: 56)
                Button { beginTask() } label: {
                    HStack(spacing: WorkspaceStyle.space2) {
                        WorkspaceGlyph(name: .compose, size: 16)
                        Text("New task")
                        Spacer()
                        #if os(macOS)
                        Text("⌘N").foregroundStyle(.secondary)
                        #endif
                    }.font(WorkspaceStyle.navigation).padding(.horizontal, WorkspaceStyle.space3).frame(minHeight: WorkspaceStyle.taskNavigationHeight)
                }.buttonStyle(.plain).disabled(store.connection == nil).keyboardShortcut("n")
                if searchOpen { searchField }
                ScrollView { taskTree }
            }.background(WorkspaceStyle.sidebar(colorScheme))
        }
    }

    #if os(macOS)
    private var utilityRail: some View {
        VStack(spacing: 16) {
            WorkspaceGlyph(name: .brand, size: 20).foregroundStyle(WorkspaceStyle.accent(colorScheme)).frame(height: 34).help("deploy.local")
            railButton("Tasks", icon: .chat, selected: true) { projectHub = nil }
            railButton("Repositories", icon: .folder) { showRepositories = true }
                .popover(isPresented: $showRepositories) { repositoriesPopover }
            railButton("Computers", icon: .computer) { showComputers = true }
                .popover(isPresented: $showComputers) {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Computers").font(.headline)
                        ForEach(store.state?.workers ?? []) { worker in
                            HStack(spacing: 10) {
                                WorkspaceSymbol(name: "desktopcomputer")
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(worker.name).font(WorkspaceStyle.navigation)
                                    Text(worker.platform + " · " + worker.status).font(.caption).foregroundStyle(.secondary)
                                    ComputerRoleChips(roles: worker.roles)
                                    if let permissions = worker.permissions {
                                        DisclosureGroup(worker.permissionsHeadline ?? "Permissions") {
                                            NodePermissionsList(worker: worker, permissions: permissions) {
                                                showComputers = false; revokeWorker = worker
                                            }
                                        }.font(WorkspaceStyle.metadata)
                                    } else if let capture = worker.desktopCapture {
                                        Text(capture.reason).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }.padding(20).frame(width: 360)
                }
            Spacer()
            railButton("Connection settings", icon: .settings) { showConnection = true }
            railButton("Account and provider usage", icon: .user) { showAccount.toggle() }
                .popover(isPresented: $showAccount, arrowEdge: .trailing) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(store.connection?.username ?? "Account").font(.headline)
                        Divider()
                        ProviderUsageFooter(worker: store.state?.workers.first(where: { $0.id == ((showTask || store.currentTask == nil) ? newTaskWorkerId : store.currentTask?.workerId ?? "local") }))
                    }.padding(18).frame(width: 300)
                }
        }.padding(.vertical, 12).frame(width: 52)
            .background(WorkspaceStyle.rail(colorScheme))
            .overlay(alignment: .trailing) { Rectangle().fill(Color.primary.opacity(0.04)).frame(width: 0.5) }
    }
    private func railButton(_ title: String, icon: WorkspaceGlyphName, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            WorkspaceGlyph(name: icon, size: 18)
                .frame(width: 36, height: 36)
                .background(selected ? Color.primary.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).foregroundStyle(selected ? .primary : .secondary).help(title).accessibilityLabel(title)
    }
    #endif

    private var searchField: some View {
            HStack(spacing: 10) {
                WorkspaceSymbol(name: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search tasks", text: $search, prompt: Text("Search tasks").foregroundColor(.primary.opacity(0.6))).textFieldStyle(.plain)
            }.font(WorkspaceStyle.navigation).padding(.horizontal, 10).frame(minHeight: 36)
                .modifier(WorkspaceSurface(radius: 10, elevated: false))
                .padding(.horizontal, 10).padding(.top, 12).padding(.bottom, 8)
                .accessibilityIdentifier("task-search")
                .focused($searchFocused)
                #if os(macOS)
                .onExitCommand { search = ""; searchOpen = false }
                #endif
    }

    private var taskTreeModel: TaskTree {
        TaskTree(projects: store.projects, tasks: attentionOnly ? store.tasks.filter(needsYou) : store.tasks, search: search)
    }

    private func needsYou(_ task: WorkspaceTask) -> Bool {
        task.needsApproval || task.inReview || pendingQuestionTaskIDs.contains(task.id) || ["waiting", "ready", "review"].contains(task.status)
    }
    private var recentTasks: [WorkspaceTask] {
        taskTreeModel.groups.flatMap(\.tasks).sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }
    private var visibleRecents: [WorkspaceTask] { allRecents || taskTreeModel.isSearching ? recentTasks : Array(recentTasks.prefix(8)) }
    private var taskTree: some View {
        let tree = taskTreeModel
        return VStack(alignment: .leading, spacing: 0) {
            Text(attentionOnly ? "Needs you" : "Projects").font(WorkspaceStyle.metadata).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.top, 20).padding(.bottom, 8)
            if tree.groups.isEmpty { taskTreeEmptyState }
            ForEach(tree.groups.filter { !attentionOnly || !$0.tasks.isEmpty }) { group in
                TaskTreeGroup(group: group, searching: tree.isSearching || attentionOnly, selectedTaskId: showTask ? nil : store.selectedTaskId,
                              canCompose: store.connection != nil, needsYou: needsYou, compose: { beginTask(group.project?.id ?? "") }) { task in
                    taskRow(task)
                }
            }
            Text("Recents").font(WorkspaceStyle.metadata).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.top, 24).padding(.bottom, 8)
            ForEach(visibleRecents) { task in taskRow(task) }
            if !tree.isSearching && recentTasks.count > 8 {
                Button(allRecents ? "Show less" : "Show more") { allRecents.toggle() }.buttonStyle(.workspaceLink).padding(10)
            }
        }.padding(.horizontal, 8).padding(.bottom, 14)
    }

    private var taskTreeEmptyState: some View {
        ContentUnavailableView {
            Label(search.isEmpty ? "No tasks yet" : "No matching tasks", systemImage: "bubble.left")
        } actions: {
            if search.isEmpty {
                Button("New task") {
                    #if os(iOS)
                    if horizontalSizeClass == .compact { phoneCompose() } else { beginTask() }
                    #else
                    beginTask()
                    #endif
                }.disabled(store.connection == nil)
                Button("Add repository") { showProject = true }.disabled(store.connection == nil)
            } else { Button("Clear search") { search = "" } }
        }
    }

    private var repositoriesPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Repositories").font(.headline)
            ScrollView {
                VStack(alignment: .leading) {
                    ForEach(store.projects) { project in
                        Button {
                            showRepositories = false
                            projectHub = HubTarget(project: project)
                        } label: {
                            Label { Text(project.name) } icon: { WorkspaceGlyph(name: .folder) }
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }.buttonStyle(.plain)
                    }
                }
            }
            Button("Add repository") { showRepositories = false; showProject = true }
                .disabled(store.connection == nil)
        }.padding(20).frame(minWidth: 280, maxHeight: 440)
    }

    private var sidebarFooter: some View {
            VStack(alignment: .leading, spacing: 14) {
                Button { showConnection = true } label: {
                    HStack(spacing: 10) {
                        WorkspaceSymbol(name: "gearshape")
                        Text(store.connection?.username ?? "Connect to home")
                        Spacer()
                    }.frame(minHeight: WorkspaceStyle.rowHeight)
                }.buttonStyle(.plain).font(WorkspaceStyle.navigation).accessibilityLabel("Connection settings")
            }.padding(.horizontal, 18).padding(.vertical, 12)
    }

    private func beginTask(_ projectId: String = "") {
        newTaskProject = projectId
        showTask = true
        compactColumn = .detail
    }

    private func taskTreeStatus(_ task: WorkspaceTask) -> String {
        let pending = task.needsApproval || pendingQuestionTaskIDs.contains(task.id)
            || (store.detail?.task.id == task.id && store.detail?.questions?.contains(where: { $0.status == "pending" }) == true)
        return pending ? "waiting" : task.status
    }

    private func taskRow(_ task: WorkspaceTask) -> some View {
        Button {
            showTask = false
            compactColumn = .detail
            Task { await store.select(task.id) }
        } label: {
            TaskTreeRow(task: task, status: taskTreeStatus(task), selected: !showTask && store.selectedTaskId == task.id)
        }.buttonStyle(.plain).help(task.title)
    }

    private var welcome: some View {
        VStack(spacing: 14) {
            BrandTile(size: 56).padding(.bottom, 6)
            Text("Your work. All together.").font(.system(.title, weight: .semibold))
            Text("One conversation across your computers.\nConnect to your home coordinator to get started.")
                .font(WorkspaceStyle.body).multilineTextAlignment(.center)
                .foregroundStyle(WorkspaceStyle.secondaryText(colorScheme)).lineSpacing(4)
            Button("Connect to home") { showConnection = true }
                .buttonStyle(.workspacePrimary).padding(.top, 10)
                .accessibilityIdentifier("welcome-connect")
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var connectionBanner: some View {
        if let error = store.error {
            WorkspaceNotice(message: error) {
                if store.needsAuthentication {
                    Button("Sign in again") { showConnection = true }.buttonStyle(.workspaceLink)
                } else {
                    if store.canRetrySavingLogin {
                        Button("Try again") { store.retrySavingLogin() }.buttonStyle(.workspaceLink)
                    }
                    Button { store.error = nil } label: {
                        WorkspaceGlyph(name: .close, size: 14).frame(width: 28, height: 28).contentShape(Rectangle())
                    }.buttonStyle(.plain).foregroundStyle(WorkspaceStyle.secondaryText(colorScheme))
                        .help("Dismiss").accessibilityLabel("Dismiss")
                }
            }
            .frame(maxWidth: WorkspaceStyle.contentWidth)
            .padding(.horizontal, WorkspaceStyle.conversationGutter).padding(.top, 10).padding(.bottom, 2)
            .frame(maxWidth: .infinity)
        }
    }

    private var workspace: some View {
        VStack(spacing: 0) {
            if store.currentTask != nil {
                if compactWidth {
                    Picker("Task views", selection: Binding(get: { showInspector ? panel : "Chat" }, set: { value in showInspector = value != "Chat"; if value != "Chat" { panel = value } })) {
                        Text("Chat").tag("Chat"); Text("Changes").tag("Changes"); Text("Checks").tag("Checks")
                    }.pickerStyle(.segmented).padding(12)
                }
                GeometryReader { geometry in
                    HStack(spacing: 0) {
                        conversation(showSummary: !taskCardFits(geometry.size.width) && activityMode != "open").frame(maxWidth: .infinity)
                            .opacity(showInspector ? 0 : 1).allowsHitTesting(!showInspector).accessibilityHidden(showInspector)
                            .overlay { if showInspector { inspector } }
                            .overlay(alignment: .topTrailing) {
                                if taskCardFits(geometry.size.width) && !showInspector {
                                    TaskContextCard(detail: store.detail, diff: store.diff, workers: store.state?.workers ?? [], project: store.selectedProject?.name,
                                                    changes: { panel = "Changes"; showInspector = true }, activity: openActivity,
                                                    sources: { activitySelection = ActivitySelection(sources: true); presentActivity() })
                                        .padding(WorkspaceStyle.space4)
                                }
                            }
                        if !compactWidth && activityMode != "closed" && geometry.size.width >= 760 {
                            TaskActivityRail(mode: $activityMode, width: $activityWidth, summary: activitySummary) { activityInspector }
                        }
                    }.overlay(alignment: .trailing) {
                        if !compactWidth && activityMode != "closed" && geometry.size.width < 760 {
                            ZStack(alignment: .trailing) {
                                if activityMode == "open" { WorkspaceStyle.text(colorScheme).opacity(0.2).onTapGesture { activityMode = "closed" } }
                                TaskActivityRail(mode: $activityMode, width: $activityWidth, summary: activitySummary) { activityInspector }
                            }
                        }
                    }
                }
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "bubble.left.and.text.bubble.right").font(.system(.title, weight: .light)).foregroundStyle(.secondary)
                    Text("What would you like to work on?").font(.title2.weight(.semibold))
                    Text("Choose a conversation, or start something new.").foregroundStyle(.secondary)
                    Button(store.projects.isEmpty ? "Add a repository" : "New task") {
                        if store.projects.isEmpty { showProject = true } else { showTask = true }
                    }.buttonStyle(.borderedProminent).tint(WorkspaceStyle.action(colorScheme))
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.background(WorkspaceStyle.canvas(colorScheme))
    }

    private var taskContextLabel: String {
        let worker = store.state?.workers.first { $0.id == store.currentTask?.workerId }?.name ?? store.currentTask?.workerId ?? "Computer unavailable"
        return "\(store.selectedProject?.name ?? "No project") · \(worker)"
    }
    private var conversationTitle: some View {
        HStack(spacing: WorkspaceStyle.space2) {
            WorkspaceGlyph(name: .folder, size: 16).foregroundStyle(.secondary)
            Text(showTask ? "New task" : store.currentTask?.title ?? "New task").font(WorkspaceStyle.navigation.weight(.semibold)).lineLimit(1)
            if !showTask, let task = store.currentTask {
                let waiting = task.needsApproval || pendingQuestionTaskIDs.contains(task.id)
                StatusBadge(status: waiting ? "waiting" : task.inReview ? "review" : store.activeRun?.status ?? task.status,
                            label: waiting ? "Needs you" : task.inReview || task.status == "review" ? "Ready to review" : store.isWorking ? "Running" : nil)
            }
        }.help(taskContextLabel)
    }
    private var taskToolbar: some View {
        WorkspaceActionCluster {
            WorkspaceIconButton(label: "Computer use", icon: .computer, pressed: showComputer) { showComputer.toggle() }.accessibilityIdentifier("toolbar-computer")
            WorkspaceIconButton(label: "Changes", icon: .review, pressed: showInspector, shortcut: "⌘⇧I") { toggleInspector() }.keyboardShortcut("i", modifiers: [.command, .shift]).accessibilityIdentifier("toolbar-review")
            WorkspaceIconButton(label: "Activity", icon: .panelRight, pressed: activityMode == "open" || showActivitySheet) { activityMode == "open" ? (activityMode = "closed") : openActivity() }.accessibilityIdentifier("toolbar-activity").accessibilityValue(activitySummary.text)
            Menu {
                Text(taskContextLabel)
                if store.currentTask?.inReview == true { Button("Open pull request") { openTaskPull() } }
                if !store.isWorking { Button(store.currentTaskClosed ? "Reopen" : "Mark done") { confirmTaskOutcome = true }.disabled(store.busy) }
            } label: { WorkspaceToolbarIcon("More task actions", icon: .more) }
                .menuStyle(.borderlessButton).fixedSize().help("More task actions")
        }.disabled(showTask || store.currentTask == nil)
            .confirmationDialog(store.currentTaskClosed ? "Reopen this task for further work?" : "Mark this task as done?", isPresented: $confirmTaskOutcome, titleVisibility: .visible) {
                Button(store.currentTaskClosed ? "Reopen" : "Mark done") { Task { await store.setCurrentTaskClosed(!store.currentTaskClosed) } }
                Button("Cancel", role: .cancel) {}
            }
    }

    private var transcript: some View {
        let taskID = store.selectedTaskId ?? ""
        let cardBuilder: ((ProjectWorkItem) -> AnyView)? = store.currentTask?.projectId == nil ? nil : { conversationCard($0) }
        let bookmark = Binding(
            get: { transcriptBookmarks[taskID] ?? TranscriptBookmark() },
            set: { transcriptBookmarks[taskID] = $0 }
        )
        return TranscriptView(messages: store.detail?.messages ?? [], loading: store.detail == nil, events: store.detail?.events ?? [], activity: store.detail?.activity ?? [],
                              active: store.isWorking, jobs: store.detail?.jobs ?? [], workers: store.state?.workers ?? [],
                              openActivity: openActivity, openTurnActivity: { runId in activitySelection = ActivitySelection(runId: runId); presentActivity() },
                              conversationSelection: conversationSelection, activitySelected: activityMode == "open" || showActivitySheet,
                              reviewCards: mentionCards, reviewCard: cardBuilder, fileLinks: fileLinks, runs: store.detail?.runs ?? [],
                              followRequest: store.followRequest, bookmark: bookmark)
            .environment(\.mediaConnection, store.connection)
            .environment(\.taskMedia, store.detail?.attachments ?? [])
            .environment(\.markupActions, markupActions)
            .id(store.selectedTaskId)
            .task(id: "\(taskID)|\(store.detail?.messages.count ?? 0)") { placeMentions(); await store.loadLinkedPull(); placeMentions() }
            .onChange(of: store.projectPulls) { _, _ in placeMentions() }
            .onChange(of: store.projectIssues) { _, _ in placeMentions() }
            .onChange(of: store.detail?.messages.count) { _, _ in placeMentions() }
    }

    private var fileLinks: MessageFileLinks? {
        guard let task = store.currentTask else { return nil }
        return MessageFileLinks(taskId: task.id, workspacePaths: [task.workspacePath, task.remoteWorkspacePath]) { reference in
            openFile(reference)
        }
    }

    private func toggleInspector() { showInspector.toggle() }

    private func openActivity() { activitySelection = nil; presentActivity() }
    private func presentActivity() {
        if showToolSheet {
            showToolSheet = false
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(450))
                if compactWidth { showActivitySheet = true } else { activityMode = "open" }
            }
        } else if compactWidth { showActivitySheet = true } else { activityMode = "open" }
    }
    private var activityInspector: some View {
        TaskActivityInspector(detail: store.detail, workers: store.state?.workers ?? [], cancel: { job in Task { await store.cancelJob(job) } }, showConversation: { runId in
            showInspector = false; showActivitySheet = false
            conversationSelection = ActivitySelection(runId: runId)
        }, selection: activitySelection).id(store.selectedTaskId)
    }

    /// Show a file linked from the conversation in Changes.
    private func openFile(_ reference: TaskFileReference) {
        panel = "Changes"
        #if os(iOS)
        showToolSheet = true
        #else
        showInspector = true
        #endif
        Task { await store.openFile(reference) }
    }

    @ViewBuilder private var linkedPullStrip: some View {
        if let pull = store.linkedPull, let projectId = store.currentTask?.projectId, let connection = store.connection {
            ConversationReviewStrip(pull: pull, projectId: projectId, connection: connection,
                                    workers: store.state?.workers ?? []) { openReview(pull) }
                .id(pull.id)
        }
    }

    private func taskCardFits(_ width: CGFloat) -> Bool { !compactWidth && activityMode == "closed" && width >= WorkspaceStyle.contentWidth + 640 }
    private func conversation(showSummary: Bool) -> some View {
        VStack(spacing: 0) {
            transcript
            if showSummary { TaskActivitySummaryButton(summary: activitySummary, open: openActivity, selected: showActivitySheet || activityMode == "open", compact: true).padding(.horizontal, WorkspaceStyle.conversationGutter) }
            VStack(alignment: .leading, spacing: 10) {
                linkedPullStrip
                ForEach((store.detail?.questions ?? []).filter { $0.status == "pending" }) { question in
                    TaskQuestionView(question: question, store: store).id(question.id)
                }
                if let request = store.currentTask?.controlRequest {
                    ControlRequestCard(request: request, projectName: store.selectedProject?.name, busy: store.busy) { allow, always in
                        Task { await store.respondToControlRequest(allow: allow, always: always) }
                    }.id(request.id)
                }
                if store.isWorking {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(store.detail?.questions?.contains(where: { $0.status == "pending" }) == true ? "Waiting for your answer" : "Working").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Stop", systemImage: "stop.fill") { Task { await store.stop() } }
                            .buttonStyle(.bordered).controlSize(.small).disabled(store.busy)
                    }
                }
                if let queued = store.queuedMessage { queuedMessageRow(queued) }
                if store.detail?.questions?.contains(where: { $0.status == "pending" }) != true {
                VStack(alignment: .leading, spacing: 8) {
                    if !store.pendingAttachments.isEmpty {
                    ScrollView(.horizontal) { HStack(spacing: WorkspaceStyle.space2) {
                        // Keep quiet thumbnail actions together and clear of the image.
                        ForEach(store.pendingAttachments) { attachment in
                            VStack(alignment: .trailing, spacing: WorkspaceStyle.IconAction.gap) {
                                AttachmentThumbnail(id: attachment.id, caption: attachment.name)
                                WorkspaceActionCluster {
                                    if attachment.kind != "video" { ImageMarkupButton(attachment: attachment) }
                                    WorkspaceIconButton(label: "Remove \(attachment.name)", icon: .close) { store.removeAttachment(attachment.id) }
                                }
                            }
                        }
                    }}.fixedSize(horizontal: false, vertical: true).environment(\.mediaConnection, store.connection)
                        .environment(\.taskMedia, store.pendingAttachments).environment(\.markupActions, markupActions)
                    }
                    AttachmentUploadProgress(store: store)
                    composerInput.frame(minHeight: 24, alignment: .top)
                    HStack(alignment: .bottom, spacing: 8) {
                        AttachmentComposerControl(store: store)
                        VoiceInput(connection: store.connection, draft: $store.draft).id(store.selectedTaskId)
                        Spacer(minLength: 4)
                        AgentControls(store: store, workerId: store.currentTask?.workerId ?? "local", disabled: store.isWorking)
                        sendButton.help("Send message (⌘ Return)")
                    }
                }.padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 8)
                    // The composer keeps its natural height (chips plus up to six lines); the transcript
                    // above absorbs the difference, so text never draws over the toolbar.
                    .fixedSize(horizontal: false, vertical: true)
                    .modifier(WorkspacePromptSurface()).modifier(AttachmentComposerInput(store: store))
                }
                if !store.isConnected {
                    Text(store.needsAuthentication ? "Sign in again. Draft saved on this device." : "Offline. Draft saved on this device.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, WorkspaceStyle.conversationGutter).frame(maxWidth: WorkspaceStyle.contentWidth).padding(.bottom, 8).padding(.top, 6)
        }
    }

    /// A follow-up waiting for this turn, or one held back after the turn failed or was stopped.
    private func queuedMessageRow(_ queued: QueuedMessage) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: queued.isHeld ? "exclamationmark.circle" : "clock")
                .foregroundStyle(queued.isHeld ? WorkspaceStyle.statusAttention(colorScheme) : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(queued.isHeld ? "\(queued.reason ?? "Not sent.") It’s back in your draft." : "Queued, sends when this turn ends")
                    .font(.caption.weight(.semibold))
                if !queued.isHeld {
                    Text(queued.content).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            WorkspaceIconButton(label: queued.isHeld ? "Dismiss queued message" : "Cancel queued message", icon: .close) { Task { await store.cancelQueuedMessage() } }
                .disabled(store.busy || !store.isConnected)
                .accessibilityIdentifier("queued-message-cancel")
        }.padding(.horizontal, 12).padding(.vertical, 10)
            .background(WorkspaceStyle.surface(colorScheme).opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(WorkspaceStyle.line(colorScheme).opacity(0.7), lineWidth: 1))
            .accessibilityElement(children: .contain).accessibilityIdentifier("queued-message")
    }

    private var markupActions: MarkupActions {
        MarkupActions(upload: { attachment, data in
            guard await store.addAttachment(data: data, name: "marked-up-" + (attachment.name as NSString).deletingPathExtension + ".png",
                                            caption: "Marked-up " + attachment.name, taskId: attachment.taskId) else {
                throw ClientError.response(400, store.error ?? "Could not attach image")
            }
        }, focus: { taskId in
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                guard store.selectedTaskId == taskId else { return }
                composerFocused = true
            }
        })
    }

    private var composerPrompt: String {
        guard store.isWorking else { return "Ask deploy.local…" }
        return store.sendQueues && store.queuedMessage?.status != "queued" ? "Queue a follow-up…" : "Draft your next message…"
    }

    private var composerInput: some View {
        TextField("Message", text: $store.draft,
                  prompt: Text(composerPrompt).foregroundColor(.primary.opacity(0.6)), axis: .vertical)
            .textFieldStyle(.plain).lineLimit(1...6).layoutPriority(1).font(WorkspaceStyle.body).autocorrectionDisabled()
            .focused($composerFocused).accessibilityIdentifier("chat-composer")
    }

    private var sendButton: some View {
        Button { Task { await store.send() } } label: {
            if store.busy { ProgressView().controlSize(.small).frame(width: 24, height: 24) }
            else { Image(systemName: "arrow.up").font(.system(.subheadline, weight: .bold)).frame(width: 24, height: 24) }
        }.buttonStyle(WorkspaceSendStyle())
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!store.canSend)
            .accessibilityLabel(store.isWorking ? "Queue message" : "Send message")
            .help(store.isWorking ? "Queue message; sends when this turn ends" : "Send message")
    }

    /// Open a pull request or issue from the conversation in its dedicated view.
    private func openReview(_ item: ProjectWorkItem) {
        guard let projectId = store.currentTask?.projectId, let project = store.projects.first(where: { $0.id == projectId }) else { return }
        let section = item.sourceBranch == nil ? "issues" : "pulls"
        #if os(iOS)
        if horizontalSizeClass == .compact { taskPath.append(.review(project: projectId, section: section, item: item.id, task: nil)); return }
        #endif
        projectHub = HubTarget(project: project, section: section, selected: item.id)
    }

    private func conversationCard(_ item: ProjectWorkItem) -> AnyView {
        guard let projectId = store.currentTask?.projectId, let connection = store.connection else { return AnyView(EmptyView()) }
        return AnyView(ConversationReviewCard(item: item, projectId: projectId, connection: connection, workers: store.state?.workers ?? [],
                                              open: { openReview(item) },
                                              openTask: { id in Task { await store.select(id) } }))
    }

    /// Place each mentioned record once, under the latest message that mentions it.
    private func placeMentions() {
        var latest: [String: (message: String, item: ProjectWorkItem)] = [:]
        for message in store.detail?.messages ?? [] where message.isProgress != true {
            for item in resolveMentions(reviewMentions(in: message.content), pulls: store.projectPulls, issues: store.projectIssues) {
                latest[item.id] = (message.id, item)
            }
        }
        var cards: [String: [ProjectWorkItem]] = [:]
        for entry in latest.values.sorted(by: { ($0.item.number ?? 0) < ($1.item.number ?? 0) }) { cards[entry.message, default: []].append(entry.item) }
        if cards.mapValues({ $0.map(\.id) }) != mentionCards.mapValues({ $0.map(\.id) }) { mentionCards = cards }
    }

    private var taskFileAction: ((String) -> Void)? {
        guard store.currentTask?.projectId != nil else { return nil }
        return { path in openTaskFile(path) }
    }

    private func openTaskFile(_ path: String) {
        guard let task = store.currentTask, let project = store.projects.first(where: { $0.id == task.projectId }) else { return }
        showToolSheet = false; showInspector = false
        #if os(iOS)
        if horizontalSizeClass == .compact {
            taskPath.append(.file(project: project.id, task: task.id, path: path))
            return
        }
        #endif
        let target = HubTarget(project: project, fileTaskId: task.id, filePath: path)
        Task { try? await Task.sleep(for: .milliseconds(450)); projectHub = target }
    }

    private func startFileTask(project: String, ref: String, path: String) {
        projectHub = nil
        newTaskDraft = "Repository ref: \(ref)\nFocus on repository path: \(path)\n\n" + newTaskDraft
        #if os(iOS)
        if horizontalSizeClass == .compact {
            selectedTab = "tasks"; phoneCompose(project)
            return
        }
        #endif
        beginTask(project)
    }

    /// Continue from task review into the published pull request, preserving task navigation.
    private func openPullRequest(_ pull: ProjectWorkItem?) {
        guard let pull else { return }
        openTaskPull(id: pull.id)
    }

    private func openTaskPull(id: String? = nil) {
        guard let pullId = id ?? store.currentTask?.pull?.id,
              let task = store.currentTask, let projectId = task.projectId,
              let project = store.projects.first(where: { $0.id == projectId }) else { return }
        #if os(iOS)
        if horizontalSizeClass == .compact {
            showToolSheet = false
            taskPath.append(.review(project: projectId, section: "pulls", item: pullId, task: task.id))
            return
        }
        #endif
        let target = HubTarget(project: project, section: "pulls", selected: pullId, composeTask: task.id)
        guard showToolSheet else { projectHub = target; return }
        // Let the review sheet finish dismissing before presenting the project sheet.
        showToolSheet = false
        Task { try? await Task.sleep(for: .milliseconds(450)); projectHub = target }
    }

    private var inspector: some View {
        VStack(spacing: 0) {
            // The section toggle is centred over the review; the Mac close button sits at the trailing edge.
            Picker("Inspector section", selection: panelBinding) {
                Text("Changes").tag("Changes")
                Text("Checks").tag("Checks")
            }.pickerStyle(.segmented).labelsHidden()
                .frame(maxWidth: compactWidth ? .infinity : 320)
                .frame(maxWidth: .infinity)
                #if os(macOS)
                .overlay(alignment: .trailing) {
                    WorkspaceIconButton(label: "Close inspector", icon: .close) { showInspector = false }
                }
                #endif
                .padding(.horizontal, 24).padding(.vertical, 14)
            Divider().opacity(0.45)
            if panel == "Browser" { BrowserPanel(store: store) }
            else { ChangesView(store: store, section: panel, viewFile: taskFileAction, openPullRequest: openPullRequest, openActivityCheck: { check in activitySelection = ActivitySelection(check: check); presentActivity() }) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WorkspaceStyle.canvas(colorScheme))
            .tint(WorkspaceStyle.accent(colorScheme))
    }

}

struct StatusBadge: View {
    let status: String
    var label: String? = nil
    @Environment(\.colorScheme) private var colorScheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private var inactive: Bool {
        #if os(iOS)
        if horizontalSizeClass == .compact { return WorkspaceStyle.phoneStatusTone(status) == .inactive }
        #endif
        return !["succeeded", "done", "merged", "review", "ready", "failed", "error", "running", "checking", "queued", "in_review"].contains(status)
    }
    private var statusColor: Color {
        #if os(iOS)
        return WorkspaceStyle.phoneStatusColor(status, colorScheme)
        #else
        if ["review", "ready"].contains(status) { return WorkspaceStyle.statusAttention(colorScheme) }
        if ["succeeded", "done", "merged"].contains(status) { return WorkspaceStyle.statusHealthy(colorScheme) }
        if ["failed", "error"].contains(status) { return WorkspaceStyle.statusFailed(colorScheme) }
        if ["running", "checking", "queued", "in_review"].contains(status) { return WorkspaceStyle.statusActive(colorScheme) }
        return WorkspaceStyle.statusInactive(colorScheme)
        #endif
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(inactive ? Color.clear : statusColor)
                .overlay(Circle().strokeBorder(statusColor, lineWidth: 1)).frame(width: 5, height: 5)
            Text(label ?? (status == "review" ? "Ready to review" : ["succeeded", "done"].contains(status) ? "Done" : status.capitalized)).font(.system(.caption, weight: .medium))
        }.padding(.vertical, 4)
        #if os(iOS)
        .foregroundStyle(statusColor)
        #endif
    }
}

struct TranscriptView: View {
    let messages: [Message]
    /// The task's detail has not arrived yet: show progress, not the new-task empty state.
    var loading = false
    let events: [WorkspaceEvent]
    let activity: [TaskActivity]
    let active: Bool
    let jobs: [WorkspaceJob]
    let workers: [Worker]
    var openActivity: () -> Void = {}
    var openTurnActivity: (String) -> Void = { _ in }
    var conversationSelection: ActivitySelection? = nil
    var activitySelected = false
    @State private var highlightedRun: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var activityColorScheme
    /// Live pull request and issue cards placed under the message that last mentions them.
    var reviewCards: [String: [ProjectWorkItem]] = [:]
    var reviewCard: ((ProjectWorkItem) -> AnyView)? = nil
    var fileLinks: MessageFileLinks? = nil
    var runs: [Run] = []
    /// Changes when you send or queue a message: follow it, and the reply after it.
    var followRequest = 0
    @Binding var bookmark: TranscriptBookmark
    @Environment(\.taskMedia) private var attachments
    @State private var visibleID: String?
    @State private var restored = false
    @State private var followPass = 0
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private var follow: Bool { bookmark.follow }
    var body: some View {
        ScrollViewReader { reader in
            VStack(spacing: 0) {
                ScrollView(.vertical) {
                    // Not lazy: estimated heights of unrendered Markdown rows made scrolls to the end
                    // land short, or past the drawn rows, as replies arrived.
                    VStack(alignment: .leading, spacing: 22) {
                        if messages.isEmpty && loading {
                            ProgressView().controlSize(.regular).frame(maxWidth: .infinity).padding(.vertical, 40)
                                .accessibilityLabel("Loading conversation")
                        } else if messages.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Let’s build something.").font(.title3.weight(.semibold))
                                Text("Describe a change, ask a question, or share an idea. This conversation stays with your project on every device.")
                                    .foregroundStyle(.secondary).lineSpacing(4)
                            }.padding(.vertical, 25)
                        }
                        ForEach(messages.filter { $0.isProgress != true }) { message in
                            if message.role == "assistant",
                               messages.first(where: { $0.runId == message.runId && $0.role == "assistant" && $0.isProgress != true })?.id == message.id,
                               let turn = activity.first(where: { $0.id == message.runId }) {
                                TaskActivityView(activity: turn, run: runs.first { $0.id == turn.id }, progress: messages.filter { $0.runId == turn.id && $0.isProgress == true }, jobs: jobs.filter { $0.runId == turn.id }, workers: workers, openActivity: { openTurnActivity(turn.id) })
                                AttachmentStrip(rows: attachments.filter { $0.source == "computer-use" && $0.runId == turn.id }, computer: true)
                            }
                            MessageView(message: message, fileLinks: fileLinks).id(message.id)
                                .background(highlightedRun != nil && highlightedRun == message.runId ? WorkspaceStyle.selected(activityColorScheme) : .clear)
                            AttachmentStrip(rows: attachments.filter { attachment in
                                attachment.source != "computer-use" && !message.content.contains("/attachments/" + attachment.id) &&
                                (attachment.messageId == message.id || message.attachmentIds?.contains(attachment.id) == true ||
                                 (attachment.source == "agent" && attachment.runId != nil && attachment.runId == message.runId && messages.last(where: { $0.role == "assistant" && $0.runId == message.runId && $0.isProgress != true })?.id == message.id))
                            }, trailing: message.role == "user")
                            if let reviewCard, let items = reviewCards[message.id] {
                                ForEach(items) { item in
                                    // The transcript column is the composer's width, so cards fill it exactly.
                                    reviewCard(item).frame(maxWidth: .infinity)
                                }
                            }
                            if message.role == "assistant",
                               messages.last(where: { $0.role == "assistant" && $0.runId == message.runId && $0.isProgress != true })?.id == message.id {
                                ReplyActionsView(message: message, run: runs.first(where: { $0.id == message.runId }))
                            }
                        }
                        ForEach(activity.filter { turn in !messages.contains(where: { $0.runId == turn.id && $0.role == "assistant" && $0.isProgress != true }) }) { turn in
                            TaskActivityView(activity: turn, run: runs.first { $0.id == turn.id }, progress: messages.filter { $0.runId == turn.id && $0.isProgress == true }, jobs: jobs.filter { $0.runId == turn.id }, workers: workers, openActivity: { openTurnActivity(turn.id) })
                            AttachmentStrip(rows: attachments.filter { $0.source == "computer-use" && $0.runId == turn.id }, computer: true)
                            AttachmentStrip(rows: attachments.filter { $0.source == "agent" && $0.runId == turn.id })
                        }
                        ForEach(runs.filter { run in !messages.contains(where: { $0.role == "assistant" && $0.runId == run.id && $0.isProgress != true }) }) { run in
                            AgentContextView(run: run)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.scrollTargetLayout()
                        // Same column as the composer (content width inside its gutters), so
                        // messages, cards and the text box share one centered edge.
                        .frame(maxWidth: WorkspaceStyle.contentWidth - 2 * WorkspaceStyle.conversationGutter)
                        .frame(maxWidth: .infinity)
                }
                // Gutters are scroll content margins, not padding around the target layout.
                // With padding outside the layout, edge-based restores (a transcript shorter
                // than the viewport) aligned the layout's top-leading corner to the viewport
                // and left the content offset sideways by the gutter.
                .contentMargins(.horizontal, WorkspaceStyle.conversationGutter, for: .scrollContent)
                .contentMargins(.top, 20, for: .scrollContent)
                .contentMargins(.bottom, 16, for: .scrollContent)
                .modifier(TranscriptScrollTracking(bookmark: $bookmark, visibleID: $visibleID, restored: restored,
                                                   pinToEnd: { followToEnd(reader) }))
                if active || !follow {
                    HStack {
                        Spacer()
                        WorkspaceIconButton(label: follow ? "Following output" : "Jump to latest", icon: .jump, pressed: follow) {
                            bookmark.follow = true
                            visibleID = "bottom"
                            followToEnd(reader)
                        }.padding(.horizontal, WorkspaceStyle.conversationGutter)
                    }
                }
            }
            .onAppear { restore(reader) }
            .onChange(of: conversationSelection) { _, selection in
                guard let runId = selection?.runId, let message = messages.first(where: { $0.runId == runId && $0.role == "assistant" && $0.isProgress != true }) else { return }
                bookmark.follow = false; highlightedRun = runId
                withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { reader.scrollTo(message.id, anchor: .center) }
                Task { try? await Task.sleep(for: .seconds(2)); if highlightedRun == runId { highlightedRun = nil } }
            }
            .onChange(of: messages) { _, _ in
                if !restored { restore(reader) }
                else if follow { followToEnd(reader) }
            }
            .onChange(of: followRequest) { _, _ in
                var updated = bookmark
                updated.follow = true
                updated.anchor = nil
                updated.offset = nil
                bookmark = updated
                visibleID = "bottom"
                followToEnd(reader)
            }
            .onChange(of: jobs) { _, _ in if follow { followToEnd(reader) } }
            .onChange(of: activity) { _, _ in if follow { followToEnd(reader) } }
            .onChange(of: visibleID) { _, next in
                if restored, let next {
                    if #available(macOS 15, iOS 18, *) {} else {
                        bookmark.follow = next == "bottom"
                        if !bookmark.follow { bookmark.anchor = next }
                    }
                }
            }
            .onDisappear { if restored, !follow, let visibleID { bookmark.anchor = visibleID } }
        }
    }
    /// Markdown messages settle their height over a few layout passes, so one scroll to the end lands
    /// short when a long message arrives. Repeat it briefly while still following.
    private func followToEnd(_ reader: ScrollViewProxy) {
        followPass += 1
        let pass = followPass
        Task { @MainActor in
            for delay in [0, 80, 200, 450, 900] {
                if delay > 0 { try? await Task.sleep(for: .milliseconds(delay)) }
                guard pass == followPass, bookmark.follow else { return }
                reader.scrollTo("bottom", anchor: .bottom)
            }
        }
    }
    private func restore(_ reader: ScrollViewProxy) {
        guard !messages.isEmpty, !restored else { return }
        if !bookmark.follow, bookmark.offset != nil { restored = true; return }
        if let anchor = bookmark.anchor, !bookmark.follow {
            reader.scrollTo(anchor, anchor: .top)
        } else { visibleID = "bottom"; followToEnd(reader) }
        restored = true
    }
}

struct TranscriptBookmark {
    var anchor: String?
    var offset: CGFloat?
    var follow = true
}

private struct TranscriptScrollTracking: ViewModifier {
    @Binding var bookmark: TranscriptBookmark
    @Binding var visibleID: String?
    let restored: Bool
    let pinToEnd: () -> Void
    func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content.modifier(PreciseTranscriptScroll(bookmark: $bookmark, restored: restored, pinToEnd: pinToEnd))
        } else { content.scrollPosition(id: $visibleID, anchor: .top) }
    }
}

@available(macOS 15, iOS 18, *)
private struct PreciseTranscriptScroll: ViewModifier {
    @Binding var bookmark: TranscriptBookmark
    let restored: Bool
    /// Scrolls to the end through the transcript's reader (the "bottom" sentinel), not by edge.
    let pinToEnd: () -> Void
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var userScrolling = false
    @State private var geometry = TranscriptGeometry(offset: 0, height: 0, viewport: 0, nearBottom: true)
    @FocusState private var scrollFocused: Bool
    init(bookmark: Binding<TranscriptBookmark>, restored: Bool, pinToEnd: @escaping () -> Void) {
        _bookmark = bookmark
        self.restored = restored
        self.pinToEnd = pinToEnd
        let saved = bookmark.wrappedValue
        _position = State(initialValue: saved.follow ? ScrollPosition(edge: .bottom) : ScrollPosition(point: CGPoint(x: 0, y: saved.offset ?? 0)))
    }
    func body(content: Content) -> some View {
        content.scrollPosition($position)
            .focusable().focused($scrollFocused).focusEffectDisabled()
            .background {
                Color.clear.contentShape(Rectangle()).onTapGesture { scrollFocused = true }
            }
            .onKeyPress(keys: [.upArrow, .downArrow, .pageUp, .pageDown, .home, .end]) { key in
                scroll(key)
            }
            .accessibilityLabel("Conversation")
            .onAppear { restore() }
            .onChange(of: restored) { _, _ in restore() }
            .onScrollPhaseChange { _, phase in
                userScrolling = phase == .interacting || phase == .decelerating
                if restored, userScrolling { bookmark.follow = false }
            }
            // The transcript only scrolls vertically. Its resting horizontal offset is minus the leading content
            // margin (the gutter), not zero: snapping to zero pushed every line flush against the left edge after
            // an edge restore. Return any sideways drift to the resting offset instead.
            .onScrollGeometryChange(for: HorizontalDrift.self) {
                HorizontalDrift(offset: $0.contentOffset.x, resting: -$0.contentInsets.leading, vertical: $0.contentOffset.y)
            } action: { _, drift in
                // Correct only x: pass the live vertical offset, because `scrollTo(x:)` keeps the
                // position's last stored y, which undid scrolls to the end made through the reader.
                if abs(drift.offset - drift.resting) > 0.5 {
                    position.scrollTo(point: CGPoint(x: drift.resting, y: drift.vertical))
                }
            }
            .onScrollGeometryChange(for: TranscriptGeometry.self) { geometry in
                TranscriptGeometry(offset: geometry.contentOffset.y, height: geometry.contentSize.height, viewport: geometry.containerSize.height,
                    nearBottom: geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 48)
            } action: { _, next in
                geometry = next
                guard restored else { return }
                if userScrolling {
                    var updated = bookmark
                    updated.offset = next.offset
                    updated.follow = next.nearBottom
                    bookmark = updated
                } else if bookmark.follow, !next.nearBottom, next.height > next.viewport {
                    // Following: your message, the reply or the keyboard moved the end out of view.
                    pinToEnd()
                } else if !bookmark.follow, let saved = bookmark.offset, abs(saved - next.offset) > 1 {
                    position.scrollTo(point: CGPoint(x: 0, y: saved))
                }
            }
            .onChange(of: bookmark.follow) { _, following in
                if restored, following, !userScrolling { pinToEnd() }
            }
    }
    private func scroll(_ key: KeyPress) -> KeyPress.Result {
        guard scrollFocused else { return .ignored }
        // Navigation keys may also carry numeric-pad or function flags on macOS.
        let modifiers = key.modifiers.intersection([.shift, .control, .option, .command])
        let commandArrow = modifiers == .command && [.upArrow, .downArrow].contains(key.key)
        guard modifiers.isEmpty || commandArrow else { return .ignored }
        let maximum = max(0, geometry.height - geometry.viewport)
        let page = max(40, geometry.viewport - 40)
        let target: CGFloat
        switch key.key {
        case .home: target = 0
        case .end: target = maximum
        case .pageUp: target = geometry.offset - page
        case .pageDown: target = geometry.offset + page
        case .upArrow: target = key.modifiers.contains(.command) ? 0 : geometry.offset - 40
        case .downArrow: target = key.modifiers.contains(.command) ? maximum : geometry.offset + 40
        default: return .ignored
        }
        let next = min(maximum, max(0, target))
        var updated = bookmark
        updated.offset = next
        updated.follow = next >= maximum
        bookmark = updated
        position.scrollTo(point: CGPoint(x: 0, y: next))
        return .handled
    }
    private func restore() {
        if restored, !bookmark.follow, let offset = bookmark.offset { position.scrollTo(point: CGPoint(x: 0, y: offset)) }
        else if restored, bookmark.follow { position.scrollTo(edge: .bottom) }
    }
}
private struct HorizontalDrift: Equatable {
    let offset: CGFloat
    let resting: CGFloat
    let vertical: CGFloat
}
private struct TranscriptGeometry: Equatable {
    let offset: CGFloat
    let height: CGFloat
    let viewport: CGFloat
    let nearBottom: Bool
}

struct MessageView: View {
    let message: Message
    var fileLinks: MessageFileLinks? = nil
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 28)
                MessageContent(content: message.content, fileLinks: fileLinks).equatable()
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(WorkspaceStyle.userMessage(colorScheme), in: RoundedRectangle(cornerRadius: 18))
            }
        } else {
            MessageContent(content: message.content, fileLinks: fileLinks).equatable().frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, WorkspaceStyle.messageInset)
        }
    }
}

struct HubTarget: Identifiable {
    let project: Project
    var id: String { project.id }
    var section = "repository"
    var selected = ""
    var composeTask: String? = nil
    var fileTaskId: String? = nil
    var filePath = ""
}
