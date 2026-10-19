import SwiftUI
import DeployCore
#if os(iOS)
import UIKit
#endif

public struct DeployWorkspaceView: View {
    @Bindable private var store: WorkspaceStore
    @State private var projectHub: Project?
    @State private var showConnection = false
    @State private var showProject = false
    @State private var showTask = false
    @State private var newTaskProject = ""
    @State private var newTaskDraft = ""
    @State private var newTaskWorkerId = "local"
    @State private var collapsedProjects: Set<String> = []
    @State private var showInspector = false
    @State private var showComputer = false
    @State private var search = ""
    @State private var showSearch = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var showToolSheet = false
    @State private var panel = "Changes"
    @State private var transcriptBookmarks: [String: TranscriptBookmark] = [:]
    @State private var showAccount = false
    @State private var showComputers = false
    @Environment(\.colorScheme) private var colorScheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var phoneTypeSize
    @Environment(\.displayScale) private var phoneDisplayScale
    @State private var selectedTab = "tasks"
    @State private var taskPath: [PhoneRoute] = []
    @State private var repositoryPath: [PhoneRoute] = []
    @State private var pendingQuestionTaskIDs: Set<String> = []
    private var phoneUsesExpandedTitle: Bool { phoneTypeSize >= .xxLarge }
    private enum PhoneRoute: Hashable { case task(String), compose, project(String), settings }
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
        .sheet(isPresented: $showConnection) { ConnectionSheet(store: store) }
        .sheet(item: $projectHub) { project in
            if let connection = store.connection {
                ProjectHubView(project: project, connection: connection) { id in Task { await store.select(id); showTask = false } }
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
        .task(id: store.state) { await refreshPendingQuestions() }
        .onChange(of: store.connection) { _, _ in
            taskPath = []; repositoryPath = []; pendingQuestionTaskIDs = []
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
            if store.connection == nil {
                Section { Button("Connect to home") { taskPath.append(.settings) } }
            }
            let tasks = store.tasks.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
                .sorted { $0.updatedAt > $1.updatedAt }
            let attention = tasks.filter { needsAttention($0) }
            if !attention.isEmpty {
                Section("Needs you") { ForEach(attention) { phoneTaskRow($0) } }
            }
            let recent = tasks.filter { !needsAttention($0) }
            if !recent.isEmpty {
                Section("Recent") { ForEach(recent) { phoneTaskRow($0) } }
            }
            if tasks.isEmpty {
                Section {
                    ContentUnavailableView {
                        Label(search.isEmpty ? "No tasks yet" : "No matching tasks", systemImage: "bubble.left")
                    } description: {
                        Text(search.isEmpty ? "Start a task to work across your computers." : "Try a different search.")
                    } actions: {
                        if search.isEmpty { Button("New task") { phoneCompose() }.disabled(store.connection == nil) }
                    }
                }
            }
            if !store.projects.isEmpty {
                Section("Projects") {
                    ForEach(store.projects) { project in
                        NavigationLink(value: PhoneRoute.project(project.id)) {
                            Label { Text(project.name).lineLimit(2) } icon: { WorkspaceGlyph(name: .folder) }
                                .frame(minHeight: 44)
                        }
                    }
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { connectionBanner }
        .navigationTitle("Tasks").navigationBarTitleDisplayMode(.large)
        .searchable(text: $search, prompt: "Search tasks")
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

    private func needsAttention(_ task: WorkspaceTask) -> Bool {
        ["review", "ready", "failed", "error", "waiting", "waiting_for_answer"].contains(task.status)
            || pendingQuestionTaskIDs.contains(task.id)
            || (store.detail?.task.id == task.id && store.detail?.questions?.contains(where: { $0.status == "pending" }) == true)
    }

    private func phoneTaskRow(_ task: WorkspaceTask) -> some View {
        let pending = pendingQuestionTaskIDs.contains(task.id)
            || (store.detail?.task.id == task.id && store.detail?.questions?.contains(where: { $0.status == "pending" }) == true)
        let status = pending ? "waiting" : task.status
        return NavigationLink(value: PhoneRoute.task(task.id)) {
            HStack(alignment: .top, spacing: 12) {
                PhoneStatusDot(status: status, size: 8).padding(.top, 7)
                VStack(alignment: .leading, spacing: 5) {
                    Text(task.title).font(.body.weight(.medium)).lineLimit(phoneTypeSize.isAccessibilitySize ? 2 : 1)
                    Text(store.projects.first { $0.id == task.projectId }?.name ?? "No project")
                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    HStack(spacing: 6) {
                        Text(status == "waiting" ? "Waiting for your answer" : status == "review" ? "Ready to review" : status.capitalized)
                        if let date = phoneDate(task.updatedAt) { Text("·"); PhoneRelativeTime(date: date) }
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }.frame(minHeight: 44).padding(.vertical, 4)
        }.accessibilityElement(children: .combine)
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
                ProjectHubView(project: project, connection: connection, isPushed: true) { id in
                    selectedTab = "tasks"; taskPath = [.task(id)]
                }
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
                Text(computer + " · " + (status == "waiting" ? "Needs answer" : status.capitalized))
                    .lineLimit(phoneUsesExpandedTitle ? 2 : 1).truncationMode(.middle)
            }.font(.caption).foregroundStyle(.secondary)
                .contextMenu {
                    if let id = task?.workerId { Button("Copy computer ID") { UIPasteboard.general.string = id } }
                }
        }.fixedSize(horizontal: false, vertical: true).accessibilityElement(children: .combine)
    }

    private func phoneCompose() {
        newTaskProject = ""; showTask = true; taskPath.append(.compose)
    }

    private func phoneDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

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
    #endif

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
                Button { showSearch.toggle() } label: {
                    WorkspaceGlyph(name: .search, size: 20).frame(width: 44, height: 44)
                }.buttonStyle(.plain).modifier(WorkspaceSurface(radius: 24)).accessibilityLabel("Search tasks")
            }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 20)
            #endif
            #if os(iOS)
            if showSearch { searchField }
            #else
            searchField
            #endif
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
            WorkspaceGlyph(name: .terminal, size: 20).frame(height: 34).help("deploy.local")
            railButton("Tasks", icon: .chat, selected: true) { projectHub = nil }
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

    private var taskTree: some View {
                VStack(alignment: .leading, spacing: 18) {
                    if !matchingTasks(projectId: nil).isEmpty || !search.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Tasks").font(WorkspaceStyle.metadata.weight(.medium)).foregroundStyle(.secondary)
                            .padding(.horizontal, 10).padding(.bottom, 6)
                        let independent = matchingTasks(projectId: nil)
                        ForEach(independent) { task in taskRow(task) }
                        if independent.isEmpty {
                            Text(search.isEmpty ? "Your independent tasks appear here." : "No matching tasks")
                                .font(.caption).foregroundStyle(.tertiary).padding(.horizontal, 10).padding(.vertical, 6)
                        }
                    }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Projects").font(WorkspaceStyle.metadata.weight(.medium)).foregroundStyle(.secondary)
                            Spacer()
                            Button { showProject = true } label: { WorkspaceGlyph(name: .plus, size: 12).frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.projectHeadingHeight) }
                                .buttonStyle(.plain).help("Add project").disabled(store.connection == nil)
                                .accessibilityLabel("Add project")
                        }.padding(.horizontal, 10)
                        ForEach(store.projects) { project in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 0) {
                                    #if os(macOS)
                                    projectDisclosure(project)
                                    #endif
                                    Button { projectHub = project } label: {
                                        HStack(spacing: 8) {
                                            WorkspaceSymbol(name: "folder").foregroundStyle(.secondary)
                                            Text(project.name).lineLimit(1)
                                            Spacer(minLength: 0)
                                        }.font(WorkspaceStyle.project).frame(minHeight: WorkspaceStyle.rowHeight).contentShape(Rectangle())
                                    }.buttonStyle(.plain).accessibilityLabel("Open \(project.name) project").help("Open project overview")
                                    #if os(iOS)
                                    projectDisclosure(project)
                                    #else
                                    Button { beginTask(project.id) } label: {
                                        WorkspaceGlyph(name: .compose, size: 16).frame(width: 36, height: WorkspaceStyle.rowHeight)
                                    }.buttonStyle(.plain).foregroundStyle(.secondary).help("New task in \(project.name)")
                                        .accessibilityLabel("New task in \(project.name)")
                                    #endif
                                }.padding(.leading, WorkspaceStyle.projectHeaderInset).padding(.trailing, 4)
                                if !collapsedProjects.contains(project.id) || !search.isEmpty {
                                    Button { beginTask(project.id) } label: {
                                        Text("New task").font(WorkspaceStyle.secondaryAction).foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, minHeight: WorkspaceStyle.rowHeight, alignment: .leading)
                                            .padding(.horizontal, 10).contentShape(Rectangle())
                                    }.buttonStyle(.plain).padding(.leading, WorkspaceStyle.projectChildInset).accessibilityLabel("Create task in \(project.name)")
                                    ForEach(matchingTasks(projectId: project.id)) { task in taskRow(task).padding(.leading, WorkspaceStyle.projectChildInset) }
                                }
                            }
                        }
                    }
                }.padding(.horizontal, 8).padding(.vertical, 14)
    }

    private func projectDisclosure(_ project: Project) -> some View {
        Button {
            if collapsedProjects.contains(project.id) { collapsedProjects.remove(project.id) }
            else { collapsedProjects.insert(project.id) }
        } label: {
            Image(systemName: collapsedProjects.contains(project.id) ? "chevron.right" : "chevron.down")
                .font(.system(.caption, weight: .medium)).foregroundStyle(.secondary)
                .frame(width: WorkspaceStyle.projectDisclosureWidth, height: WorkspaceStyle.rowHeight)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("\(project.name), \(collapsedProjects.contains(project.id) ? "collapsed" : "expanded")")
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

    private func matchingTasks(projectId: String?) -> [WorkspaceTask] {
        store.tasks.filter { $0.projectId == projectId && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search)) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private func taskRow(_ task: WorkspaceTask) -> some View {
        Button {
            showTask = false
            compactColumn = .detail
            Task { await store.select(task.id) }
        } label: {
            HStack(spacing: 8) {
                Text(task.title).lineLimit(1).font(WorkspaceStyle.navigation)
                Spacer(minLength: 3)
                if ["running", "checking"].contains(task.status) {
                    Circle().fill(WorkspaceStyle.statusActive(colorScheme)).frame(width: 6, height: 6)
                }
            }.padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.rowHeight)
                .background(!showTask && store.selectedTaskId == task.id ? WorkspaceStyle.selected(colorScheme) : .clear, in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).help(task.title)
    }

    private var welcome: some View {
        VStack(spacing: 20) {
            Image(systemName: "square.stack.3d.up").font(.system(.title, weight: .light)).foregroundStyle(.secondary)
            Text("Your work. All together.").font(.system(.title, weight: .semibold))
            Text("One conversation across your computers.\nConnect to deploy.local to get started.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).lineSpacing(5)
            Button("Connect to home") { showConnection = true }
                .buttonStyle(.borderedProminent).tint(WorkspaceStyle.action(colorScheme)).controlSize(.large)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var connectionBanner: some View {
            if let error = store.error {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.circle")
                    Text(error).font(.caption).textSelection(.enabled)
                    Spacer()
                    if store.needsAuthentication {
                        Button("Sign in again") { showConnection = true }.buttonStyle(.bordered)
                    } else {
                        Button { store.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                    }
                }.padding(12).background(WorkspaceStyle.statusAttention(colorScheme).opacity(0.1))
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
            } else { StatusBadge(status: store.activeRun?.status ?? task.status).fixedSize() }
        }
    }

    private var conversation: some View {
        let taskID = store.selectedTaskId ?? ""
        return VStack(spacing: 0) {
            TranscriptView(messages: store.detail?.messages ?? [], events: store.detail?.events ?? [], activity: store.detail?.activity ?? [], active: store.isWorking, jobs: store.detail?.jobs ?? [], workers: store.state?.workers ?? [], cancelJob: { job in Task { await store.cancelJob(job) } }, questions: store.detail?.questions ?? [], bookmark: Binding(
                get: { transcriptBookmarks[taskID] ?? TranscriptBookmark() },
                set: { transcriptBookmarks[taskID] = $0 }
            ))
                .id(store.selectedTaskId)
            VStack(alignment: .leading, spacing: 10) {
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
            else { ChangesView(store: store, section: panel) }
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
        return !["succeeded", "review", "ready", "failed", "error", "running", "checking", "queued"].contains(status)
    }
    private var statusColor: Color {
        #if os(iOS)
        return WorkspaceStyle.phoneStatusColor(status, colorScheme)
        #else
        if ["review", "ready"].contains(status) { return WorkspaceStyle.statusAttention(colorScheme) }
        if status == "succeeded" { return WorkspaceStyle.statusHealthy(colorScheme) }
        if ["failed", "error"].contains(status) { return WorkspaceStyle.statusFailed(colorScheme) }
        if ["running", "checking", "queued"].contains(status) { return WorkspaceStyle.statusActive(colorScheme) }
        return WorkspaceStyle.statusInactive(colorScheme)
        #endif
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(inactive ? Color.clear : statusColor)
                .overlay(Circle().strokeBorder(statusColor, lineWidth: 1)).frame(width: 5, height: 5)
            Text(status == "review" ? "Ready to review" : status == "succeeded" ? "Complete" : status.capitalized).font(.system(.caption, weight: .medium))
        }.padding(.vertical, 4)
        #if os(iOS)
        .foregroundStyle(statusColor)
        #endif
    }
}

struct TranscriptView: View {
    let messages: [Message]
    let events: [WorkspaceEvent]
    let activity: [TaskActivity]
    let active: Bool
    let jobs: [WorkspaceJob]
    let workers: [Worker]
    let cancelJob: (WorkspaceJob) -> Void
    var questions: [WorkspaceQuestion] = []
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
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        if messages.isEmpty {
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
                    }.scrollTargetLayout().padding(.horizontal, WorkspaceStyle.conversationGutter).padding(.top, 20).padding(.bottom, 16).frame(maxWidth: WorkspaceStyle.contentWidth).frame(maxWidth: .infinity)
                }
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
    @Environment(\.colorScheme) private var colorScheme
    init(bookmark: Binding<TranscriptBookmark>, restored: Bool) {
        _bookmark = bookmark
        self.restored = restored
        let saved = bookmark.wrappedValue
        _position = State(initialValue: saved.follow ? ScrollPosition(edge: .bottom) : ScrollPosition(y: saved.offset ?? 0))
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
            .overlay {
                if scrollFocused {
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(WorkspaceStyle.accent(colorScheme).opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        .padding(3).allowsHitTesting(false)
                }
            }
            .accessibilityLabel("Conversation")
            .onAppear { restore() }
            .onChange(of: restored) { _, _ in restore() }
            .onScrollPhaseChange { _, phase in
                userScrolling = phase == .interacting || phase == .decelerating
                if restored, userScrolling { bookmark.follow = false }
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
                    position.scrollTo(y: saved)
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
        position.scrollTo(y: next)
        return .handled
    }
    private func restore() {
        if restored, !bookmark.follow, let offset = bookmark.offset { position.scrollTo(y: offset) }
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
