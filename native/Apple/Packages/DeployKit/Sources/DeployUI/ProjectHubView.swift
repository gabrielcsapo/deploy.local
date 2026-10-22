import SwiftUI
import DeployCore

@MainActor
struct ProjectHubView: View {
    let project: Project
    let connection: Connection
    var isPushed = false
    var tasks: [WorkspaceTask] = []
    var workers: [Worker] = []
    /// Task review opens the record directly and every dismissal returns to that task.
    var taskOrigin = false
    let openTask: (String) -> Void
    var fileTaskId: String?
    var filePath: String
    var newTaskFromFile: ((String, String) -> Void)?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var isPhone: Bool { horizontalSizeClass == .compact && isPushed }
    #else
    private var isPhone: Bool { false }
    #endif
    @State private var model: ProjectReviewModel
    @State private var composing: ReviewComposeView.Mode?

    init(project: Project, connection: Connection, isPushed: Bool = false, tasks: [WorkspaceTask] = [], workers: [Worker] = [],
         section: String = "repository", selected: String = "", taskOrigin: Bool = false, fileTaskId: String? = nil, filePath: String = "", newTaskFromFile: ((String, String) -> Void)? = nil, openTask: @escaping (String) -> Void) {
        self.project = project; self.connection = connection; self.isPushed = isPushed
        self.tasks = tasks; self.workers = workers; self.taskOrigin = taskOrigin; self.openTask = openTask
        self.fileTaskId = fileTaskId; self.filePath = filePath; self.newTaskFromFile = newTaskFromFile
        _model = State(initialValue: ProjectReviewModel(projectId: project.id, connection: connection,
                                                        section: section, selected: selected))
        _composing = State(initialValue: nil)
    }

    private var projectTasks: [WorkspaceTask] { tasks.filter { $0.projectId == project.id } }

    var body: some View {
        Group {
            #if os(macOS)
            NavigationStack {
                Group {
                    if taskOrigin { taskReview } else { splitHub }
                }.toolbar {
                    if !isPushed {
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: WorkspaceStyle.space2) {
                            WorkspaceGlyph(name: .folder)
                            Text(model.selected.isEmpty ? project.name : model.record?.displayTitle ?? project.name).font(WorkspaceStyle.navigation).lineLimit(1)
                        }
                    }
                    }
                    ToolbarItem(placement: .automatic) {
                        WorkspaceActionCluster {
                            if !taskOrigin && (!model.selected.isEmpty || composing != nil) {
                                WorkspaceIconButton(label: "Back to \(sectionTitle.lowercased())", icon: .back) {
                                    if composing != nil { composing = nil } else { model.select("") }
                                }
                            }
                            if !isPushed { WorkspaceIconButton(label: taskOrigin ? "Back to task" : "Close \(project.name)", icon: taskOrigin ? .back : .close) { dismiss() }.keyboardShortcut(.cancelAction) }
                        }
                    }
                }
            }
            #else
            if taskOrigin { taskReview }
            else if isPhone { phoneHub }
            else { splitHub }
            #endif
        }
        .tint(WorkspaceStyle.accent(colorScheme))
        #if os(macOS)
        .frame(minWidth: isPushed ? nil : 860, idealWidth: isPushed ? nil : 1040, minHeight: isPushed ? nil : 600, idealHeight: isPushed ? nil : 760)
        #endif
        .task {
            while !Task.isCancelled {
                await model.refresh()
                try? await Task.sleep(for: model.pollInterval)
            }
        }
        .onChange(of: model.section) { _, _ in composing = nil; Task { await model.refresh() } }
        .onChange(of: model.selected) { _, _ in Task { await model.refresh() } }
    }

    private var taskReview: some View {
        VStack(spacing: 0) {
            #if os(iOS)
            if !isPushed {
                HStack {
                    WorkspaceIconButton(label: "Back to task", icon: .back, shortcut: "Esc") { dismiss() }.keyboardShortcut(.cancelAction)
                    Spacer()
                }.padding(16)
            }
            #endif
            if let composing { composer(composing) } else { detail }
        }
        .background(WorkspaceStyle.canvas(colorScheme))
    }

    /// The project workspace: a context rail that matches the main sidebar and a work pane with a location header.
    private var splitHub: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    WorkspaceSymbol(name: "folder").foregroundStyle(WorkspaceStyle.secondaryText(colorScheme))
                    Text(project.name).font(WorkspaceStyle.project).lineLimit(1)
                }
                .padding(.horizontal, 10).padding(.top, 18).padding(.bottom, 14)
                .accessibilityAddTraits(.isHeader)
                projectSection("Files", id: "repository", icon: .folder)
                projectSection("Issues", id: "issues", icon: .circle)
                projectSection("Pull requests", id: "pulls", icon: .pullRequest)
                projectSection("Pipelines", id: "pipelines", icon: .terminal)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(width: 216)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(WorkspaceStyle.sidebar(colorScheme))
            Divider().opacity(0.45)
            VStack(spacing: 0) {
                #if os(macOS)
                if model.section != "repository" && model.selected.isEmpty && composing == nil {
                    HStack {
                        Button(createTitle) { beginCreation() }.buttonStyle(.workspacePrimary)
                            .keyboardShortcut("n", modifiers: [.command, .shift]).disabled(model.busy)
                        Spacer()
                    }.padding(WorkspaceStyle.space4)
                }
                #else
                locationHeader
                Divider().opacity(0.45)
                #endif
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(WorkspaceStyle.canvas(colorScheme))
        }
    }

    /// 56 pt location header: the current resource and its immediate actions (design system).
    private var locationHeader: some View {
        HStack(spacing: 6) {
            if !model.selected.isEmpty || composing != nil {
                WorkspaceIconButton(label: "Back to \(sectionTitle.lowercased())", icon: .back) {
                    if composing != nil { composing = nil } else { model.select("") }
                }
                .keyboardShortcut(composing == nil ? .cancelAction : nil)
                .help("Back to \(sectionTitle.lowercased())")
            }
            Text(headerTitle).font(.title3.weight(.semibold)).lineLimit(1)
            Spacer(minLength: 12)
            if model.section != "repository" && model.selected.isEmpty && composing == nil {
                Button { beginCreation() } label: {
                    Label(createTitle, systemImage: "plus").labelStyle(.titleAndIcon)
                }
                .buttonStyle(.workspacePrimary)
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(model.busy)
            }
            WorkspaceIconButton(label: "Close \(project.name)", icon: .close) { dismiss() }
            .keyboardShortcut(model.selected.isEmpty && composing == nil ? .cancelAction : nil)
        }
        .padding(.leading, 24).padding(.trailing, 12)
        .frame(height: 56)
    }

    private var headerTitle: String {
        if let composing {
            switch composing {
            case .pull: return "New pull request"
            case .issue: return "New issue"
            case .pipeline: return "Run pipeline"
            case .edit: return model.section == "pulls" ? "Edit pull request" : "Edit issue"
            }
        }
        return sectionTitle
    }

    @ViewBuilder private var content: some View {
        if model.section == "repository" {
            repositoryView
        } else if let composing {
            composer(composing)
        } else if !model.selected.isEmpty {
            detail
        } else {
            listView
        }
    }

    private func composer(_ mode: ReviewComposeView.Mode) -> some View {
        ReviewComposeView(mode: mode, model: model, tasks: projectTasks, initialTaskIds: []) { _ in
            composing = nil
            if taskOrigin { dismiss() }
        }.id(mode == .edit ? "edit-\(model.selected)" : "new-\(model.section)")
    }

    @ViewBuilder private var detail: some View {
        switch model.section {
        case "pulls":
            PullRequestDetailView(model: model, tasks: projectTasks, workers: workers, showsBack: false, chromeInNavigationBar: isPhone,
                                  openTask: openLinkedTask, openPipeline: openPipeline, edit: { composing = .edit })
        case "issues":
            IssueDetailView(model: model, tasks: projectTasks, showsBack: false, chromeInNavigationBar: isPhone, openTask: openLinkedTask, edit: { composing = .edit })
        default:
            PipelineDetailView(model: model, workers: workers, showsBack: false)
        }
    }

    private var createTitle: String { model.section == "pipelines" ? "Run pipeline" : model.section == "pulls" ? "New pull request" : "New issue" }
    private func beginCreation() {
        model.error = nil
        composing = model.section == "pipelines" ? .pipeline : model.section == "pulls" ? .pull : .issue
    }

    #if os(iOS)
    private var phoneHub: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    phoneChip("Issues", id: "issues")
                    phoneChip("Pull requests", id: "pulls")
                    phoneChip("Pipelines", id: "pipelines")
                    phoneChip("Repository", id: "repository")
                }.padding(.horizontal, 16).padding(.vertical, 10)
            }.scrollIndicators(.hidden).fixedSize(horizontal: false, vertical: true)
            if model.section == "repository" { repositoryView }
            else { listView }
        }
        .background(WorkspaceStyle.canvas(colorScheme))
        .navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if model.section != "repository" {
                    Button { beginCreation() } label: { WorkspaceGlyph(name: .plus, size: 22) }
                        .accessibilityLabel(createTitle).disabled(model.busy)
                }
            }
        }
        .navigationDestination(isPresented: Binding(get: { !model.selected.isEmpty }, set: { if !$0 { model.select("") } })) {
            detail.navigationTitle(model.section == "pulls" ? "Pull request" : model.section == "issues" ? "Issue" : "Pipeline run").navigationBarTitleDisplayMode(.inline)
                .toolbar(.hidden, for: .tabBar)
                .navigationDestination(isPresented: Binding(get: { composing == .edit }, set: { if !$0 { composing = nil } })) {
                    composer(.edit).navigationTitle("Edit").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
                }
        }
        .navigationDestination(isPresented: Binding(get: { composing != nil && composing != .edit && model.selected.isEmpty },
                                                    set: { if !$0 && composing != .edit { composing = nil } })) {
            if let composing, composing != .edit {
                composer(composing).navigationTitle(createTitle).navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
            }
        }
    }
    private func phoneChip(_ title: String, id: String) -> some View {
        Button { model.show(section: id) } label: {
            Text(title).font(.subheadline.weight(.medium)).fixedSize()
                .padding(.horizontal, 16).frame(minHeight: 44)
                .foregroundStyle(model.section == id ? WorkspaceStyle.canvas(colorScheme) : WorkspaceStyle.accent(colorScheme))
                .background(model.section == id ? WorkspaceStyle.accent(colorScheme) : WorkspaceStyle.raised(colorScheme), in: Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(model.section == id ? .isSelected : [])
    }
    #endif

    private var sectionTitle: String {
        switch model.section {
        case "issues": "Issues"
        case "pulls": "Pull requests"
        case "pipelines": "Pipelines"
        default: "Files"
        }
    }
    private func projectSection(_ title: String, id: String, icon: WorkspaceGlyphName) -> some View {
        let selected = model.section == id
        return Button {
            model.show(section: id)
            composing = nil
        } label: {
            HStack(spacing: 10) {
                WorkspaceGlyph(name: icon, size: 18)
                    .foregroundStyle(selected ? WorkspaceStyle.accent(colorScheme) : WorkspaceStyle.secondaryText(colorScheme))
                Text(title).font(WorkspaceStyle.navigation.weight(selected ? .medium : .regular))
                    .foregroundStyle(WorkspaceStyle.text(colorScheme))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.rowHeight)
            .background(selected ? WorkspaceStyle.selected(colorScheme) : .clear, in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private var listView: some View {
        if model.items.isEmpty {
            VStack {
                if !model.loaded && model.error == nil { WorkspaceSkeleton() }
                else {
                    ContentUnavailableView {
                        Label("No \(sectionTitle.lowercased()) yet", systemImage: model.section == "pipelines" ? "terminal" : model.section == "pulls" ? "arrow.triangle.pull" : "circle")
                    } description: {
                        Text(model.section == "pipelines" ? "Define a pipeline in deploy.yaml, then run it here or push a commit."
                             : model.section == "pulls" ? "Open a pull request to review, check and merge a branch."
                             : "Capture work here, then start a coding task when you’re ready.")
                    } actions: { Button(createTitle) { beginCreation() }.buttonStyle(.workspacePrimary).disabled(model.busy) }
                }
                if let error = model.error { Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(colorScheme)) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(WorkspaceStyle.canvas(colorScheme))
        } else {
            List {
                if let error = model.error {
                    Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(colorScheme)).listRowBackground(Color.clear)
                }
                ForEach(model.items) { item in
                    Button { model.select(item.id) } label: { ReviewRecordRow(item: item, section: model.section) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: isPhone ? 16 : 20, bottom: 0, trailing: isPhone ? 16 : 20))
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(WorkspaceStyle.canvas(colorScheme))
        }
    }

    private var repositoryView: some View {
        RepositoryBrowserView(projectId: project.id, connection: connection, repository: model.repository,
                              tasks: projectTasks, initialTaskId: fileTaskId, initialPath: filePath,
                              startTask: { ref, path in newTaskFromFile?(ref, path) }) {
            Task { await model.retryRepository() }
        }
    }

    private func openLinkedTask(_ id: String) {
        if !isPhone { dismiss() }
        openTask(id)
    }
    private func openPipeline(_ id: String) {
        model.show(section: "pipelines")
        model.select(id)
    }
}

/// One resource row: state glyph, title, identity line and state badge (`ResourceRow` on the web).
struct ReviewRecordRow: View {
    let item: ProjectWorkItem
    let section: String
    @Environment(\.colorScheme) private var scheme

    private var state: (label: String, tone: String) {
        if section == "pipelines" { return (pipelineLabel(item.status), pipelineTone(item.status)) }
        let phase = pullPhase(record: item, operation: nil)
        return (phase.label, section == "issues" && item.status == "open" ? "attention" : phase.tone)
    }
    private var glyph: WorkspaceGlyphName { section == "pulls" ? .pullRequest : section == "pipelines" ? .terminal : .circle }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            WorkspaceGlyph(name: glyph, size: 20).foregroundStyle(WorkspaceStyle.tone(state.tone, scheme))
            VStack(alignment: .leading, spacing: 4) {
                Text(item.displayTitle).font(WorkspaceStyle.project).foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(2)
                HStack(spacing: 5) {
                    if let number = item.number { Text("#\(number)").font(.system(.caption, design: .monospaced)) }
                    if let source = item.sourceBranch, let target = item.targetBranch {
                        Text("·"); Text("\(source) → \(target)").font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                    }
                    if section == "pipelines", let commit = item.commit {
                        Text(item.trigger == "push" ? "Push" : item.trigger == "manual" ? "Manual" : "Checks")
                        Text("·"); Text(String(commit.prefix(7))).font(.system(.caption, design: .monospaced))
                    }
                    if let date = workspaceDate(item.updatedAt ?? item.createdAt) { Text("·"); ReviewRelativeTime(date: date) }
                }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme)).lineLimit(1)
            }
            Spacer(minLength: 8)
            ReviewStateBadge(label: state.label, tone: state.tone)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
        }
        .padding(.vertical, 12)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
