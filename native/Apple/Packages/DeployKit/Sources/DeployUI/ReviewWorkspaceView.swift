import SwiftUI
import DeployCore

/// Review is a work surface: changes and checks each have a readable, full-height pane.
struct ChangesView: View {
    @Bindable var store: WorkspaceStore
    var section = "Changes"
    /// The task's pull request, so reviewing changes continues into merging them.
    var openPullRequest: ((ProjectWorkItem?) -> Void)? = nil
    @Environment(\.colorScheme) private var scheme
    private var patches: [ReviewFilePatch] {
        guard let diff = store.diff else { return [] }
        return reviewFilePatches(diff.patch, files: diff.files)
    }
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
                            HStack {
                                Text(store.diff.map { "\($0.files.count) changed \($0.files.count == 1 ? "file" : "files")" } ?? "Loading changes…")
                                    .font(WorkspaceStyle.navigation.weight(.medium))
                                Spacer()
                                Button { Task { await store.loadDiff() } } label: { WorkspaceGlyph(name: .reset, size: 18) }
                                    .buttonStyle(.plain).accessibilityLabel("Refresh changes")
                            }
                            if let diff = store.diff {
                                ReviewDiffList(files: diff.files, patches: patches, width: geometry.size.width - 48, reader: reader,
                                               emptyMessage: "No changes in this task")
                            } else if let error = store.error {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme))
                                    Button("Retry") { Task { await store.loadDiff() } }
                                }
                            } else { ProgressView().controlSize(.small) }
                        }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }.accessibilityLabel(section == "Checks" ? "Task checks" : "Task changes")
            }
        }.task(id: store.selectedTaskId) { await store.loadDiff() }
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
            ForEach(store.detail?.jobs ?? []) { job in CheckpointJobRow(job: job) }
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
    @State private var title = ""
    @Environment(\.colorScheme) private var scheme
    private var pull: ProjectWorkItem? {
        guard let pull = store.linkedPull, ["open", "merged"].contains(pull.status) else { return nil }
        return pull
    }
    private var merged: Bool { pull?.status == "merged" || store.currentTask?.status == "merged" }
    private var changed: Bool { store.diff?.hasUnpublishedChanges == true }
    private var unavailable: Bool {
        store.busy || store.isWorking || store.diff == nil || store.diff?.truncated == true || store.diff?.excluded?.isEmpty == false ||
        store.diff?.patch.isEmpty != false || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        (store.currentTask?.workspaceStatus != nil && store.currentTask?.workspaceStatus != "ready")
    }
    private var reason: String? {
        if store.diff == nil { return "Loading changes…" }
        if store.isWorking { return "Wait for the active run or check to finish." }
        if store.diff?.truncated == true || store.diff?.excluded?.isEmpty == false { return "The diff is incomplete. Refresh changes and resolve excluded files before publishing." }
        if store.diff?.patch.isEmpty == true { return store.diff?.status.isEmpty == false ? store.diff?.status : "No changes to publish." }
        if pull != nil && !changed { return store.diff?.hasUnpublishedChanges == false ? "No unpublished changes." : "Refresh changes to compare with the pull request." }
        return nil
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if merged && pull == nil { Text("Merged").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.success(scheme)) }
            if let pull {
                Button("#\(pull.number ?? 0) \(pull.displayTitle)") { open(pull) }.buttonStyle(.workspaceLink)
                HStack {
                    let phase = pullPhase(record: pull, operation: nil)
                    ReviewStateBadge(label: phase.label, tone: phase.tone)
                    Text("\(pull.sourceBranch ?? "") → \(pull.targetBranch ?? "")").font(WorkspaceStyle.metadata.monospaced())
                }
            } else if let task = store.currentTask {
                Text("task/\(task.id.replacingOccurrences(of: "-", with: "").prefix(8))").font(WorkspaceStyle.metadata.monospaced())
            }
            if !merged {
                if pull == nil {
                    TextField("Pull request title", text: $title, axis: .vertical).textFieldStyle(.plain)
                        .font(WorkspaceStyle.navigation).accessibilityLabel("Pull request title")
                }
                if pull?.status == "open", !changed {
                    Button("Update pull request") { publish() }.buttonStyle(.workspaceLink).disabled(unavailable || !changed)
                } else {
                    Button(pull?.status == "open" ? "Update pull request" : "Publish as pull request") { publish() }
                        .buttonStyle(.workspacePrimary).disabled(unavailable)
                }
            }
            if !merged, let reason { Text(reason).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme)) }
            if let error = store.error { Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme)) }
        }.padding(14).modifier(ReviewPanel(emphasized: changed))
            .task(id: store.selectedTaskId) { title = taskTitle(pull?.title ?? store.currentTask?.title ?? "") }
    }
    private func publish() {
        Task { if let result = await store.publishTask(title: title) { open(result) } }
    }
}
