import SwiftUI
import DeployCore

/// Review is a work surface: changes and checks each have a readable, full-height pane.
struct ChangesView: View {
    @Bindable var store: WorkspaceStore
    var section = "Changes"
    var viewFile: ((String) -> Void)? = nil
    /// The task's pull request, so reviewing changes continues into merging them.
    var openPullRequest: ((ProjectWorkItem?) -> Void)? = nil
    var openActivityCheck: ((String) -> Void)? = nil
    @Environment(\.colorScheme) private var scheme
    private var patches: [ReviewFilePatch] {
        guard let diff = store.shownDiff else { return [] }
        return reviewFilePatches(diff.patch, files: diff.files)
    }
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var phoneWidth: Bool { horizontalSizeClass == .compact }
    #else
    private var phoneWidth: Bool { false }
    #endif
    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { reader in
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if let openPullRequest, store.currentTask?.projectId != nil {
                            TaskPublishView(store: store) { openPullRequest($0) }
                        }
                        if section == "Checks" { checks }
                        else {
                            Picker("Changes shown", selection: Binding(get: { store.diffScope },
                                                                       set: { scope in Task { await store.setDiffScope(scope) } })) {
                                ForEach(DiffScope.allCases, id: \.self) { Text($0.title).tag($0) }
                            }.pickerStyle(.segmented).labelsHidden()
                                // Full width on iPhone, like other sheet controls; centred at a fixed width on wider screens.
                                .frame(maxWidth: phoneWidth ? .infinity : 280).frame(maxWidth: .infinity)
                                .accessibilityIdentifier("diff-scope")
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(summary).font(WorkspaceStyle.navigation.weight(.medium))
                                    Spacer()
                                    WorkspaceIconButton(label: "Refresh changes", icon: .refresh) { Task { await store.loadDiff() } }
                                }
                                if store.shownDiff?.scope == "turn" {
                                    Text(store.activeRun?.id == store.shownDiff?.runId && store.activeRun != nil ? "So far, since this turn started" : "Since this turn started")
                                        .font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                                }
                                if let note = store.shownDiff?.note, !note.isEmpty {
                                    Text(note).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                                }
                                fileNotice
                            }
                            if let diff = store.shownDiff {
                                ReviewDiffList(files: diff.files, patches: patches, width: geometry.size.width - 48, reader: reader,
                                               emptyMessage: diff.scope == "turn" ? "This turn made no file changes" : "No changes in this task",
                                               viewFile: viewFile, focusedLine: focusedLine)
                            } else if let error = store.error {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme))
                                    WorkspaceIconButton(label: "Retry changes", icon: .refresh) { Task { await store.loadDiff() } }
                                }
                            } else { WorkspaceSkeleton(label: "Loading changes") }
                        }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }.accessibilityLabel(section == "Checks" ? "Task checks" : "Task changes")
                    // Runs on appear too, so a link that opened this view still scrolls once it lays out.
                    .task(id: store.fileFocus?.request) {
                        guard case .diff(let path, let line)? = store.fileFocus?.focus else { return }
                        try? await Task.sleep(for: .milliseconds(200))
                        withAnimation { reader.scrollTo(path, anchor: .top) }
                        if let line {
                            try? await Task.sleep(for: .milliseconds(250))
                            withAnimation { reader.scrollTo("\(path)#L\(line)", anchor: .center) }
                        }
                    }
            }
        }.task(id: store.selectedTaskId) { await store.loadDiff() }
    }
    private var summary: String {
        guard let diff = store.shownDiff else { return "Loading changes…" }
        // The task computer has not reported against its new baseline yet; the note says why.
        if diff.baselinePending == true, diff.scope != "turn" { return "Not uploaded yet" }
        return "\(diff.files.count) changed \(diff.files.count == 1 ? "file" : "files")" + (diff.scope == "turn" ? " this turn" : "")
    }
    private var focusedLine: (path: String, line: Int)? {
        guard case .diff(let path, let line?)? = store.fileFocus?.focus else { return nil }
        return (path, line)
    }
    /// A linked file the diff cannot show: say so plainly, and open unchanged files in the repository.
    @ViewBuilder private var fileNotice: some View {
        if let focus = store.fileFocus, focus.focus == .unchanged || focus.focus == .listedWithoutDiff {
            HStack(spacing: 12) {
                Text(focus.focus == .unchanged ? "\(focus.reference.path) has no changes in this task."
                                               : "\(focus.reference.path) changed, but its diff isn’t shown here.")
                    .font(WorkspaceStyle.metadata)
                if focus.focus == .unchanged, let viewFile {
                    Button("View file") { viewFile(focus.reference.path) }.buttonStyle(.workspaceLink)
                }
            }.accessibilityElement(children: .combine)
        }
    }
    private var checks: some View {
        VStack(alignment: .leading, spacing: 20) {
            if store.diff?.checks.isEmpty != false && (store.detail?.jobs?.isEmpty ?? true) {
                Text(store.currentTask?.workerId == nil || store.currentTask?.workerId == "local" ? "Run a command to verify your changes." : "Ask the task to run checks on its computer.")
                    .font(WorkspaceStyle.navigation).foregroundStyle(.secondary)
            }
            ForEach(Array((store.diff?.checks ?? []).reversed().enumerated()), id: \.offset) { _, check in
                ReviewCheckRow(check: check)
            }
            let latest = TaskActivitySummary.latestChecks(store.detail?.jobs ?? [])
            ForEach(Array(Set(latest.map { $0.latest.workerId ?? "" })).sorted(), id: \.self) { workerId in
                Text(store.state?.workers.first { $0.id == workerId }?.name ?? (workerId.isEmpty ? "Waiting for computer" : workerId)).font(.headline)
                ForEach(latest.filter { ($0.latest.workerId ?? "") == workerId }) { check in
                    HStack {
                        JobStatusGlyph(job: check.latest)
                        Button(check.latest.title) { openActivityCheck?(check.id) }.buttonStyle(.workspaceLink)
                        Spacer(); Text(check.latest.statusLabel); Text(check.latest.duration())
                        if check.latest.status == "succeeded" && check.failures > 0 { Text("after \(check.failures) failure\(check.failures == 1 ? "" : "s")") }
                    }.font(WorkspaceStyle.metadata)
                }
            }
            if store.currentTask?.workerId == nil || store.currentTask?.workerId == "local" {
                HStack(spacing: 12) {
                    TextField("Check command", text: $store.checkCommand).textFieldStyle(.plain)
                        .font(.system(.subheadline, design: .monospaced)).accessibilityLabel("Check command")
                    Button { Task { await store.runCheck() } } label: { Image(systemName: "play.fill") }
                        .buttonStyle(.plain).disabled(store.busy || store.isWorking).accessibilityLabel("Run check")
                }.padding(14).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

private struct ReviewCheckRow: View {
    let check: JSONValue
    @Environment(\.colorScheme) private var scheme
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
                ScrollView(.horizontal) { Text(value("output")).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding(12) }
                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            }
            if !value("error").isEmpty { Text(value("error")).font(.caption).foregroundStyle(WorkspaceStyle.danger(scheme)) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: status == "succeeded" ? "checkmark.circle.fill" : status == "failed" ? "xmark.circle" : "clock")
                    .foregroundStyle(status == "succeeded" ? WorkspaceStyle.success(scheme) : status == "failed" ? WorkspaceStyle.danger(scheme) : .secondary)
                VStack(alignment: .leading, spacing: 5) {
                    Text(value("command")).font(.system(.subheadline, design: .monospaced)).lineLimit(2)
                    Text(status == "succeeded" ? "Passed" : status.capitalized).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Publish straight from task changes, without asking the person to supply a Git branch.
private struct TaskPublishView: View {
    @Bindable var store: WorkspaceStore
    let open: (ProjectWorkItem) -> Void
    @State private var editedTitle: String?
    @State private var editedDescription: String?
    /// The suggested description is Markdown; it shows rendered, as the pull request will, until edited.
    @State private var editingDescription = false
    private var title: String {
        editedTitle ?? store.detail?.publishDefaults?.title ?? changeTitle(store.currentTask?.title ?? "", firstMessage: store.detail?.messages.first { $0.role == "user" }?.content ?? "")
    }
    private var description: String { editedDescription ?? store.detail?.publishDefaults?.body ?? "" }
    @Environment(\.colorScheme) private var scheme
    private var linkedPulls: [ProjectWorkItem] {
        guard let id = store.currentTask?.id else { return [] }
        let linked = store.projectPulls.filter { $0.taskIds?.contains(id) == true }
        if let pull = store.linkedPull, !linked.contains(where: { $0.id == pull.id }) { return linked + [pull] }
        return linked
    }
    private var state: TaskPublishState {
        TaskPublishState(taskStatus: store.currentTask?.status, workspaceStatus: store.currentTask?.workspaceStatus,
                         pulls: linkedPulls, latestCheckpoint: store.detail?.latestCheckpoint, diff: store.diff,
                         working: store.isWorking, busy: store.busy)
    }
    var body: some View {
        let state = state
        VStack(alignment: .leading, spacing: 12) {
            if state.merged && state.pull == nil { Text("Merged").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.success(scheme)) }
            if let pull = state.pull {
                Button("#\(pull.number ?? 0) \(pull.displayTitle)") { open(pull) }.buttonStyle(.workspaceLink)
                HStack {
                    let phase = pullPhase(record: pull, operation: nil)
                    ReviewStateBadge(label: phase.label, tone: phase.tone)
                    Text("\(pull.sourceBranch ?? "") → \(pull.targetBranch ?? "")").font(WorkspaceStyle.metadata.monospaced())
                }
            } else if let task = store.currentTask {
                Text("task/\(task.id.replacingOccurrences(of: "-", with: "").prefix(8))").font(WorkspaceStyle.metadata.monospaced())
            }
            if let task = store.currentTask, task.projectId != nil {
                let update = task.baseUpdate
                HStack {
                    Button(update?.running == true ? "Updating from main…" : update?.pending == true ? (update?.status == "failed" ? "Resume update" : "Continue update") : "Update from main") {
                        Task { await store.updateBase(action: update?.pending == true ? "continue" : "update") }
                    }.buttonStyle(.workspaceLink).disabled(store.busy || store.isWorking || update?.running == true)
                    if update?.pending == true {
                        Button("Abort update") { Task { await store.updateBase(action: "abort") } }
                            .buttonStyle(.workspaceLink).disabled(store.busy || store.isWorking)
                    }
                }
                if let update { Text(update.caption).font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
            }
            if state.offersPublish {
                if state.open == nil {
                    TextField(state.followUp ? "Follow-up pull request title" : "Pull request title", text: Binding(get: { title }, set: { editedTitle = $0 }), axis: .vertical).textFieldStyle(.plain)
                        .font(WorkspaceStyle.navigation).accessibilityLabel(state.followUp ? "Follow-up pull request title" : "Pull request title")
                    if !editingDescription && !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        MessageContent(content: description).equatable()
                        Button("Edit description") { editingDescription = true }.buttonStyle(.workspaceLink)
                    } else {
                        TextField("Pull request description", text: Binding(get: { description }, set: { editedDescription = $0 }), axis: .vertical).textFieldStyle(.plain)
                            .lineLimit(4...16).font(WorkspaceStyle.navigation).accessibilityLabel("Pull request description")
                    }
                }
                if state.open != nil, !state.changed {
                    Button("Update pull request") { publish(state) }.buttonStyle(.workspaceLink).disabled(true)
                } else {
                    Button(state.action) { publish(state) }
                        .buttonStyle(.workspacePrimary).disabled(state.unavailable || store.currentTask?.baseUpdate?.pending == true || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let reason = state.reason { Text(reason).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme)) }
            if let error = store.error { Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme)) }
        }.padding(14).modifier(ReviewPanel(emphasized: state.changed))
            .task(id: store.selectedTaskId) {
                editedTitle = nil
                editedDescription = nil
                editingDescription = false
            }
    }
    private func publish(_ state: TaskPublishState) {
        Task { if let result = await store.publishTask(title: title, description: description, checkpointId: state.checkpoint?.id) { open(result) } }
    }
}
