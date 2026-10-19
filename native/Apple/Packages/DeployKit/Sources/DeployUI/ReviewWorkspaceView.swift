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
                            TaskPullRequestLink(pull: store.linkedPull, hasChanges: !(store.diff?.files.isEmpty ?? true)) { openPullRequest(store.linkedPull) }
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

/// Task review → pull request. Shows the linked pull request's real state, or offers to open one.
struct TaskPullRequestLink: View {
    let pull: ProjectWorkItem?
    let hasChanges: Bool
    let open: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if pull != nil || hasChanges {
            Button(action: open) {
                HStack(spacing: 12) {
                    WorkspaceGlyph(name: .pullRequest, size: 20).foregroundStyle(WorkspaceStyle.accent(scheme))
                    VStack(alignment: .leading, spacing: 4) {
                        if let pull {
                            Text("#\(pull.number ?? 0) \(pull.displayTitle)").font(WorkspaceStyle.navigation.weight(.semibold))
                                .foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(1)
                            HStack(spacing: 6) {
                                let phase = pullPhase(record: pull, operation: nil)
                                ReviewStateBadge(label: phase.label, tone: phase.tone)
                                if let source = pull.sourceBranch, let target = pull.targetBranch {
                                    Text("\(source) → \(target)").font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(WorkspaceStyle.secondaryText(scheme)).lineLimit(1).truncationMode(.middle)
                                }
                            }
                        } else {
                            Text("Open a pull request").font(WorkspaceStyle.navigation.weight(.semibold)).foregroundStyle(WorkspaceStyle.text(scheme))
                            Text("Review this task's branch, run checks and merge.").font(WorkspaceStyle.metadata)
                                .foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                        }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }.padding(14).contentShape(Rectangle())
            }.buttonStyle(.plain).modifier(ReviewPanel(emphasized: pull?.status == "open"))
                .accessibilityLabel(pull.map { "Pull request \($0.number ?? 0), \($0.displayTitle), \($0.status)" } ?? "Open a pull request for this task")
        }
    }
}
