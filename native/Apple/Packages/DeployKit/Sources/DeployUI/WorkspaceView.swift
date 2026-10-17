import SwiftUI
import DeployCore

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
    @FocusState private var composerFocused: Bool

    public init(store: WorkspaceStore) { self.store = store }

    public var body: some View {
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
                            Button { showToolSheet = true } label: {
                                WorkspaceToolbarIcon("Review changes", symbol: "sidebar.right")
                            }.buttonStyle(WorkspaceToolbarButtonStyle())
                                .disabled(showTask || store.currentTask == nil)
                        }.workspaceToolbarChrome()
                    }
                    #endif
            }
        }
        #if os(macOS)
        .toolbar(removing: .sidebarToggle)
        #endif
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
            NavigationStack { inspector.toolbar { Button("Done") { showToolSheet = false } } }
        }
        .onChange(of: store.selectedTaskId) { _, id in if id != nil { compactColumn = .detail } }
        #if os(macOS)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly } label: {
                    WorkspaceToolbarIcon("Toggle sidebar", symbol: "sidebar.left")
                }.buttonStyle(WorkspaceToolbarButtonStyle())
                    .help("Toggle sidebar · ⌘⌃S")
                    .keyboardShortcut("s", modifiers: [.command, .control])
            }.workspaceToolbarChrome()
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: WorkspaceStyle.Toolbar.spacing) {
                    Button { showComputer.toggle() } label: {
                        WorkspaceToolbarIcon("Computer use", symbol: "display")
                    }.buttonStyle(WorkspaceToolbarButtonStyle(selected: showComputer))
                        .help(showComputer ? "Hide computer use" : "Open computer use")
                        .accessibilityValue(showComputer ? "Shown" : "Hidden")
                        .disabled(showTask || store.currentTask == nil)
                    Button { beginTask() } label: {
                        WorkspaceToolbarIcon("New task", symbol: "square.and.pencil")
                    }.buttonStyle(WorkspaceToolbarButtonStyle())
                        .help("New task · ⌘N").keyboardShortcut("n")
                        .disabled(store.connection == nil)
                    Button { showInspector.toggle() } label: {
                        WorkspaceToolbarIcon("Changes and tools", symbol: "sidebar.right")
                    }.buttonStyle(WorkspaceToolbarButtonStyle(selected: showInspector))
                        .help(showInspector ? "Hide changes and tools · ⌘⇧I" : "Show changes and tools · ⌘⇧I")
                        .keyboardShortcut("i", modifiers: [.command, .shift])
                        .accessibilityValue(showInspector ? "Shown" : "Hidden")
                        .disabled(showTask || store.currentTask == nil)
                }
            }.workspaceToolbarChrome()
        }
        #endif
        .onChange(of: store.draft) { _, _ in store.saveDraft() }
        .onDisappear { store.saveDraft() }
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
                    Image(systemName: "person.crop.circle").font(.system(size: 20)).frame(width: 44, height: 44)
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
                    Image(systemName: "magnifyingglass").font(.system(size: 20)).frame(width: 44, height: 44)
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
                    Image(systemName: "square.and.pencil").font(.system(size: 20))
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
            Image(systemName: "terminal").font(.system(size: 17)).frame(height: 34).help("deploy.local")
            railButton("Tasks", symbol: "bubble.left", selected: true) { projectHub = nil }
            railButton("Computers", symbol: "desktopcomputer") { showComputers = true }
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
            railButton("Connection settings", symbol: "slider.horizontal.3") { showConnection = true }
            railButton("Account and provider usage", symbol: "person.crop.circle") { showAccount.toggle() }
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
    private func railButton(_ title: String, symbol: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 17, weight: .regular))
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
                            Button { showProject = true } label: { Image(systemName: "plus").font(.system(size: 12)).frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.projectHeadingHeight) }
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
                                        Image(systemName: "square.and.pencil").font(.system(size: 14)).frame(width: 36, height: WorkspaceStyle.rowHeight)
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
                .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
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
                    Circle().fill(WorkspaceStyle.accent(colorScheme)).frame(width: 6, height: 6)
                }
            }.padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.rowHeight)
                .background(!showTask && store.selectedTaskId == task.id ? Color.primary.opacity(0.075) : .clear, in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).help(task.title)
    }

    private var welcome: some View {
        VStack(spacing: 20) {
            Image(systemName: "square.stack.3d.up").font(.system(size: 44, weight: .light)).foregroundStyle(.secondary)
            Text("Your work. All together.").font(.system(size: 28, weight: .semibold))
            Text("One conversation across your computers.\nConnect to deploy.local to get started.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).lineSpacing(5)
            Button("Connect to home") { showConnection = true }
                .buttonStyle(.borderedProminent).controlSize(.large)
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
                }.padding(12).background(Color.orange.opacity(0.1))
            }
    }

    private var workspace: some View {
        VStack(spacing: 0) {
            if let task = store.currentTask {
                #if os(iOS)
                conversationPlacement(task)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, WorkspaceStyle.conversationGutter).padding(.top, 2).padding(.bottom, 8)
                #else
                HStack(spacing: 16) {
                    conversationProject
                    Spacer(minLength: 12)
                    conversationPlacement(task)
                }.padding(.horizontal, 24).padding(.vertical, 8)
                #endif
                GeometryReader { geometry in
                    HStack(alignment: .top, spacing: 0) {
                        conversation.frame(maxWidth: .infinity)
                        if showInspector && geometry.size.width > 780 {
                            inspector.frame(width: min(310, geometry.size.width * 0.34)).frame(maxHeight: panel == "Browser" ? 460 : 420)
                                .modifier(WorkspaceSurface(radius: 16)).padding(.trailing, 12).padding(.bottom, 12)
                        }
                    }
                }
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "bubble.left.and.text.bubble.right").font(.system(size: 38, weight: .light)).foregroundStyle(.secondary)
                    Text("What would you like to work on?").font(.title2.weight(.semibold))
                    Text("Choose a conversation, or start something new.").foregroundStyle(.secondary)
                    Button(store.projects.isEmpty ? "Add a repository" : "New task") {
                        if store.projects.isEmpty { showProject = true } else { showTask = true }
                    }.buttonStyle(.borderedProminent)
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
                }.padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 8).modifier(WorkspaceSurface(radius: 22))
                }
                if !store.isConnected {
                    Text(store.needsAuthentication ? "Sign in again. Draft saved on this device." : "Offline. Draft saved on this device.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                #if os(macOS)
                HStack { Spacer(); Text("⌘ Return to send") }.font(.system(size: 11)).foregroundStyle(.secondary)
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
            else { Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).frame(width: 24, height: 24) }
        }.buttonStyle(WorkspaceSendStyle())
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy || store.isWorking || !store.isConnected)
            .accessibilityLabel("Send message")
    }

    private var inspector: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(["Changes", "Browser"], id: \.self) { value in
                    Button {
                        #if os(macOS)
                        if value == "Browser" { showComputer = true; showInspector = false } else { panel = value }
                        #else
                        panel = value
                        #endif
                    } label: {
                        Text(value == "Browser" ? "Controls" : value).font(WorkspaceStyle.navigation)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(panel == value ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 8))
                    }.buttonStyle(.plain).foregroundStyle(panel == value ? .primary : .secondary)
                }
                Spacer()
            }.padding(10)
            Divider().opacity(0.5)
            if panel == "Changes" { ChangesView(store: store) }
            else if panel == "Browser" { BrowserPanel(store: store) }

        }.tint(WorkspaceStyle.accent(colorScheme))
    }
}

struct StatusBadge: View {
    let status: String
    @Environment(\.colorScheme) private var colorScheme
    private var statusColor: Color {
        if ["succeeded", "review"].contains(status) { return WorkspaceStyle.success(colorScheme) }
        if ["failed", "error"].contains(status) { return WorkspaceStyle.danger(colorScheme) }
        if status == "running" { return WorkspaceStyle.accent(colorScheme) }
        return .secondary
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(statusColor).frame(width: 5, height: 5)
            Text(status == "review" ? "Ready to review" : status == "succeeded" ? "Complete" : status.capitalized).font(.system(size: 11, weight: .medium))
        }.padding(.vertical, 4)
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
                                    Text("Checkpoint \(job.digest.prefix(12))" + (job.exitCode.map { " · Exit \($0)" } ?? "")).font(.caption).foregroundStyle(.secondary)
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
                                    Spacer()
                                    Text(job.stopRequested == true && job.isActive ? "Stopping…" : job.status.replacingOccurrences(of: "_", with: " ").capitalized).foregroundStyle(.secondary)
                                }.font(.caption)
                            }.padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                        }
                        } label: { Label("Processes across computers · \(jobs.count)", systemImage: "terminal") }
                            .font(.caption).foregroundStyle(.secondary)
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

struct ChangesView: View {
    @Bindable var store: WorkspaceStore
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Spacer()
                    Button { Task { await store.loadDiff() } } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.plain).accessibilityLabel("Refresh changes")
                }
                if let diff = store.diff {
                    if diff.files.isEmpty {
                        Label("No changes yet", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(diff.files) { file in
                                HStack(spacing: 9) {
                                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                                    Text(file.path).lineLimit(1)
                                    Spacer()
                                    Text(file.status.contains("?") || file.status == "A" ? "Added" : "Modified")
                                        .font(.caption).foregroundStyle(.secondary)
                                }.font(.system(size: 13))
                            }
                        }
                        DisclosureGroup("View diff") { PatchView(patch: diff.patch).padding(.top, 10) }
                            .font(.system(size: 13, weight: .medium))
                    }
                } else { ProgressView().controlSize(.small) }
                Divider()
                VStack(alignment: .leading, spacing: 14) {
                    Text("Checks").font(WorkspaceStyle.navigation.weight(.medium))
                    if store.diff?.checks.isEmpty != false && (store.detail?.jobs?.isEmpty ?? true) {
                        Text(store.currentTask?.workerId == nil || store.currentTask?.workerId == "local" ? "Run a command to verify your changes." : "Ask the task to run checks on its computer.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                    }
                    ForEach(Array((store.diff?.checks ?? []).reversed().enumerated()), id: \.offset) { _, check in
                        CheckRow(check: check)
                    }
                    ForEach(store.detail?.jobs ?? []) { job in
                        CheckpointJobRow(job: job)
                    }
                    if store.currentTask?.workerId == nil || store.currentTask?.workerId == "local" {
                        HStack {
                            TextField("Check command", text: $store.checkCommand).textFieldStyle(.plain)
                                .font(.system(size: 12, design: .monospaced)).accessibilityLabel("Check command")
                            Button { Task { await store.runCheck() } } label: { Image(systemName: "play.fill") }
                                .buttonStyle(.plain).disabled(store.busy || store.isWorking).accessibilityLabel("Run check")
                        }.padding(12).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 9))
                    }
                }
            }.padding(20)
        }.task(id: store.selectedTaskId) { await store.loadDiff() }
    }
}

private struct CheckRow: View {
    let check: JSONValue
    private func value(_ key: String) -> String {
        guard case .object(let object) = check else { return "" }
        return object[key]?.displayText ?? ""
    }
    private var status: String {
        if !value("status").isEmpty { return value("status") }
        guard case .object(let object) = check, case .number(let code) = object["exitCode"] else { return "unknown" }
        return code == 0 ? "succeeded" : "failed"
    }
    var body: some View {
        DisclosureGroup {
            if !value("output").isEmpty {
                ScrollView(.horizontal) {
                    Text(value("output")).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).padding(10)
                }.background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }
            if !value("error").isEmpty { Text(value("error")).font(.caption).foregroundStyle(.secondary) }
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: status == "succeeded" ? "checkmark.circle.fill" : status == "failed" ? "xmark.circle" : "clock")
                    .foregroundStyle(status == "succeeded" ? Color.green : Color.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(value("command")).font(.system(size: 12, design: .monospaced)).lineLimit(2)
                    Text(status == "succeeded" ? "Passed" : status.capitalized).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct PatchView: View {
    let patch: String
    @Environment(\.colorScheme) private var colorScheme
    private var added: Color { colorScheme == .dark ? Color(red: 0.45, green: 0.83, blue: 0.57) : Color(red: 0.13, green: 0.43, blue: 0.25) }
    private var removed: Color { colorScheme == .dark ? Color(red: 0.95, green: 0.53, blue: 0.53) : Color(red: 0.70, green: 0.18, blue: 0.18) }
    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(patch.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        .foregroundStyle(line.hasPrefix("+") ? added : line.hasPrefix("-") ? removed : Color.primary)
                        .padding(.vertical, 2).padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background { Rectangle().fill(line.hasPrefix("+") ? added.opacity(0.08) : line.hasPrefix("-") ? removed.opacity(0.08) : .clear) }
                }
            }
        }.background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
    }
}

