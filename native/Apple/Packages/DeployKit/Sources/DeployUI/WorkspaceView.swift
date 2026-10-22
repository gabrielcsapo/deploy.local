import SwiftUI
import DeployCore
#if os(macOS)
import AppKit
#endif
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
    @State private var phoneInspector = false
    @AppStorage("workspace.split.tabs") private var splitTabsData = Data()
    @AppStorage("workspace.split.width") private var splitWidth = 400.0
    @AppStorage("workspace.split.migrated") private var splitMigrated = false
    @State private var splitExpanded = false
    @FocusState private var splitToggleFocused: String?
    @State private var splitOpener = "Changes"
    private var splitTab: String? {
        get { (try? JSONDecoder().decode([String: String].self, from: splitTabsData))?[store.selectedTaskId ?? ""] }
        nonmutating set {
            var tabs = (try? JSONDecoder().decode([String: String].self, from: splitTabsData)) ?? [:]
            tabs[store.selectedTaskId ?? ""] = newValue
            splitTabsData = (try? JSONEncoder().encode(tabs)) ?? Data()
            if newValue != "Changes" { splitExpanded = false }
            if newValue == nil { splitToggleFocused = splitOpener }
        }
    }
    private var showInspector: Bool {
        get { compactWidth ? phoneInspector : splitTab == "Changes" }
        nonmutating set { if newValue { splitOpener = "Changes" }; if compactWidth { phoneInspector = newValue } else { splitTab = newValue ? "Changes" : nil } }
    }
    @State private var composerHeight: CGFloat = 0
    @AppStorage("workspace.activity.mode") private var legacyActivityMode = "closed"
    private var activityMode: String {
        get { splitTab == "Activity" ? "open" : "closed" }
        nonmutating set { splitTab = newValue == "open" ? "Activity" : nil }
    }
    @AppStorage("workspace.activity.width") private var legacyActivityWidth = 400.0
    @State private var showActivitySheet = false
    #if os(macOS)
    @State private var backStack: [String] = []
    @State private var forwardStack: [String] = []
    @State private var historyNavigation = false
    #endif
    @State private var activityOpenedByKeyboard = false
    @FocusState private var activityToggleFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var activitySelection: ActivitySelection?
    @State private var conversationSelection: ActivitySelection?
    /// Threads whose computer viewer is open. The viewer belongs to one thread: opening it on one
    /// task never shows it on another task, even in the same project.
    @State private var computerTaskIds: Set<String> = []
    private var showComputer: Bool {
        get { compactWidth ? store.selectedTaskId.map(computerTaskIds.contains) ?? false : splitTab == "Computer" }
        nonmutating set {
            if newValue { splitOpener = "Computer" }
            if !compactWidth { splitTab = newValue ? "Computer" : nil; return }
            guard let id = store.selectedTaskId else { return }
            if newValue { computerTaskIds.insert(id) } else { computerTaskIds.remove(id) }
        }
    }
    private var showComputerBinding: Binding<Bool> { Binding(get: { showComputer }, set: { showComputer = $0 }) }
    @State private var search = ""
    @State private var searchOpen = false
    @State private var attentionOnly = false
    @State private var allRecents = false
    @AppStorage("deploy.sidebar.recents-collapsed") private var recentsCollapsed = false
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
        store.activitySummary
    }
    @State private var transcriptBookmarks: [String: TranscriptBookmark] = [:]
    @State private var mentionCards: [String: [ProjectWorkItem]] = [:]
    @State private var showAccount = false
    @State private var section = "Tasks"
    @State private var repositoryId: String?
    @State private var computerId: String?
    @State private var computers: [Computer] = []
    @State private var computersLoaded = false
    @State private var computersError = ""
    @State private var showEnrollment = false
    @State private var revokeWorker: Worker?
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
        .overlay(alignment: .bottom) {
            if store.undoClosedTask != nil {
                HStack { Text("Marked done ·"); Button("Undo") { Task { await store.undoMarkDone() } }.buttonStyle(.workspaceLink).disabled(store.busy) }
                    .font(WorkspaceStyle.metadata).padding(WorkspaceStyle.space3)
                    .background(WorkspaceStyle.surface(colorScheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
                    .padding(WorkspaceStyle.space4).accessibilityElement(children: .contain)
            }
        }
        .tint(WorkspaceStyle.accent(colorScheme))
        .onAppear { migrateSplitPreference() }
        .onChange(of: store.undoClosedTask?.id) { _, id in if id != nil { AccessibilityNotification.Announcement("Marked done. Undo available.").post() } }
        .onChange(of: store.selectedTaskId) { _, _ in activitySelection = nil; conversationSelection = nil; splitExpanded = false; migrateSplitPreference() }
        .task { await store.start() }
        .task(id: store.currentTask?.workerId) {
            while !Task.isCancelled { await loadComputers(); try? await Task.sleep(for: .seconds(4)) }
        }
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
        .onChange(of: store.connection) { _, _ in pendingQuestionTaskIDs = []; computers = []; computersLoaded = false; computerId = nil; repositoryId = nil }
        .sheet(isPresented: $showEnrollment) {
            if let connection = store.connection { ComputerEnrollmentSheet(connection: connection) }
        }
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
        .sheet(isPresented: Binding(get: { compactWidth && showComputer }, set: { showComputer = $0 })) {
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
            } else if section == "Repositories" {
                repositoryDetail
            } else if section == "Computers" {
                computerDetail
            } else {
                VStack(spacing: 0) {
                    connectionBanner
                    if showTask || store.currentTask == nil {
                        NewConversationView(store: store, draft: $newTaskDraft, workerId: $newTaskWorkerId, initialProjectId: newTaskProject) {
                            showTask = false
                        }.id(newTaskProject)
                    } else { workspace }
                }
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
                HStack(spacing: WorkspaceStyle.Toolbar.spacing) {
                    WorkspaceIconButton(label: "Toggle sidebar", icon: .navigation, pressed: columnVisibility != .detailOnly, shortcut: "⌘⌃S") {
                        withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly }
                    }
                        .accessibilityLabel("Toggle sidebar").accessibilityIdentifier("toolbar-navigation")
                        .keyboardShortcut("s", modifiers: [.command, .control])
                    // Back and forward through the tasks you've opened, like the Codex app and a browser.
                    WorkspaceIconButton(label: "Back", icon: .chevronLeft, shortcut: "⌘[") { goBack() }
                        .keyboardShortcut("[", modifiers: .command).disabled(backStack.isEmpty)
                    WorkspaceIconButton(label: "Forward", icon: .chevron, shortcut: "⌘]") { goForward() }
                        .keyboardShortcut("]", modifiers: .command).disabled(forwardStack.isEmpty)
                }
            }.workspaceToolbarChrome()
            ToolbarItem(placement: .principal) {
                if section == "Tasks" { conversationTitle }
                else { Text(section == "Repositories" ? store.projects.first(where: { $0.id == repositoryId })?.name ?? section : computers.first(where: { $0.id == computerId })?.name ?? section).font(WorkspaceStyle.navigation) }
            }.workspaceToolbarChrome()
            ToolbarItem(placement: .primaryAction) { if section == "Tasks" { taskToolbar } }.workspaceToolbarChrome()
        }
        #endif
        .onChange(of: showInspector) { _, shown in if shown { composerFocused = false } }
        #if os(macOS)
        .onChange(of: store.selectedTaskId) { previous, next in
            if historyNavigation { historyNavigation = false; return }
            guard let previous, previous != next else { return }
            backStack.append(previous)
            if backStack.count > 50 { backStack.removeFirst() }
            forwardStack = []
        }
        #endif
    }

    #if os(macOS)
    private func historyStep(from source: inout [String], to destination: inout [String]) {
        let known = Set(store.tasks.map(\.id))
        while let target = source.popLast() {
            guard known.contains(target), target != store.selectedTaskId else { continue }
            if let current = store.selectedTaskId { destination.append(current) }
            historyNavigation = true
            section = "Tasks"
            showTask = false
            Task { await store.select(target) }
            return
        }
    }
    private func goBack() { historyStep(from: &backStack, to: &forwardStack) }
    private func goForward() { historyStep(from: &forwardStack, to: &backStack) }
    #endif

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
                    .navigationDestination(isPresented: Binding(get: { computerId != nil }, set: { if !$0 { computerId = nil } })) { computerDetail }
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
            if store.state == nil && store.error == nil { WorkspaceSkeleton(variant: .sidebar) }
            if !pinnedTasks(tree).isEmpty { Section("Pinned") { ForEach(pinnedTasks(tree)) { task in phoneTaskRow(task, tree: tree, pinned: true) } } }
            Section("Projects") {
                if tree.groups.isEmpty {
                    if store.state != nil { taskTreeEmptyState }
                } else {
                    ForEach(tree.groups) { group in
                        TaskTreeGroup(group: group, searching: tree.isSearching || attentionOnly, idle: idleProject(group), compact: true, selectedTaskId: store.selectedTaskId,
                                      canCompose: store.connection != nil, needsYou: needsYou, compose: { phoneCompose(group.project?.id ?? "") }) { task in
                            phoneTaskRow(task, tree: tree)
                        }
                    }
                }
            }
            Section {
                if !recentsCollapsed {
                    ForEach(visibleRecents(tree)) { task in phoneTaskRow(task, tree: tree, recent: true) }
                    if !tree.isSearching && recentTasks(tree).count > 8 { Button(allRecents ? "Show less" : "Show more") { allRecents.toggle() }.buttonStyle(.workspaceLink) }
                }
            } header: { recentsHeader }

        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(WorkspaceStyle.space2)
        .environment(\.defaultMinListRowHeight, WorkspaceStyle.IconAction.touch)
        .safeAreaInset(edge: .top, spacing: 0) { connectionBanner }
        .navigationTitle("deploy.local").navigationBarTitleDisplayMode(.large)
        .searchable(text: $search, isPresented: $searchOpen, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tasks")
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

    private func phoneTaskRow(_ task: WorkspaceTask, tree: TaskTree, recent: Bool = false, pinned: Bool = false) -> some View {
        NavigationLink(value: PhoneRoute.task(task.id)) {
            if recent {
                RecentTaskTreeRow(task: task, status: taskTreeStatus(task), selected: !showTask && store.selectedTaskId == task.id,
                                  searching: tree.isSearching || attentionOnly, group: tree.groups.first { $0.tasks.contains { $0.id == task.id } })
            } else { TaskTreeRow(task: task, status: taskTreeStatus(task), selected: !showTask && store.selectedTaskId == task.id && (pinned || !store.pinnedTaskIDs.contains(task.id)), selectedInk: store.selectedTaskId == task.id) }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button { store.togglePin(task.id) } label: { Label { Text(store.pinnedTaskIDs.contains(task.id) ? "Unpin" : "Pin") } icon: { WorkspaceGlyph(name: .pin) } }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !["done", "merged"].contains(task.status) {
                Button { Task { await store.markDone(task) } } label: { Label { Text("Mark done") } icon: { WorkspaceGlyph(name: .check) } }
                    .disabled(TaskTree.isRunning(task) || store.busy)
            }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: WorkspaceStyle.space4, bottom: 0, trailing: WorkspaceStyle.space4))
    }

    @ViewBuilder private func phoneDestination(_ route: PhoneRoute) -> some View {
        switch route {
        case .task(let id):
            VStack(spacing: 0) {
                connectionBanner
                if phoneUsesExpandedTitle { phoneConversationTitle.frame(maxWidth: .infinity).padding(16) }
                if store.currentTask?.id == id { workspace }
                else { WorkspaceSkeleton(label: "Loading task").frame(maxWidth: .infinity, maxHeight: .infinity) }
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
            // Not in a ScrollView: the composer docks at the bottom (above the keyboard) under the
            // centred prompt, which a scroll container would collapse to the top.
            NewConversationView(store: store, draft: $newTaskDraft, workerId: $newTaskWorkerId, initialProjectId: newTaskProject) {
                showTask = false
                if let id = store.selectedTaskId { taskPath = [.task(id)] }
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
                if section != "Tasks" { sectionSidebar }
                else {
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
                        }.font(WorkspaceStyle.navigation).frame(minHeight: WorkspaceStyle.taskNavigationHeight)
                    }.buttonStyle(TaskNavigationButtonStyle()).padding(.horizontal, WorkspaceStyle.space2).disabled(store.connection == nil).keyboardShortcut("n")
                    if searchOpen { searchField }
                    ScrollView { taskTree }
                }
            }.background(WorkspaceStyle.sidebar(colorScheme))
        }
    }

    #if os(macOS)
    private var utilityRail: some View {
        VStack(spacing: 16) {
            WorkspaceGlyph(name: .brand, size: 20).foregroundStyle(WorkspaceStyle.accent(colorScheme)).frame(height: 34).help("deploy.local")
            railButton("Tasks", icon: .chat, selected: section == "Tasks") { section = "Tasks" }
            railButton("Repositories", icon: .folder, selected: section == "Repositories") { section = "Repositories" }
            railButton("Computers", icon: .computer, selected: section == "Computers") { section = "Computers" }
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
        }.buttonStyle(.plain).foregroundStyle(selected ? .primary : .secondary).help(title).accessibilityLabel(title).accessibilityAddTraits(selected ? [.isSelected] : [])
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
    // The tree is built once per render and passed down; rebuilding it per row made the sidebar
    // quadratic in the number of tasks.
    private func recentTasks(_ tree: TaskTree) -> [WorkspaceTask] {
        tree.groups.flatMap(\.tasks).filter { !store.pinnedTaskIDs.contains($0.id) && !["done", "merged"].contains($0.status) }.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }
    private func pinnedTasks(_ tree: TaskTree) -> [WorkspaceTask] {
        tree.groups.flatMap(\.tasks).filter { store.pinnedTaskIDs.contains($0.id) }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private func idleProject(_ group: TaskTree.Group) -> Bool {
        TaskTree.isIdle(store.tasks.filter { $0.projectId == group.project?.id })
    }
    private var recentsHeader: some View {
        Button { recentsCollapsed.toggle() } label: {
            HStack(spacing: WorkspaceStyle.space1) {
                Text("Recents")
                WorkspaceGlyph(name: .chevron, size: WorkspaceStyle.IconAction.compactGlyph).rotationEffect(.degrees(recentsCollapsed ? 0 : 90))
            }
        }.buttonStyle(.plain).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
            .accessibilityValue(recentsCollapsed ? "Collapsed" : "Expanded")
    }
    private func visibleRecents(_ tree: TaskTree) -> [WorkspaceTask] {
        let recents = recentTasks(tree)
        return allRecents || tree.isSearching ? recents : Array(recents.prefix(8))
    }
    private var taskTree: some View {
        let tree = taskTreeModel
        return VStack(alignment: .leading, spacing: 0) {
            if store.state == nil && store.error == nil { WorkspaceSkeleton(variant: .sidebar) }
            if !pinnedTasks(tree).isEmpty {
                Text("Pinned").font(WorkspaceStyle.metadata).foregroundStyle(.secondary).padding(.horizontal, WorkspaceStyle.space2).padding(.top, WorkspaceStyle.space4).padding(.bottom, WorkspaceStyle.space1)
                ForEach(pinnedTasks(tree)) { task in taskRow(task, tree: tree, pinned: true) }
            }
            Text(attentionOnly ? "Needs you" : "Projects").font(WorkspaceStyle.metadata).foregroundStyle(.secondary).padding(.horizontal, WorkspaceStyle.space2).padding(.top, WorkspaceStyle.space4).padding(.bottom, WorkspaceStyle.space1)
            if store.state != nil && tree.groups.isEmpty { taskTreeEmptyState }
            ForEach(tree.groups.filter { !attentionOnly || !$0.tasks.isEmpty }) { group in
                TaskTreeGroup(group: group, searching: tree.isSearching || attentionOnly, idle: idleProject(group), selectedTaskId: showTask ? nil : store.selectedTaskId,
                              canCompose: store.connection != nil, needsYou: needsYou, compose: { beginTask(group.project?.id ?? "") }) { task in
                    taskRow(task, tree: tree, indented: true)
                }
            }
            recentsHeader.padding(.horizontal, WorkspaceStyle.space2).padding(.top, WorkspaceStyle.space4).padding(.bottom, WorkspaceStyle.space1)
            if !recentsCollapsed { ForEach(visibleRecents(tree)) { task in taskRow(task, tree: tree, recent: true) } }
            if !recentsCollapsed && !tree.isSearching && recentTasks(tree).count > 8 {
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

    private var sectionSidebar: some View {
        VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
            Text(section).font(WorkspaceStyle.navigation.weight(.semibold)).frame(minHeight: WorkspaceStyle.resourceRowHeight)
            Button(section == "Repositories" ? "New repository" : "Connect a computer") {
                if section == "Repositories" { showProject = true } else { showEnrollment = true }
            }.buttonStyle(.workspacePrimary).disabled(store.connection == nil)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if section == "Repositories" {
                        ForEach(store.projects) { project in
                            WorkspaceListRow(icon: .folder, title: project.name, selected: repositoryId == project.id) { repositoryId = project.id }
                        }
                        if store.state == nil && store.error == nil { WorkspaceSkeleton(label: "Loading repositories") }
                        else if store.projects.isEmpty { Text("No repositories yet").font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
                    } else {
                        if !computersError.isEmpty {
                            Text(computersError).font(WorkspaceStyle.metadata)
                            Button("Retry") { Task { await loadComputers() } }.buttonStyle(.workspaceLink)
                        }
                        ForEach(computers) { computer in
                            WorkspaceListRow(icon: .computer, title: computer.name, selected: computerId == computer.id) { computerId = computer.id }
                                .help("\(computer.platform) · \(computer.roleSummary)")
                        }
                        if !computersLoaded && computersError.isEmpty { WorkspaceSkeleton(label: "Loading computers") }
                        if computersLoaded && computers.isEmpty { Text("No computers connected").font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
                    }
                }
            }
        }.padding(.horizontal, WorkspaceStyle.space2)
        .task(id: section) {
            guard section == "Computers" else { return }
            while !Task.isCancelled {
                await loadComputers()
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    @ViewBuilder private var repositoryDetail: some View {
        if let connection = store.connection, let project = store.projects.first(where: { $0.id == repositoryId }) {
            ProjectHubView(project: project, connection: connection, isPushed: true, tasks: store.tasks, workers: store.state?.workers ?? [],
                           newTaskFromFile: { ref, path in startFileTask(project: project.id, ref: ref, path: path) }) { id in
                section = "Tasks"; showTask = false
                Task { await store.select(id) }
            }.id(project.id)
        } else { Text(repositoryId == nil ? "Select a repository" : "Repository unavailable").foregroundStyle(.secondary) }
    }

    @ViewBuilder private var computerDetail: some View {
        if let connection = store.connection, let computer = computers.first(where: { $0.id == computerId }) {
            ComputerDetailView(computer: computer, connection: connection, workers: store.state?.workers ?? [], refresh: loadComputers) { revokeWorker = $0 }.id(computer.id)
        } else { Text(computerId == nil ? "Select a computer" : "Computer unavailable").foregroundStyle(.secondary) }
    }

    private func loadComputers() async {
        guard let connection = store.connection else { return }
        do {
            let inventory: ComputerInventory = try await WorkspaceClient(connection: connection).request("/api/computers")
            guard !Task.isCancelled, store.connection == connection else { return }
            computers = inventory.computers; computersLoaded = true; computersError = ""
        } catch { if !Task.isCancelled { computersError = coordinatorErrorDescription(error) } }
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
        section = "Tasks"
        newTaskProject = projectId
        showTask = true
        compactColumn = .detail
    }

    private func taskTreeStatus(_ task: WorkspaceTask) -> String {
        let pending = task.needsApproval || pendingQuestionTaskIDs.contains(task.id)
            || (store.detail?.task.id == task.id && store.detail?.questions?.contains(where: { $0.status == "pending" }) == true)
        return pending ? "waiting" : task.status
    }

    private func taskRow(_ task: WorkspaceTask, tree: TaskTree, recent: Bool = false, indented: Bool = false, pinned: Bool = false) -> some View {
        SidebarTaskActions(task: task, store: store) { hideSignal in
        Button {
            showTask = false
            compactColumn = .detail
            Task { await store.select(task.id) }
        } label: {
            if recent {
                RecentTaskTreeRow(task: task, status: taskTreeStatus(task), selected: !showTask && store.selectedTaskId == task.id,
                                  searching: tree.isSearching || attentionOnly, group: tree.groups.first { $0.tasks.contains { $0.id == task.id } }, hideSignal: hideSignal, reserveActions: true)
            } else { TaskTreeRow(task: task, status: taskTreeStatus(task), selected: !showTask && store.selectedTaskId == task.id && (pinned || !store.pinnedTaskIDs.contains(task.id)), selectedInk: store.selectedTaskId == task.id, indent: indented ? WorkspaceStyle.space6 : 0, hideSignal: hideSignal, reserveActions: true) }
        }.buttonStyle(.plain).help(task.title)
            // Hovering a row loads its conversation in the background, so the click shows it at once.
            .onHover { inside in if inside { Task { await store.prefetch(task.id) } } }
        }
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
                    let takeover = compactWidth ? showInspector : splitTab != nil && (splitExpanded || geometry.size.width < max(900, splitWidth + 360))
                    HStack(spacing: 0) {
                        conversation(showSummary: InteractionLayout.composerActivityVisible(card: taskCardFits(geometry.size.width), mode: splitTab == nil && !showActivitySheet ? "closed" : "open", running: activitySummary.runningCount, failing: activitySummary.failingCount))
                            .frame(maxWidth: .infinity)
                            .opacity(takeover ? 0 : 1).allowsHitTesting(!takeover).accessibilityHidden(takeover)
                            .overlay { if compactWidth && showInspector { inspector } }
                            .overlay(alignment: .topTrailing) {
                                if taskCardFits(geometry.size.width) && !showInspector {
                                    TaskContextCard(width: InteractionLayout.taskCardWidth(pane: geometry.size.width, reading: WorkspaceStyle.contentWidth) ?? 216, maximumHeight: max(0, geometry.size.height - composerHeight - 2 * WorkspaceStyle.space4), detail: store.detail, diff: store.diff, workers: store.state?.workers ?? [], project: store.selectedProject?.name,
                                                    changes: { panel = "Changes"; showInspector = true }, activity: openActivity,
                                                    sources: { activitySelection = ActivitySelection(sources: true); presentActivity() }, keyboardActivity: openActivityFromKeyboard)
                                        .padding(WorkspaceStyle.space4).transition(.opacity)
                                }
                            }
                    }
                    .padding(.trailing, !compactWidth && splitTab != nil && !takeover ? splitWidth : 0)
                    .overlay(alignment: .trailing) {
                        if !compactWidth {
                            TaskRightSplit(tab: Binding(get: { splitTab }, set: { splitTab = $0 }), width: $splitWidth, expanded: $splitExpanded, takeover: takeover) {
                                ZStack {
                                    BrowserPanel(store: store, onReveal: { splitTab = "Computer" }, isVisible: splitTab == "Computer", onClose: { splitTab = nil })
                                        .opacity(splitTab == "Computer" ? 1 : 0).allowsHitTesting(splitTab == "Computer").accessibilityHidden(splitTab != "Computer")
                                    if splitTab == "Changes" { inspector }
                                    if splitTab == "Activity" { activityInspector }
                                }
                            }
                            .frame(width: takeover ? geometry.size.width : splitTab == nil ? 0 : splitWidth)
                            .clipped().opacity(splitTab == nil ? 0 : 1).allowsHitTesting(splitTab != nil).accessibilityHidden(splitTab == nil)
                        }
                    }
                    .animation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion), value: splitTab)
                    .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: takeover)
                    .onKeyPress(.escape) { if splitTab != nil { splitTab = nil; return .handled }; return .ignored }
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

    private func migrateSplitPreference() {
        guard !splitMigrated, store.selectedTaskId != nil else { return }
        splitWidth = InteractionLayout.splitWidth(legacyActivityWidth)
        if legacyActivityMode == "open", splitTab == nil { splitTab = "Activity" }
        splitMigrated = true
    }
    private var taskComputer: Computer? { computers.first { $0.workerIds.contains(store.currentTask?.workerId ?? "") } }
    private var taskRisks: [TaskRisk] { TaskRisk.forComputer(taskComputer, permissions: store.state?.workers.first { $0.id == store.currentTask?.workerId }?.permissions ?? []) }

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
            WorkspaceIconButton(label: "Computer use", icon: .computer, pressed: showComputer) { splitOpener = "Computer"; showComputer.toggle() }.focused($splitToggleFocused, equals: "Computer").accessibilityIdentifier("toolbar-computer")
            WorkspaceIconButton(label: "Changes", icon: .review, pressed: showInspector, shortcut: "⌘⇧I") { splitOpener = "Changes"; toggleInspector() }.focused($splitToggleFocused, equals: "Changes").keyboardShortcut("i", modifiers: [.command, .shift]).accessibilityIdentifier("toolbar-review")
            WorkspaceIconButton(label: "Activity", icon: .panelRight, pressed: activityMode == "open" || showActivitySheet) { splitOpener = "Activity"; activityMode == "open" ? setActivityMode("closed") : openActivity() }.focused($splitToggleFocused, equals: "Activity").accessibilityIdentifier("toolbar-activity").accessibilityValue(activitySummary.text)
                .focused($activityToggleFocused)
                .onKeyPress(keys: [.return, .space]) { _ in
                    activityOpenedByKeyboard = true
                    setActivityMode(activityMode == "open" ? "closed" : "open")
                    return .handled
                }
                .overlay(alignment: .topTrailing) {
                    if activitySummary.runningCount > 0 || activitySummary.failingCount > 0 {
                        Text("\(activitySummary.failingCount > 0 ? activitySummary.failingCount : activitySummary.runningCount)")
                            .font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(colorScheme)).allowsHitTesting(false)
                    }
                }
            Menu {
                Text(taskContextLabel)
                if store.currentTask?.inReview == true { Button("Open pull request") { openTaskPull() } }
                if !store.isWorking { Button(store.currentTaskClosed ? "Reopen" : "Mark done") { confirmTaskOutcome = true }.disabled(store.busy) }
            } label: { WorkspaceToolbarIcon("More task actions", icon: .more) }
                .menuStyle(.borderlessButton).fixedSize().help("More task actions")
        }.disabled(showTask || store.currentTask == nil)
            .onKeyPress(.escape) { if showInspector { showInspector = false; return .handled }; return .ignored }
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

    private var animatedActivityMode: Binding<String> { Binding(get: { activityMode }, set: setActivityMode) }
    private func setActivityMode(_ mode: String) {
        withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { activityMode = InteractionLayout.activityMode(mode) }
    }
    private func openActivity() { splitOpener = "Activity"; activitySelection = nil; activityOpenedByKeyboard = false
        #if os(macOS)
        activityOpenedByKeyboard = NSApp.currentEvent?.type == .keyDown
        #endif
        presentActivity() }
    private func openActivityFromKeyboard() { activityOpenedByKeyboard = true; activitySelection = nil; presentActivity() }
    private func presentActivity() {
        splitOpener = "Activity"
        if showToolSheet {
            showToolSheet = false
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(450))
                if compactWidth { showActivitySheet = true } else { setActivityMode("open") }
            }
        } else if compactWidth { showActivitySheet = true } else { setActivityMode("open") }
    }
    private var activityInspector: some View {
        TaskActivityInspector(detail: store.detail, workers: store.state?.workers ?? [], cancel: { job in Task { await store.cancelJob(job) } }, showConversation: { runId in
            if showInspector { showInspector = false }; showActivitySheet = false
            conversationSelection = ActivitySelection(runId: runId)
        }, selection: activitySelection).id(store.selectedTaskId)
    }

    /// Show a file linked from the conversation in Changes.
    private func openFile(_ reference: TaskFileReference) {
        panel = "Changes"
        if compactWidth { showToolSheet = true } else { showInspector = true }
        Task { await store.openFile(reference) }
    }

    @ViewBuilder private var linkedPullStrip: some View {
        if let pull = store.linkedPull, pull.showsConversationReviewBar, let projectId = store.currentTask?.projectId, let connection = store.connection {
            ConversationReviewStrip(pull: pull, projectId: projectId, connection: connection,
                                    workers: store.state?.workers ?? []) { openReview(pull) }
                .id(pull.id)
        }
    }

    private func taskCardFits(_ width: CGFloat) -> Bool { !compactWidth && splitTab == nil && InteractionLayout.taskCardWidth(pane: width, reading: WorkspaceStyle.contentWidth) != nil }
    private func conversation(showSummary: Bool) -> some View {
        VStack(spacing: 0) {
            transcript
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
                VStack(spacing: 0) {
                    TaskRiskNotice(risks: taskRisks).environment(\.mediaConnection, store.connection)
                    WorkspaceContextTray {
                        ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: WorkspaceStyle.space4) {
                            Label(store.selectedProject?.name ?? "No project", systemImage: "folder")
                            Label(store.state?.workers.first { $0.id == store.currentTask?.workerId }?.name ?? store.currentTask?.workerId ?? "Computer unavailable", systemImage: "desktopcomputer")
                            ForEach(taskRisks, id: \.label) { risk in
                                Button { if let computer = taskComputer { computerId = computer.id; section = "Computers"
                                    #if os(iOS)
                                    selectedTab = "computers"
                                    #endif
                                } } label: { Label(risk.label, systemImage: risk.icon).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.warning(colorScheme)).padding(WorkspaceStyle.space1).background(WorkspaceStyle.warning(colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: WorkspaceStyle.radius)) }
                                .buttonStyle(.workspaceLink).help(risk.explanation)
                            }
                        }.fixedSize(horizontal: true, vertical: false) }
                    }
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
                        if showSummary { TaskActivitySummaryButton(summary: activitySummary, open: openActivity, compact: true, keyboardOpen: openActivityFromKeyboard) }
                        AgentControls(store: store, workerId: store.currentTask?.workerId ?? "local", disabled: store.isWorking)
                        sendButton.help("Send message (⌘ Return)")
                    }
                }.padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 8)
                    // The composer keeps its natural height (chips plus up to six lines); the transcript
                    // above absorbs the difference, so text never draws over the toolbar.
                    .fixedSize(horizontal: false, vertical: true)
                }.modifier(WorkspacePromptSurface()).modifier(AttachmentComposerInput(store: store))
                }
                if !store.isConnected {
                    Text(store.needsAuthentication ? "Sign in again. Draft saved on this device." : "Offline. Draft saved on this device.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, WorkspaceStyle.conversationGutter).frame(maxWidth: WorkspaceStyle.contentWidth).padding(.bottom, 8).padding(.top, 6)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { composerHeight = $0 }
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

    private var composerPrompt: String { "Ask, build, or follow up…" }

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
        if item.sourceBranch != nil {
            let current = store.projectPulls.first { $0.id == item.id } ?? item
            return AnyView(ConversationPullEvent(pull: current, open: { openReview(current) }))
        }
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
        if let message = store.detail?.messages.last(where: { $0.isProgress != true }) {
            for pull in store.projectPulls where pull.taskIds?.contains(store.selectedTaskId ?? "") == true && latest[pull.id] == nil {
                latest[pull.id] = (message.id, pull)
            }
        }
        var cards: [String: [ProjectWorkItem]] = [:]
        for entry in latest.values.sorted(by: { ($0.item.number ?? 0) < ($1.item.number ?? 0) }) { cards[entry.message, default: []].append(entry.item) }
        mentionCards = cards
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
                .padding(.horizontal, 24).padding(.vertical, 14)
            Divider().opacity(0.45)
            if panel == "Browser" { BrowserPanel(store: store) }
            else { ChangesView(store: store, section: panel, viewFile: taskFileAction, openPullRequest: openPullRequest, openActivityCheck: { check in activitySelection = ActivitySelection(check: check); presentActivity() }) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WorkspaceStyle.canvas(colorScheme))
            .overlay(alignment: .bottom) {
            if store.undoClosedTask != nil {
                HStack { Text("Marked done ·"); Button("Undo") { Task { await store.undoMarkDone() } }.buttonStyle(.workspaceLink).disabled(store.busy) }
                    .font(WorkspaceStyle.metadata).padding(WorkspaceStyle.space3)
                    .background(WorkspaceStyle.surface(colorScheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
                    .padding(WorkspaceStyle.space4).accessibilityElement(children: .contain)
            }
        }
        .tint(WorkspaceStyle.accent(colorScheme))
            .onKeyPress(.escape) { showInspector = false; return .handled }
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
    @State private var visibleTurns: Set<String> = []
    /// Content height is kept outside view state so streaming output doesn't re-render the
    /// conversation; only the overflow flag the minimap needs is observed.
    @State private var transcriptHeight = TranscriptHeight()
    @State private var transcriptOverflows = false
    @State private var viewportSize: CGSize = .zero
    @State private var minimapJump: String?
    @State private var restored = false
    @State private var followPass = 0
    @State private var followRunning = false
    @State private var followPending = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private func measureTranscript(_ height: CGFloat) {
        transcriptHeight.value = height
        let overflows = height > viewportSize.height
        if overflows != transcriptOverflows { transcriptOverflows = overflows }
    }
    private var allowsMinimap: Bool {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad
        #else
        true
        #endif
    }
    private var follow: Bool { bookmark.follow }
    var body: some View {
        ScrollViewReader { reader in
            VStack(spacing: 0) {
                let index = TranscriptIndex(messages: messages, activity: activity, runs: runs, jobs: jobs, attachments: attachments)
                ScrollView(.vertical) {
                    // Not lazy: estimated heights of unrendered Markdown rows made scrolls to the end
                    // land short, or past the drawn rows, as replies arrived.
                    VStack(alignment: .leading, spacing: 22) {
                        if messages.isEmpty && loading {
                            WorkspaceSkeleton(variant: .conversation)
                                .accessibilityLabel("Loading conversation")
                        } else if messages.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Let’s build something.").font(.title3.weight(.semibold))
                                Text("Describe a change, ask a question, or share an idea. This conversation stays with your project on every device.")
                                    .foregroundStyle(.secondary).lineSpacing(4)
                            }.padding(.vertical, 25)
                        }
                        ForEach(index.visible) { message in
                            if message.role == "assistant",
                               index.firstFinal[message.runId ?? ""] == message.id,
                               let turn = index.activityById[message.runId ?? ""] {
                                TaskActivityView(activity: turn, run: index.runById[turn.id], progress: index.progress[turn.id] ?? [], jobs: index.jobsByRun[turn.id] ?? [], workers: workers, openActivity: { openTurnActivity(turn.id) })
                                AttachmentStrip(rows: index.computerMedia[turn.id] ?? [], computer: true)
                            }
                            MessageView(message: message, fileLinks: fileLinks).id(message.id)
                                .background(highlightedRun != nil && highlightedRun == message.runId ? WorkspaceStyle.selected(activityColorScheme) : .clear)
                            AttachmentStrip(rows: attachments.filter { attachment in
                                attachment.source != "computer-use" && !message.content.contains("/attachments/" + attachment.id) &&
                                (attachment.messageId == message.id || message.attachmentIds?.contains(attachment.id) == true ||
                                 (attachment.source == "agent" && attachment.runId != nil && attachment.runId == message.runId && index.lastFinal[message.runId ?? ""] == message.id))
                            }, trailing: message.role == "user")
                            if let reviewCard, let items = reviewCards[message.id] {
                                ForEach(items) { item in
                                    // The transcript column is the composer's width, so cards fill it exactly.
                                    reviewCard(item).frame(maxWidth: .infinity)
                                }
                            }
                            if message.role == "assistant", index.lastFinal[message.runId ?? ""] == message.id {
                                ReplyActionsView(message: message, run: index.runById[message.runId ?? ""])
                            }
                        }
                        ForEach(activity.filter { !index.finalRunIds.contains($0.id) }) { turn in
                            TaskActivityView(activity: turn, run: index.runById[turn.id], progress: index.progress[turn.id] ?? [], jobs: index.jobsByRun[turn.id] ?? [], workers: workers, openActivity: { openTurnActivity(turn.id) })
                            AttachmentStrip(rows: index.computerMedia[turn.id] ?? [], computer: true)
                            AttachmentStrip(rows: index.agentMedia[turn.id] ?? [])
                        }
                        ForEach(runs.filter { !index.finalRunIds.contains($0.id) }) { run in
                            AgentContextView(run: run)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.scrollTargetLayout()
                        .background { GeometryReader { geometry in Color.clear.onAppear { measureTranscript(geometry.size.height) }.onChange(of: geometry.size.height) { _, height in measureTranscript(height) } } }
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
                                                   pinToEnd: { followToEnd(reader) }, jumpID: minimapJump))
                .modifier(TurnVisibility(ids: $visibleTurns))
                .background { GeometryReader { geometry in Color.clear.onAppear { viewportSize = geometry.size; measureTranscript(transcriptHeight.value) }.onChange(of: geometry.size) { _, size in viewportSize = size; measureTranscript(transcriptHeight.value) } } }
                .overlay(alignment: .leading) {
                    if allowsMinimap && index.turns.count >= 3 && transcriptOverflows && viewportSize.width >= WorkspaceStyle.minimapMinimumWidth {
                        TurnMinimap(turns: index.turns, visible: visibleTurns.isEmpty ? Set([visibleID].compactMap { $0 }) : visibleTurns) { id in
                            bookmark.follow = false; bookmark.offset = nil; bookmark.anchor = id
                            minimapJump = id
                            withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { reader.scrollTo(id, anchor: .top) }
                        }
                    }
                }
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
    /// Keeps the end in view while Markdown and media finish laying out. Each scroll lays out the
    /// whole (non-lazy) transcript, so requests that arrive mid-pass (new jobs, activity, messages)
    /// join the running pass, which ends with one more scroll, instead of starting another cascade.
    private func followToEnd(_ reader: ScrollViewProxy) {
        if followRunning { followPending = true; return }
        followRunning = true
        followPass += 1
        let pass = followPass
        Task { @MainActor in
            defer { if pass == followPass { followRunning = false } }
            for delay in [0, 80, 200, 450, 900] {
                if delay > 0 { try? await Task.sleep(for: .milliseconds(delay)) }
                guard pass == followPass, bookmark.follow else { followPending = false; return }
                reader.scrollTo("bottom", anchor: .bottom)
            }
            while followPending, pass == followPass, bookmark.follow {
                followPending = false
                try? await Task.sleep(for: .milliseconds(150))
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

/// Lookups the transcript needs per message, built once per render. The transcript is not lazy,
/// so it evaluates every row on each update; searching all messages per message made that
/// quadratic.
struct TranscriptIndex {
    let visible: [Message]
    let turns: [TranscriptTurn]
    let firstFinal: [String: String]
    let lastFinal: [String: String]
    let finalRunIds: Set<String>
    let progress: [String: [Message]]
    let activityById: [String: TaskActivity]
    let runById: [String: Run]
    let jobsByRun: [String: [WorkspaceJob]]
    let computerMedia: [String: [MediaAttachment]]
    let agentMedia: [String: [MediaAttachment]]
    init(messages: [Message], activity: [TaskActivity], runs: [Run], jobs: [WorkspaceJob], attachments: [MediaAttachment]) {
        visible = messages.filter { $0.isProgress != true }
        turns = TranscriptTurn.extract(visible)
        var first: [String: String] = [:], last: [String: String] = [:], progress: [String: [Message]] = [:]
        for message in messages {
            let run = message.runId ?? ""
            if message.isProgress == true { progress[message.runId ?? "", default: []].append(message) }
            else if message.role == "assistant" { if first[run] == nil { first[run] = message.id }; last[run] = message.id }
        }
        firstFinal = first; lastFinal = last; self.progress = progress
        finalRunIds = Set(first.keys)
        activityById = Dictionary(activity.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        runById = Dictionary(runs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        jobsByRun = Dictionary(grouping: jobs, by: { $0.runId ?? "" })
        computerMedia = Dictionary(grouping: attachments.filter { $0.source == "computer-use" }, by: { $0.runId ?? "" })
        agentMedia = Dictionary(grouping: attachments.filter { $0.source == "agent" }, by: { $0.runId ?? "" })
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
    var jumpID: String? = nil
    func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content.modifier(PreciseTranscriptScroll(bookmark: $bookmark, restored: restored, pinToEnd: pinToEnd, jumpID: jumpID))
        } else { content.scrollPosition(id: $visibleID, anchor: .top) }
    }
}

@available(macOS 15, iOS 18, *)
private struct PreciseTranscriptScroll: ViewModifier {
    @Binding var bookmark: TranscriptBookmark
    let restored: Bool
    /// Scrolls to the end through the transcript's reader (the "bottom" sentinel), not by edge.
    let pinToEnd: () -> Void
    let jumpID: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var userScrolling = false
    @State private var geometry = TranscriptGeometry(offset: 0, height: 0, viewport: 0, width: 0, nearBottom: true)
    @FocusState private var scrollFocused: Bool
    init(bookmark: Binding<TranscriptBookmark>, restored: Bool, pinToEnd: @escaping () -> Void, jumpID: String? = nil) {
        _bookmark = bookmark
        self.restored = restored
        self.pinToEnd = pinToEnd
        self.jumpID = jumpID
        let saved = bookmark.wrappedValue
        _position = State(initialValue: saved.follow ? ScrollPosition(edge: .bottom) : ScrollPosition(point: CGPoint(x: 0, y: saved.offset ?? 0)))
    }
    func body(content: Content) -> some View {
        content.scrollPosition($position)
            .onChange(of: jumpID) { _, id in
                guard let id else { return }
                withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { position.scrollTo(id: id, anchor: .top) }
            }
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
                TranscriptGeometry(offset: geometry.contentOffset.y, height: geometry.contentSize.height, viewport: geometry.containerSize.height, width: geometry.containerSize.width,
                    nearBottom: geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 48)
            } action: { previous, next in
                geometry = next
                guard restored else { return }
                if !userScrolling, previous.viewport > 0, (previous.width != next.width || previous.viewport != next.viewport) {
                    let bottom = bookmark.follow ? 0 : max(0, previous.height - previous.viewport - previous.offset)
                    let offset = max(0, next.height - next.viewport - bottom)
                    bookmark.offset = offset
                    var transaction = Transaction(); transaction.disablesAnimations = true
                    withTransaction(transaction) { position.scrollTo(point: CGPoint(x: 0, y: offset)) }
                } else if userScrolling {
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
    let width: CGFloat
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
                    .foregroundStyle(WorkspaceStyle.text(colorScheme))
                    .background(WorkspaceStyle.userMessage(colorScheme), in: RoundedRectangle(cornerRadius: 18))
            }
        } else if let deployment = message.deployment {
            ConversationDeploymentEvent(deployment: deployment)
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

/// Unobserved storage for the transcript's measured height.
private final class TranscriptHeight { var value: CGFloat = 0 }
