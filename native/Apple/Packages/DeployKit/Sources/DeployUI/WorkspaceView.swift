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
    @State private var showComputer = false
    @State private var search = ""
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var showToolSheet = false
    @State private var panel = "Changes"
    @State private var transcriptBookmarks: [String: TranscriptBookmark] = [:]
    @State private var mentionCards: [String: [ProjectWorkItem]] = [:]
    @State private var showAccount = false
    @State private var showComputers = false
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
    private enum PhoneRoute: Hashable { case task(String), compose, project(String), settings, review(project: String, section: String, item: String?, task: String?) }
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
        .task { await store.start() }
        .task(id: store.state) { await refreshPendingQuestions() }
        .onChange(of: store.connection) { _, _ in pendingQuestionTaskIDs = [] }
        .sheet(isPresented: $showConnection) { ConnectionSheet(store: store) }
        .sheet(item: $projectHub) { target in
            if let connection = store.connection {
                ProjectHubView(project: target.project, connection: connection, tasks: store.tasks, workers: store.state?.workers ?? [],
                               section: target.section, selected: target.selected, composeForTask: target.composeTask) { id in
                    Task { await store.select(id); showTask = false }
                }
            }
        }
        .sheet(isPresented: $showProject) { ProjectSheet(store: store) }
        .sheet(isPresented: $showToolSheet) {
            NavigationStack {
                inspector.navigationTitle("Review")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showToolSheet = false } } }
            }
        }
        #if os(iOS)
        .sheet(isPresented: $showComputer) {
            NavigationStack {
                BrowserPanel(store: store).navigationTitle("Computer control")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showComputer = false } } }
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
                        FloatingComputerViewer(store: store, isPresented: $showComputer)
                            .opacity(showTask || store.currentTask == nil ? 0 : 1)
                            .allowsHitTesting(!showTask && store.currentTask != nil)
                            .accessibilityHidden(!showComputer || showTask || store.currentTask == nil)
                    }
                    #endif
                    .navigationTitle(showTask ? "New task" : store.currentTask?.title ?? "New task")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .principal) {
                            VStack(spacing: 2) {
                                Text(showTask ? "New task" : store.currentTask?.title ?? "New task")
                                    .font(.subheadline.weight(.semibold)).lineLimit(1)
                                if !showTask, let project = store.selectedProject {
                                    Text(project.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Menu {
                                Button("Review changes") { showToolSheet = true }
                                Button("Computer control") { showComputer = true }
                            } label: {
                                WorkspaceToolbarIcon("Review changes", icon: .review)
                            } primaryAction: { showToolSheet = true }
                            .buttonStyle(WorkspaceToolbarButtonStyle())
                                .accessibilityLabel("Review changes").accessibilityIdentifier("toolbar-review")
                                .disabled(showTask || store.currentTask == nil)
                        }.workspaceToolbarChrome()
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
                Button { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly } label: {
                    WorkspaceToolbarIcon("Toggle sidebar", icon: .navigation)
                }.buttonStyle(WorkspaceToolbarButtonStyle())
                    .help("Toggle sidebar · ⌘⌃S").accessibilityLabel("Toggle sidebar").accessibilityIdentifier("toolbar-navigation")
                    .keyboardShortcut("s", modifiers: [.command, .control])
            }.workspaceToolbarChrome()
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: WorkspaceStyle.Toolbar.spacing) {
                    Button { showComputer.toggle() } label: {
                        WorkspaceToolbarIcon("Computer use", icon: .computer)
                    }.buttonStyle(WorkspaceToolbarButtonStyle(selected: showComputer))
                        .help(showComputer ? "Hide computer use" : "Open computer use")
                        .accessibilityLabel("Computer use").accessibilityIdentifier("toolbar-computer")
                        .accessibilityValue(showComputer ? "Shown" : "Hidden")
                        .disabled(showTask || store.currentTask == nil)
                    Button { beginTask() } label: {
                        WorkspaceToolbarIcon("New task", icon: .compose)
                    }.buttonStyle(WorkspaceToolbarButtonStyle())
                        .help("New task · ⌘N").keyboardShortcut("n")
                        .accessibilityLabel("New task").accessibilityIdentifier("toolbar-compose")
                        .disabled(store.connection == nil)
                    Button { showInspector.toggle() } label: {
                        WorkspaceToolbarIcon("Review", icon: .review)
                    }.buttonStyle(WorkspaceToolbarButtonStyle(selected: showInspector))
                        .help(showInspector ? "Hide review · ⌘⇧I" : "Show review · ⌘⇧I")
                        .accessibilityLabel("Review").accessibilityIdentifier("toolbar-review")
                        .keyboardShortcut("i", modifiers: [.command, .shift])
                        .accessibilityValue(showInspector ? "Shown" : "Hidden")
                        .disabled(showTask || store.currentTask == nil)
                }
            }.workspaceToolbarChrome()
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
                                    Text(worker.platform).font(.subheadline).foregroundStyle(.secondary)
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
            let tree = taskTreeModel
            if tree.groups.isEmpty {
                Section { taskTreeEmptyState }
            } else {
                ForEach(tree.groups) { group in
                    TaskTreeGroup(group: group, searching: tree.isSearching, compact: true,
                                  canCompose: store.connection != nil, compose: { phoneCompose(group.project?.id ?? "") }) { task in
                        phoneTaskRow(task)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { connectionBanner }
        .navigationTitle("Tasks").navigationBarTitleDisplayMode(.large)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tasks")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink(value: PhoneRoute.settings) {
                    WorkspaceGlyph(name: .user, size: 24).frame(width: 44, height: 44)
                }.accessibilityLabel("Settings and account")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { phoneCompose() } label: {
                    WorkspaceGlyph(name: .compose, size: 24).frame(width: 44, height: 44)
                }.accessibilityLabel("New task")
                    .disabled(store.connection == nil).accessibilityIdentifier("toolbar-compose")
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
            .navigationTitle(phoneUsesExpandedTitle ? "" : store.currentTask?.id == id ? store.currentTask?.title ?? "Task" : "Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    if !phoneUsesExpandedTitle { phoneConversationTitle }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Review changes") { showToolSheet = true }
                        Button("Computer control") { showComputer = true }
                        if !store.isWorking {
                            Divider()
                            Button(store.currentTaskClosed ? "Reopen task" : "Mark task done") {
                                Task { await store.setCurrentTaskClosed(!store.currentTaskClosed) }
                            }
                        }
                    } label: {
                        Text("Changes \(store.diff?.files.count ?? 0)").font(.subheadline)
                    } primaryAction: { showToolSheet = true }
                    .accessibilityLabel("Changes \(store.diff?.files.count ?? 0). Menu includes computer control")
                }
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
                ProjectHubView(project: project, connection: connection, isPushed: true, tasks: store.tasks, workers: store.state?.workers ?? []) { id in
                    selectedTab = "tasks"; taskPath = [.task(id)]
                }
            }
        case .review(let projectId, let section, let item, let task):
            if let project = store.projects.first(where: { $0.id == projectId }), let connection = store.connection {
                ProjectHubView(project: project, connection: connection, isPushed: true, tasks: store.tasks, workers: store.state?.workers ?? [],
                               section: section, selected: item ?? "", composeForTask: task) { id in
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

    private var phoneConversationTitle: some View {
        VStack(spacing: 3) {
            Text(store.currentTask?.title ?? "Task").font(.subheadline.weight(.semibold)).lineLimit(phoneUsesExpandedTitle ? 2 : 1)
            let task = store.currentTask
            let status = store.detail?.questions?.contains(where: { $0.status == "pending" }) == true ? "waiting" : store.activeRun?.status ?? task?.status ?? "unknown"
            let computer = store.state?.workers.first { $0.id == (task?.workerId ?? "local") }?.name
                ?? PhoneIdentifier.abbreviated(task?.workerId ?? "local")
            HStack(spacing: 4) {
                PhoneStatusDot(status: status, size: 6)
                Text(computer + " · " + (status == "waiting" ? "Needs answer" : status == "review" ? "Ready to review" : status.capitalized))
                    .lineLimit(phoneUsesExpandedTitle ? 2 : 1).truncationMode(.middle)
            }.font(.caption).foregroundStyle(.secondary)
                .contextMenu {
                    if let id = task?.workerId { Button("Copy computer ID") { UIPasteboard.general.string = id } }
                }
        }.fixedSize(horizontal: false, vertical: true).accessibilityElement(children: .combine)
    }

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
            #if os(iOS)
            HStack {
                Button { showAccount = true } label: {
                    WorkspaceGlyph(name: .user, size: 20).frame(width: 44, height: 44)
                }.buttonStyle(.plain).modifier(WorkspaceSurface(radius: 24)).accessibilityLabel("Account and provider usage")
                    .popover(isPresented: $showAccount) {
                        VStack(alignment: .leading, spacing: 16) {
                            Text(store.connection?.username ?? "Account").font(.headline)
                            ProviderUsageFooter(worker: store.state?.workers.first { $0.id == (store.currentTask?.workerId ?? "local") })
                            Button("Connection settings") { showAccount = false; showConnection = true }
                        }.padding(20).frame(minWidth: 280)
                    }
                Spacer()
                Text("deploy.local").font(.headline)
                Spacer()
                Button { showRepositories = true } label: {
                    WorkspaceGlyph(name: .folder, size: 20).frame(width: 44, height: 44)
                }.buttonStyle(.plain).modifier(WorkspaceSurface(radius: 24)).accessibilityLabel("Repositories")
                    .popover(isPresented: $showRepositories) { repositoriesPopover }
            }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 20)
            #endif
            searchField
            ScrollView {
                taskTree
            }
            #if os(iOS)
            Button { beginTask() } label: {
                HStack(spacing: 12) {
                    WorkspaceGlyph(name: .compose, size: 20)
                    Text("Ask deploy.local").foregroundStyle(.secondary)
                    Spacer()
                }.padding(.horizontal, 18).frame(height: 48)
            }.buttonStyle(.plain).modifier(WorkspaceSurface(radius: 26))
                .padding(.horizontal, 18).padding(.vertical, 12).disabled(store.connection == nil)
                .accessibilityLabel("New task")
            #else
            Button { beginTask() } label: {
                HStack(spacing: 8) {
                    WorkspaceSymbol(name: "square.and.pencil")
                    Text("New task")
                    Spacer()
                    Text("⌘N").foregroundStyle(.tertiary)
                }.font(WorkspaceStyle.navigation).padding(10)
            }.buttonStyle(.plain).modifier(WorkspaceSurface(radius: 10, elevated: false))
                .padding(10).disabled(store.connection == nil)
            #endif
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
                                }
                            }
                        }
                    }.padding(20).frame(width: 300)
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
    }

    private var taskTreeModel: TaskTree {
        TaskTree(projects: store.projects, tasks: store.tasks, search: search)
    }

    private var taskTree: some View {
        let tree = taskTreeModel
        return VStack(alignment: .leading, spacing: 14) {
            if tree.groups.isEmpty { taskTreeEmptyState }
            ForEach(tree.groups) { group in
                TaskTreeGroup(group: group, searching: tree.isSearching, selectedTaskId: showTask ? nil : store.selectedTaskId,
                              canCompose: store.connection != nil, compose: { beginTask(group.project?.id ?? "") }) { task in
                    taskRow(task)
                }
            }
        }.padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 14)
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
        let pending = pendingQuestionTaskIDs.contains(task.id)
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
                    Button("Sign in again") { showConnection = true }.buttonStyle(.workspaceSecondary)
                } else {
                    if store.canRetrySavingLogin {
                        Button("Try again") { store.retrySavingLogin() }.buttonStyle(.workspaceSecondary)
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
            if let task = store.currentTask {
                #if os(iOS)
                if horizontalSizeClass != .compact {
                    conversationPlacement(task)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.horizontal, WorkspaceStyle.conversationGutter).padding(.top, 2).padding(.bottom, 8)
                }
                #else
                HStack(spacing: 16) {
                    conversationProject
                    Spacer(minLength: 12)
                    conversationPlacement(task)
                }.padding(.horizontal, 24).padding(.vertical, 8)
                #endif
                GeometryReader { geometry in
                    let splitReview = geometry.size.width >= 1080
                    HStack(spacing: 0) {
                        conversation.frame(maxWidth: .infinity)
                            .opacity(showInspector && !splitReview ? 0 : 1)
                            .allowsHitTesting(!showInspector || splitReview)
                            .accessibilityHidden(showInspector && !splitReview)
                            .overlay {
                                if showInspector && !splitReview { inspector }
                            }
                        if showInspector && splitReview {
                            Divider().opacity(0.45)
                            inspector.frame(width: min(560, geometry.size.width * 0.48))
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

    private var conversationProject: some View {
        Label(store.selectedProject?.name ?? "Tasks", systemImage: store.selectedProject == nil ? "bubble.left" : "folder")
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
    }
    private func conversationPlacement(_ task: WorkspaceTask) -> some View {
        let worker = store.state?.workers.first(where: { $0.id == (task.workerId ?? "local") })
        return HStack(spacing: 10) {
            Label(worker?.name ?? task.workerId ?? "Local", systemImage: "desktopcomputer")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                .help(worker?.name ?? task.workerId ?? "Local")
                .accessibilityLabel("Computer: \(worker?.name ?? task.workerId ?? "Local")")
            if store.detail?.questions?.contains(where: { $0.status == "pending" }) == true {
                Text("Waiting for your answer").font(.caption).foregroundStyle(.secondary)
            } else {
                StatusBadge(status: store.activeRun?.status ?? task.status).fixedSize()
                if !store.isWorking { taskOutcomeButton }
            }
        }
    }

    /// Close a finished task, or reopen one that was closed or finished by its merged PR.
    private var taskOutcomeButton: some View {
        Button(store.currentTaskClosed ? "Reopen" : "Mark done") {
            Task { await store.setCurrentTaskClosed(!store.currentTaskClosed) }
        }.buttonStyle(.workspaceQuiet).disabled(store.busy || store.connection == nil)
            .help(store.currentTaskClosed ? "Reopen this task for review" : "Close this task as done")
            .accessibilityIdentifier("task-outcome")
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
                              cancelJob: { job in Task { await store.cancelJob(job) } }, questions: store.detail?.questions ?? [],
                              reviewCards: mentionCards, reviewCard: cardBuilder, bookmark: bookmark)
            .id(store.selectedTaskId)
            .task(id: "\(taskID)|\(store.detail?.messages.count ?? 0)") { placeMentions(); await store.loadLinkedPull(); placeMentions() }
            .onChange(of: store.projectPulls) { _, _ in placeMentions() }
            .onChange(of: store.projectIssues) { _, _ in placeMentions() }
            .onChange(of: store.detail?.messages.count) { _, _ in placeMentions() }
    }

    @ViewBuilder private var linkedPullStrip: some View {
        if let pull = store.linkedPull, let projectId = store.currentTask?.projectId, let connection = store.connection {
            ConversationReviewStrip(pull: pull, projectId: projectId, connection: connection,
                                    workers: store.state?.workers ?? []) { openReview(pull) }
                .id(pull.id)
        }
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            transcript
            VStack(alignment: .leading, spacing: 10) {
                linkedPullStrip
                ForEach((store.detail?.questions ?? []).filter { $0.status == "pending" }) { question in
                    TaskQuestionView(question: question, store: store).id(question.id)
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
                if store.detail?.questions?.contains(where: { $0.status == "pending" }) != true {
                VStack(alignment: .leading, spacing: 8) {
                    composerInput.frame(minHeight: 24, alignment: .top)
                    HStack(alignment: .bottom, spacing: 8) {
                        VoiceInput(connection: store.connection, draft: $store.draft).id(store.selectedTaskId)
                        Spacer(minLength: 4)
                        AgentControls(store: store, workerId: store.currentTask?.workerId ?? "local", disabled: store.isWorking)
                        sendButton
                    }
                }.padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 8).modifier(WorkspacePromptSurface())
                }
                if !store.isConnected {
                    Text(store.needsAuthentication ? "Sign in again. Draft saved on this device." : "Offline. Draft saved on this device.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                #if os(macOS)
                HStack { Spacer(); Text("⌘ Return to send") }.font(.system(.caption)).foregroundStyle(.secondary)
                #endif
            }.padding(.horizontal, WorkspaceStyle.conversationGutter).frame(maxWidth: WorkspaceStyle.contentWidth).padding(.bottom, 8).padding(.top, 6)
        }
    }

    private var composerInput: some View {
        TextField("Message", text: $store.draft,
                  prompt: Text(store.isWorking ? "Draft your next message…" : "Ask deploy.local…").foregroundColor(.primary.opacity(0.6)), axis: .vertical)
            .textFieldStyle(.plain).lineLimit(1...6).font(WorkspaceStyle.body).autocorrectionDisabled()
            .focused($composerFocused).accessibilityIdentifier("chat-composer")
    }

    private var sendButton: some View {
        Button { Task { await store.send() } } label: {
            if store.busy { ProgressView().controlSize(.small).frame(width: 24, height: 24) }
            else { Image(systemName: "arrow.up").font(.system(.subheadline, weight: .bold)).frame(width: 24, height: 24) }
        }.buttonStyle(WorkspaceSendStyle())
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy || store.isWorking || !store.isConnected)
            .accessibilityLabel("Send message")
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

    /// Continue from task review into its pull request, or into a new one linked to the task.
    private func openPullRequest(_ pull: ProjectWorkItem?) {
        guard let task = store.currentTask, let projectId = task.projectId,
              let project = store.projects.first(where: { $0.id == projectId }) else { return }
        #if os(iOS)
        if horizontalSizeClass == .compact {
            showToolSheet = false
            taskPath.append(.review(project: projectId, section: "pulls", item: pull?.id, task: pull == nil ? task.id : nil))
            return
        }
        #endif
        let target = HubTarget(project: project, section: "pulls", selected: pull?.id ?? "", composeTask: pull == nil ? task.id : nil)
        guard showToolSheet else { projectHub = target; return }
        // Let the review sheet finish dismissing before presenting the project sheet.
        showToolSheet = false
        Task { try? await Task.sleep(for: .milliseconds(450)); projectHub = target }
    }

    private var inspector: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Picker("Review section", selection: $panel) {
                    Text("Changes").tag("Changes")
                    Text("Checks").tag("Checks")
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 320)
                Spacer(minLength: 8)
                #if os(macOS)
                Button { showInspector = false } label: { WorkspaceGlyph(name: .close, size: 18) }
                    .buttonStyle(WorkspaceToolbarButtonStyle()).accessibilityLabel("Close review")
                #endif
            }.padding(.horizontal, 24).padding(.vertical, 14)
            Divider().opacity(0.45)
            if panel == "Browser" { BrowserPanel(store: store) }
            else { ChangesView(store: store, section: panel, openPullRequest: openPullRequest) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WorkspaceStyle.canvas(colorScheme))
            .tint(WorkspaceStyle.accent(colorScheme))
    }

}

struct StatusBadge: View {
    let status: String
    @Environment(\.colorScheme) private var colorScheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private var inactive: Bool {
        #if os(iOS)
        if horizontalSizeClass == .compact { return WorkspaceStyle.phoneStatusTone(status) == .inactive }
        #endif
        return !["succeeded", "done", "merged", "review", "ready", "failed", "error", "running", "checking", "queued"].contains(status)
    }
    private var statusColor: Color {
        #if os(iOS)
        return WorkspaceStyle.phoneStatusColor(status, colorScheme)
        #else
        if ["review", "ready"].contains(status) { return WorkspaceStyle.statusAttention(colorScheme) }
        if ["succeeded", "done", "merged"].contains(status) { return WorkspaceStyle.statusHealthy(colorScheme) }
        if ["failed", "error"].contains(status) { return WorkspaceStyle.statusFailed(colorScheme) }
        if ["running", "checking", "queued"].contains(status) { return WorkspaceStyle.statusActive(colorScheme) }
        return WorkspaceStyle.statusInactive(colorScheme)
        #endif
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(inactive ? Color.clear : statusColor)
                .overlay(Circle().strokeBorder(statusColor, lineWidth: 1)).frame(width: 5, height: 5)
            Text(status == "review" ? "Ready to review" : ["succeeded", "done"].contains(status) ? "Done" : status.capitalized).font(.system(.caption, weight: .medium))
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
    let cancelJob: (WorkspaceJob) -> Void
    var questions: [WorkspaceQuestion] = []
    /// Live pull request and issue cards placed under the message that last mentions them.
    var reviewCards: [String: [ProjectWorkItem]] = [:]
    var reviewCard: ((ProjectWorkItem) -> AnyView)? = nil
    @Binding var bookmark: TranscriptBookmark
    @State private var visibleID: String?
    @State private var restored = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private var follow: Bool { bookmark.follow }
    var body: some View {
        ScrollViewReader { reader in
            VStack(spacing: 0) {
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 22) {
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
                                TaskActivityView(activity: turn, progress: messages.filter { $0.runId == turn.id && $0.isProgress == true })
                            }
                            MessageView(message: message).id(message.id)
                            if let reviewCard, let items = reviewCards[message.id] {
                                ForEach(items) { item in
                                    // The transcript column is the composer's width, so cards fill it exactly.
                                    reviewCard(item).frame(maxWidth: .infinity)
                                }
                            }
                        }
                        ForEach(activity.filter { turn in !messages.contains(where: { $0.runId == turn.id && $0.role == "assistant" && $0.isProgress != true }) }) { turn in
                            TaskActivityView(activity: turn, progress: messages.filter { $0.runId == turn.id && $0.isProgress == true })
                        }
                        if !jobs.isEmpty {
                        DisclosureGroup {
                        ForEach(jobs) { job in
                            DisclosureGroup {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(job.command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                    #if os(iOS)
                                    PhoneIdentifier(title: "Job", value: job.id)
                                    PhoneIdentifier(title: "Checkpoint", value: job.digest)
                                    if let exit = job.exitCode { Text("Exit \(exit)").font(.caption).foregroundStyle(.secondary) }
                                    #else
                                    Text("Checkpoint \(job.digest.prefix(12))" + (job.exitCode.map { " · Exit \($0)" } ?? "")).font(.caption).foregroundStyle(.secondary)
                                    #endif
                                    if !job.output.isEmpty {
                                        ScrollView { Text(job.output).font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }.frame(maxHeight: 240)
                                    }
                                    if job.truncated { Text("Showing the last 64,000 characters.").font(.caption).foregroundStyle(.secondary) }
                                    if let reason = job.waitingReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                                    if let error = job.error { Text(error).font(.caption).foregroundStyle(.red) }
                                    if job.isActive { Button(job.stopRequested == true ? "Cancellation requested" : "Cancel job") { cancelJob(job) }.disabled(job.stopRequested == true) }
                                }.padding(.top, 10)
                            } label: {
                                HStack {
                                    Label(workers.first(where: { $0.id == job.workerId })?.name ?? job.workerId ?? "Waiting for computer", systemImage: "desktopcomputer")
                                    #if os(iOS)
                                    if horizontalSizeClass != .compact { Spacer() }
                                    #else
                                    Spacer()
                                    #endif
                                    Text(job.stopRequested == true && job.isActive ? "Stopping…" : job.status.replacingOccurrences(of: "_", with: " ").capitalized).foregroundStyle(.secondary)
                                }.font(.caption)
                            }.padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                        }
                        } label: { Label("Processes across computers · \(jobs.count)", systemImage: "terminal") }
                            .font(.caption).foregroundStyle(.secondary)
                            #if os(iOS)
                            .modifier(PhoneActivityDisclosure())
                            #endif
                        }
                        TaskSourcesView(activity: activity)
                        if questions.contains(where: { $0.status != "pending" }) {
                            DisclosureGroup {
                                ForEach(questions.filter { $0.status != "pending" }) { question in
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(question.question).foregroundStyle(.primary)
                                        Text(question.answer ?? question.status.capitalized).textSelection(.enabled)
                                    }.padding(.vertical, 8)
                                }
                            } label: { Label("Questions and answers", systemImage: "questionmark.bubble") }
                                .font(.caption).foregroundStyle(.secondary)
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
                .modifier(TranscriptScrollTracking(bookmark: $bookmark, visibleID: $visibleID, restored: restored))
                if active || !follow {
                    HStack {
                        Spacer()
                        Button {
                            bookmark.follow = true
                            visibleID = "bottom"
                            reader.scrollTo("bottom", anchor: .bottom)
                        } label: {
                            Label(follow ? "Following output" : "Jump to latest", systemImage: "arrow.down")
                        }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 24)
                    }
                }
            }
            .onAppear { restore(reader) }
            .onChange(of: messages) { _, _ in
                if !restored { restore(reader) }
                else if follow { reader.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: jobs) { _, _ in if follow { reader.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: activity) { _, _ in if follow { reader.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: questions) { _, _ in if follow { reader.scrollTo("bottom", anchor: .bottom) } }
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
    private func restore(_ reader: ScrollViewProxy) {
        guard !messages.isEmpty, !restored else { return }
        if !bookmark.follow, bookmark.offset != nil { restored = true; return }
        if let anchor = bookmark.anchor, !bookmark.follow {
            reader.scrollTo(anchor, anchor: .top)
        } else { visibleID = "bottom"; reader.scrollTo("bottom", anchor: .bottom) }
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
    func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content.modifier(PreciseTranscriptScroll(bookmark: $bookmark, restored: restored))
        } else { content.scrollPosition(id: $visibleID, anchor: .top) }
    }
}

@available(macOS 15, iOS 18, *)
private struct PreciseTranscriptScroll: ViewModifier {
    @Binding var bookmark: TranscriptBookmark
    let restored: Bool
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var userScrolling = false
    @State private var geometry = TranscriptGeometry(offset: 0, height: 0, viewport: 0, nearBottom: true)
    @FocusState private var scrollFocused: Bool
    init(bookmark: Binding<TranscriptBookmark>, restored: Bool) {
        _bookmark = bookmark
        self.restored = restored
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
            // Keeping a tracked message in place aligns its leading edge, which sits at the gutter; the transcript
            // only scrolls vertically, so return any sideways drift (seen when a live card grows) to zero.
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.x } action: { _, x in
                if abs(x) > 0.5 { position.scrollTo(x: 0) }
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
                } else if !bookmark.follow, let saved = bookmark.offset, abs(saved - next.offset) > 1 {
                    position.scrollTo(point: CGPoint(x: 0, y: saved))
                }
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
private struct TranscriptGeometry: Equatable {
    let offset: CGFloat
    let height: CGFloat
    let viewport: CGFloat
    let nearBottom: Bool
}

struct MessageView: View {
    let message: Message
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 28)
                MessageContent(content: message.content).equatable()
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(WorkspaceStyle.userMessage(colorScheme), in: RoundedRectangle(cornerRadius: 18))
            }
        } else {
            MessageContent(content: message.content).equatable().frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, WorkspaceStyle.messageInset)
        }
    }
}

struct HubTarget: Identifiable {
    let project: Project
    var id: String { project.id }
    var section = "repository"
    var selected = ""
    var composeTask: String? = nil
}
