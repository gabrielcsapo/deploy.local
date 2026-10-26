import SwiftUI
import DeployCore

/// A live pull request or issue inside the conversation, so routine review needs no trip to the project view.
/// It reads and acts through the same `ProjectReviewModel` as the dedicated view; Open goes there for depth.
struct ConversationReviewCard: View {
    let item: ProjectWorkItem
    var workers: [Worker] = []
    let open: () -> Void
    var openTask: ((String) -> Void)? = nil
    @State private var model: ProjectReviewModel
    @State private var confirmMerge = false
    @Environment(\.colorScheme) private var scheme

    init(item: ProjectWorkItem, projectId: String, connection: Connection, workers: [Worker] = [],
         open: @escaping () -> Void, openTask: ((String) -> Void)? = nil) {
        self.item = item
        self.workers = workers
        self.open = open
        self.openTask = openTask
        _model = State(initialValue: ProjectReviewModel(projectId: projectId, connection: connection,
                                                        section: item.sourceBranch == nil ? "issues" : "pulls", selected: item.id))
    }

    private var isPull: Bool { item.sourceBranch != nil }
    private var record: ProjectWorkItem { model.record ?? item }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(14)
            Divider().opacity(0.6)
            if isPull { pullBody } else { issueBody }
            if let error = model.error {
                Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme))
                    .padding(.horizontal, 14).padding(.bottom, 12)
            }
        }
        // Cards share the composer's reading column, so conversation and actions line up.
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(ReviewPanel())
        .task(id: item.id) {
            while !Task.isCancelled {
                await model.refresh()
                // Conversation cards follow fast changes only while something is in motion.
                try? await Task.sleep(for: model.pollInterval == .seconds(2.5) ? .seconds(6) : model.pollInterval)
            }
        }
        .confirmationDialog("Merge \(record.sourceBranch ?? "") into \(record.targetBranch ?? "")?", isPresented: $confirmMerge, titleVisibility: .visible) {
            Button("Merge") { Task { await model.merge() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            let head = model.comparison.map { String($0.headCommit.prefix(7)) } ?? "the source head"
            let target = record.targetBranch ?? "The target"
            Text(model.mergeability == .mergeCommit
                ? "\(target) gains a merge commit bringing in \(head). If deploy.yaml defines a push pipeline, it starts right after."
                : "\(target) fast-forwards to \(head). If deploy.yaml defines a push pipeline, it starts right after.")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(isPull ? "Pull request" : "Issue") \(item.number ?? 0)")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            WorkspaceGlyph(name: isPull ? .pullRequest : .circle, size: 20)
                .foregroundStyle(WorkspaceStyle.tone(stateTone, scheme)).padding(.top, 1)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if let number = record.number {
                        Text("#\(number)").font(.system(.subheadline, design: .monospaced, weight: .medium))
                            .foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    }
                    Text(record.displayTitle).font(WorkspaceStyle.navigation.weight(.semibold)).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    ReviewStateBadge(label: stateLabel, tone: stateTone)
                    if let source = record.sourceBranch, let target = record.targetBranch {
                        Text("\(source) → \(target)").font(.system(.caption, design: .monospaced))
                            .foregroundStyle(WorkspaceStyle.secondaryText(scheme)).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            Spacer(minLength: 8)
            WorkspaceIconButton(label: "Open \(isPull ? "pull request" : "issue") \(record.number ?? 0)", icon: .jump, action: open)
        }
    }

    private var stateLabel: String {
        if isPull { return model.phase?.label ?? pullPhase(record: record, operation: nil).label }
        return record.status == "open" ? "Open" : "Closed"
    }
    private var stateTone: String {
        if isPull { return model.phase?.tone ?? pullPhase(record: record, operation: nil).tone }
        return record.status == "open" ? "attention" : "inactive"
    }

    // MARK: Pull request

    @ViewBuilder private var pullBody: some View {
        // Until the record loads, show where it stands without offering actions it may not support.
        if model.phase == nil {
            line(status: "running", text: "Loading pull request…").padding(14)
        } else { pullState }
    }

    @ViewBuilder private var pullState: some View {
        switch model.phase ?? .open {
        case .merged:
            VStack(alignment: .leading, spacing: 10) {
                line(status: "succeeded", text: "Merged into \(record.targetBranch ?? "target")" + (record.mergedCommit.map { " at \($0.prefix(7))" } ?? ""))
                if let result = model.mergeResult {
                    line(status: result.status, text: "Push pipeline " + pipelineLabel(result.status).lowercased())
                    if let deployment = result.deployment {
                        line(status: deployment.status, text: "Deploy \(deployment.application) · " + (deployment.status == "succeeded" ? "Running" : pipelineLabel(deployment.status)))
                    }
                }
            }.padding(14)
        case .merging:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Merging into \(record.targetBranch ?? "target")…").font(WorkspaceStyle.navigation)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
        case .closed:
            line(status: "closed", text: "Closed without merging").padding(14)
        default:
            VStack(alignment: .leading, spacing: 10) {
                line(status: checkStatus, text: model.startingChecks ? "Starting checks…" : model.checkResult.label + computersText)
                line(status: model.mergeability.canMerge ? "succeeded"
                        : model.mergeability == .noChanges || model.mergeability == .unknown ? "none" : "attention",
                     text: model.mergeability.canMerge ? "Ready to merge" : model.mergeability.label)
                HStack(spacing: 8) {
                    Button("Run checks") { Task { await model.runChecks() } }
                        .buttonStyle(.workspaceSecondary)
                        .disabled(model.busy || model.startingChecks || checkStatus == "running" || model.mergeability == .noChanges)
                    Button { confirmMerge = true } label: { Label("Merge", systemImage: "arrow.triangle.merge") }
                        .buttonStyle(.workspacePrimary)
                        .disabled(model.busy || !model.mergeability.canMerge || checkStatus == "running")
                }.frame(maxWidth: .infinity, alignment: .trailing)
            }.padding(14)
        }
    }

    private var checkStatus: String {
        switch model.checkResult {
        case .passed: "succeeded"
        case .failed: "failed"
        case .running: "running"
        default: "none"
        }
    }
    private var computersText: String {
        guard let newest = model.checks.first, let jobs = model.jobs[newest.id], !jobs.isEmpty else { return "" }
        let names = Set(jobs.compactMap(\.workerId)).map { id in workers.first { $0.id == id }?.name ?? id }.sorted()
        return names.isEmpty ? "" : " · " + names.joined(separator: ", ")
    }

    // MARK: Issue

    private var issueBody: some View {
        let tasks = record.taskIds ?? []
        return HStack(spacing: 10) {
            Text(tasks.isEmpty ? "No task yet" : "\(tasks.count) linked \(tasks.count == 1 ? "task" : "tasks")")
                .font(WorkspaceStyle.navigation).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
            if record.status == "open" {
                Button("Start task") { Task { if let id = await model.startTask() { openTask?(id) } } }
                    .buttonStyle(.workspaceSecondary).disabled(model.busy)
            }
        }.padding(14)
    }

    private func line(status: String, text: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Group {
                if ["running", "queued", "waiting", "publishing"].contains(status) {
                    ProgressView().controlSize(.mini)
                } else if status == "attention" {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(WorkspaceStyle.statusAttention(scheme))
                } else {
                    let tone = pipelineTone(status)
                    Image(systemName: tone == "healthy" ? "checkmark.circle.fill" : tone == "failed" ? "xmark.circle.fill" : "circle")
                        .foregroundStyle(WorkspaceStyle.tone(tone, scheme))
                }
            }
            .frame(width: WorkspaceStyle.iconWidth, height: WorkspaceStyle.iconWidth)
            .accessibilityHidden(true)
            Text(text).font(WorkspaceStyle.navigation).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The task's pull request, pinned just above the composer and expandable into its live card.
struct ConversationReviewStrip: View {
    let pull: ProjectWorkItem
    let projectId: String
    let connection: Connection
    var workers: [Worker] = []
    let open: () -> Void
    @State private var expanded = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if expanded {
                ConversationReviewCard(item: pull, projectId: projectId, connection: connection, workers: workers, open: open)
                    .transition(.opacity)
            }
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    WorkspaceGlyph(name: .pullRequest, size: 16).foregroundStyle(WorkspaceStyle.accent(scheme))
                    Text("#\(pull.number ?? 0) \(pull.displayTitle)").lineLimit(1).foregroundStyle(WorkspaceStyle.text(scheme))
                    let phase = pullPhase(record: pull, operation: nil)
                    ReviewStateBadge(label: phase.label, tone: phase.tone)
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.down" : "chevron.up").font(.caption.weight(.semibold))
                        .foregroundStyle(WorkspaceStyle.tertiary(scheme)).accessibilityHidden(true)
                }
                .font(WorkspaceStyle.metadata.weight(.medium))
                .padding(.horizontal, 12).frame(minHeight: WorkspaceStyle.buttonHeight)
                .background(WorkspaceStyle.surface(scheme), in: Capsule())
                .overlay(Capsule().strokeBorder(WorkspaceStyle.line(scheme), lineWidth: 1))
                // Sits on the composer's layer, with a lighter lift than the composer itself.
                .shadow(color: .black.opacity(scheme == .dark ? 0.28 : 0.06), radius: 10, x: 0, y: 4)
                .frame(minHeight: WorkspaceStyle.controlTargetHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Pull request \(pull.number ?? 0), \(pull.displayTitle)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        }
        .animation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion), value: expanded)
    }
}

struct ConversationPullEvent: View {
    let pull: ProjectWorkItem
    let open: () -> Void
    var body: some View {
        HStack(spacing: WorkspaceStyle.space2) {
            WorkspaceGlyph(name: .pullRequest)
            Button(pull.conversationEventLabel, action: open).buttonStyle(.workspaceLink)
        }.font(WorkspaceStyle.metadata).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ConversationDeploymentEvent: View {
    let deployment: MessageDeployment
    @Environment(\.openURL) private var openURL
    var body: some View {
        HStack(spacing: WorkspaceStyle.space2) {
            WorkspaceGlyph(name: .bolt)
            Text(deployment.conversationEventLabel)
            if let value = deployment.url, let url = URL(string: value), ["https", "http"].contains(url.scheme ?? "") {
                WorkspaceIconButton(label: "Open application", icon: .external) { openURL(url) }
            }
            if let application = deployment.application,
               let encoded = application.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
               let url = URL(string: "https://deploy.local/dashboard/\(encoded)/build") {
                WorkspaceIconButton(label: "View deployment logs", icon: .terminal) { openURL(url) }
            }
        }.font(WorkspaceStyle.metadata).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
    }
}
