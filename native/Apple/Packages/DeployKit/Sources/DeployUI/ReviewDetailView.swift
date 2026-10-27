import SwiftUI
import DeployCore

/// Number, state, title and context shared by issues and pull requests.
struct ReviewRecordHeader: View {
    let record: ProjectWorkItem
    let stateLabel: String
    let tone: String
    let glyph: WorkspaceGlyphName
    var back: (() -> Void)? = nil
    var backTitle = ""
    var edit: (() -> Void)? = nil
    var toggleOpen: (() -> Void)? = nil
    /// On a pushed iPhone screen the number, state and More menu live in the navigation bar.
    var chromeInNavigationBar = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !chromeInNavigationBar { identityRow }
            Text(record.displayTitle).font(.title2.weight(.semibold)).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { context }
                VStack(alignment: .leading, spacing: 6) { context }
            }
        }
        #if os(iOS)
        .toolbar {
            if chromeInNavigationBar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 8) { number; ReviewStateBadge(label: stateLabel, tone: tone, glyph: glyph) }
                }
                if edit != nil || toggleOpen != nil { ToolbarItem(placement: .topBarTrailing) { moreMenu } }
            }
        }
        #endif
    }

    @ViewBuilder private var number: some View {
        if let number = record.number {
            Text("#\(number)").font(.system(.subheadline, design: .monospaced, weight: .medium))
                .foregroundStyle(WorkspaceStyle.secondaryText(scheme))
        }
    }

    private var moreMenu: some View {
        Menu {
            if let edit { Button("Edit title and description", action: edit) }
            if let toggleOpen { Button(record.status == "open" ? "Close" : "Reopen", action: toggleOpen) }
        } label: {
            WorkspaceGlyph(name: .more, size: WorkspaceStyle.IconAction.standardGlyph)
                .frame(width: WorkspaceStyle.Toolbar.targetSize, height: WorkspaceStyle.Toolbar.targetSize)
                .contentShape(Rectangle())
        }
        .menuIndicator(.hidden).buttonStyle(WorkspaceToolbarButtonStyle()).fixedSize().help("More actions")
        .foregroundStyle(WorkspaceStyle.secondaryText(scheme))
        .accessibilityLabel("More actions")
    }

    private var identityRow: some View {
            HStack(spacing: 8) {
                if let back {
                    WorkspaceIconButton(label: backTitle, icon: .back, shortcut: "Esc", action: back).keyboardShortcut(.cancelAction)
                    Text("/").foregroundStyle(WorkspaceStyle.tertiary(scheme)).font(WorkspaceStyle.navigation)
                }
                number
                ReviewStateBadge(label: stateLabel, tone: tone, glyph: glyph)
                Spacer(minLength: 0)
                if edit != nil || toggleOpen != nil { moreMenu }
            }
    }

    @ViewBuilder private var context: some View {
        if let source = record.sourceBranch, let target = record.targetBranch {
            HStack(spacing: 6) {
                BranchToken(name: source)
                Image(systemName: "arrow.right").font(.caption.weight(.semibold)).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    .accessibilityLabel("into")
                BranchToken(name: target)
            }.fixedSize()
        }
        HStack(spacing: 4) {
            Text(record.author ?? "Someone")
            Text(record.status == "merged" ? "merged" : "opened")
            if let date = workspaceDate(record.status == "merged" ? record.mergedAt : record.createdAt) { ReviewRelativeTime(date: date) }
        }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme)).lineLimit(1)
    }
}

/// Task → changes → checks → merge → resulting pipeline, in one place.
struct PullRequestDetailView: View {
    @Bindable var model: ProjectReviewModel
    var tasks: [WorkspaceTask] = []
    var workers: [Worker] = []
    var showsBack = true
    var chromeInNavigationBar = false
    let openTask: (String) -> Void
    let openPipeline: (String) -> Void
    let edit: () -> Void
    @State private var tab = "Overview"
    @State private var confirmMerge = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { reader in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let record = model.record, let phase = model.phase {
                            ReviewRecordHeader(record: record, stateLabel: phase.label, tone: phase.tone, glyph: .pullRequest,
                                               back: showsBack ? { model.select("") } : nil, backTitle: "Pull requests",
                                               edit: record.status == "merged" ? nil : edit,
                                               toggleOpen: record.status == "merged" || phase == .merging ? nil : { Task { await model.setOpen(record.status != "open") } },
                                               chromeInNavigationBar: chromeInNavigationBar)
                            Picker("Pull request section", selection: $tab) {
                                Text("Overview").tag("Overview")
                                Text(phase == .merging ? "Changes" : model.comparison.map { "Changes \(changedFiles(fromPatch: $0.patch).count)" } ?? "Changes").tag("Changes")
                                Text(model.checks.isEmpty ? "Checks" : "Checks \(model.checks.count)").tag("Checks")
                            }.pickerStyle(.segmented).labelsHidden().fixedSize()
                            if let error = model.error { errorRow(error) }
                            switch tab {
                            case "Changes": changes(width: min(geometry.size.width, WorkspaceStyle.contentWidth) - 48, reader: reader)
                            case "Checks": checks
                            default: overview(record, phase)
                            }
                        } else if let error = model.error { errorRow(error) }
                        else { WorkspaceSkeleton() }
                    }
                    .padding(24)
                    .frame(maxWidth: WorkspaceStyle.contentWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background(WorkspaceStyle.canvas(scheme))
    }

    private var mergeQuestion: String {
        guard let record = model.record else { return "Merge?" }
        return "Merge \(record.sourceBranch ?? "") into \(record.targetBranch ?? "")?"
    }
    private var mergeConsequence: String {
        let head = model.comparison.map { String($0.headCommit.prefix(7)) } ?? ""
        let target = model.record?.targetBranch ?? "The target"
        let landing = model.mergeability == .mergeCommit
            ? "\(target) gains a merge commit bringing in \(head)"
            : "\(target) fast-forwards to \(head)"
        return "\(landing). If deploy.yaml defines a push pipeline, it starts right after."
    }

    private func errorRow(_ error: String) -> some View {
        Label(error, systemImage: "exclamationmark.triangle.fill").font(WorkspaceStyle.metadata)
            .foregroundStyle(WorkspaceStyle.danger(scheme)).textSelection(.enabled)
    }

    // MARK: Overview

    @ViewBuilder private func overview(_ record: ProjectWorkItem, _ phase: PullPhase) -> some View {
        mergePanel(record, phase)
        if let taskIds = record.taskIds, !taskIds.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ReviewSectionHeading(title: "From task")
                ForEach(taskIds, id: \.self) { id in
                    LinkedTaskRow(task: tasks.first { $0.id == id }, id: id) { openTask(id) }
                }
            }
        }
        if !model.commits.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ReviewSectionHeading(title: "Commits", detail: "\(model.commits.count)")
                ForEach(model.commits.prefix(20)) { commit in CommitRow(commit: commit) }
            }
        }
        ReviewTimeline(description: record.body, author: record.author, createdAt: record.createdAt,
                       comments: model.comments, busy: model.busy) { await model.comment($0) }
    }

    @ViewBuilder private func mergePanel(_ record: ProjectWorkItem, _ phase: PullPhase) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            switch phase {
            case .merged:
                mergedSummary(record)
            case .merging:
                readinessRow(icon: AnyView(ProgressView().controlSize(.small)), title: "Merging \(record.sourceBranch ?? "") into \(record.targetBranch ?? "")…",
                             detail: "The coordinator is updating \(record.targetBranch ?? "the target branch").")
            case .closed:
                readinessRow(icon: AnyView(ReviewStatusGlyph(status: "closed")), title: "Closed without merging", detail: "Reopen it to run checks and merge.")
                Divider().opacity(0.6)
                HStack { Spacer(); Button("Reopen pull request") { Task { await model.setOpen(true) } }.buttonStyle(.workspaceSecondary).disabled(model.busy) }.padding(12)
            case .open, .mergeFailed, .needsRecovery:
                checksRow
                Divider().opacity(0.6).padding(.leading, 44)
                mergeabilityRow(record)
                if let update = model.baseUpdate { Text(update.caption).font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
                if case .mergeFailed(let message) = phase {
                    Divider().opacity(0.6).padding(.leading, 44)
                    readinessRow(icon: AnyView(ReviewStatusGlyph(status: "failed")), title: "The last merge attempt failed", detail: message)
                }
                if case .needsRecovery(let message) = phase {
                    Divider().opacity(0.6).padding(.leading, 44)
                    readinessRow(icon: AnyView(ReviewStatusGlyph(status: "failed")), title: "Merge needs recovery", detail: message)
                }
                Divider().opacity(0.6)
                mergeActions(record, phase)
            }
        }.modifier(ReviewPanel(emphasized: phase == .open && model.mergeability.canMerge))
    }

    private var checksRow: some View {
        let summary = model.checkResult
        let newest = model.checks.first
        let computers = Set((newest.flatMap { model.jobs[$0.id] } ?? []).compactMap(\.workerId))
            .map { id in workers.first { $0.id == id }?.name ?? id }.sorted()
        let earlier = checkRuns(runs: model.checks, headCommit: model.comparison?.headCommit).earlier.count
        let detail: String = switch summary {
        case .none: "No pipeline has run for this pull request."
        case .outdated: "\(earlier) earlier \(earlier == 1 ? "run" : "runs") checked other commits. Run checks again for the latest commit."
        case .running: computers.isEmpty ? "Waiting for a computer." : "Running on \(computers.joined(separator: ", "))."
        // Nothing failed, but a run whose output was piped did not say how it ended, so this
        // version has no result. The check below names it.
        case .unknown: "\(unknownResultMessage) for at least one run. Run it unpiped, or with set -o pipefail."
        case .passed, .failed: computers.isEmpty ? "Latest commit \(String(model.comparison?.headCommit.prefix(7) ?? ""))." : "Ran on \(computers.joined(separator: ", "))."
        }
        // Retries of the same commit are attempts at one check; only the latest one is the result.
        let attempts = summary.earlierAttempts.map { " \($0) on this commit." } ?? ""
        return HStack(spacing: 10) {
            readinessRow(icon: AnyView(summaryGlyph(summary)), title: model.startingChecks ? "Starting checks…" : summary.label, detail: detail + attempts)
            if summary != .none { Button("Details") { tab = "Checks" }.buttonStyle(.workspaceQuiet) }
        }.padding(.trailing, 8)
    }

    private func summaryGlyph(_ summary: ReviewCheckSummary) -> some View {
        Group {
            if case .running = summary { ProgressView().controlSize(.small) }
            else if model.startingChecks { ProgressView().controlSize(.small) }
            else { ReviewStatusGlyph(status: summary.tone == "healthy" ? "succeeded" : summary.tone == "failed" ? "failed" : "none") }
        }
    }

    private func mergeabilityRow(_ record: ProjectWorkItem) -> some View {
        let source = record.sourceBranch ?? "the source", target = record.targetBranch ?? "the target"
        let state = model.mergeability
        let detail: String = switch state {
        case .ready: "\(target) can fast-forward to \(String(model.comparison?.headCommit.prefix(7) ?? ""))."
        case .mergeCommit: "\(target) has moved since \(source) branched, and the changes do not collide. Merging adds a merge commit."
        case .conflicted(let files):
            "\(target) has moved and \(source) conflicts with it in \(files.prefix(5).joined(separator: ", "))"
                + (files.count > 5 ? " and \(files.count - 5) more." : ".")
                + " Ask the task to merge \(target) into its branch and resolve them."
        case .blocked(let reason): reason
        case .diverged: "\(target) has moved since \(source) branched. Ask the task to merge \(target) into its branch, then come back."
        case .noChanges: "\(source) has no commits that \(target) doesn’t already have."
        case .unknown: "Comparing \(source) with \(target)…"
        }
        let status = state.canMerge ? "succeeded" : state == .noChanges || state == .unknown ? "none" : "attention"
        return readinessRow(icon: AnyView(state == .unknown ? AnyView(ProgressView().controlSize(.small)) : AnyView(statusIcon(status))),
                            title: state.canMerge ? "Ready to merge" : state.label, detail: detail)
    }

    private func statusIcon(_ status: String) -> some View {
        Image(systemName: status == "succeeded" ? "checkmark.circle.fill" : status == "attention" ? "exclamationmark.circle.fill" : "minus.circle")
            .font(.system(.body, weight: .medium))
            .foregroundStyle(WorkspaceStyle.tone(status == "succeeded" ? "healthy" : status == "attention" ? "attention" : "inactive", scheme))
            .frame(width: WorkspaceStyle.iconWidth).accessibilityHidden(true)
    }

    private func readinessRow(icon: AnyView, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            icon.frame(width: 20, height: 20).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(WorkspaceStyle.navigation.weight(.semibold)).foregroundStyle(WorkspaceStyle.text(scheme))
                Text(detail).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }.padding(.horizontal, 14).padding(.vertical, 12).accessibilityElement(children: .combine)
    }

    private func mergeActions(_ record: ProjectWorkItem, _ phase: PullPhase) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { mergeButtons(record, phase, expands: false) }
            VStack(spacing: 10) { mergeButtons(record, phase, expands: true) }
        }.padding(12)
    }

    @ViewBuilder private func mergeButtons(_ record: ProjectWorkItem, _ phase: PullPhase, expands: Bool) -> some View {
        if !expands { Spacer(minLength: 0) }
        if model.baseUpdate?.needsPublication == true, let taskId = record.taskIds?.first {
            Button("Update pull request") { openTask(taskId) }
                .buttonStyle(WorkspaceButtonStyle(variant: .primary, expands: expands)).disabled(model.busy)
        }
        if model.comparison?.fastForward == false, record.taskIds?.isEmpty == false {
            Button(model.baseUpdate?.pending == true ? "Continue update" : "Update from main") { Task { await model.updateFromMain(action: model.baseUpdate?.pending == true ? "continue" : "update") } }
                .buttonStyle(WorkspaceButtonStyle(variant: .secondary, expands: expands)).disabled(model.busy)
        }
        if model.baseUpdate?.pending == true {
            Button("Abort update") { Task { await model.updateFromMain(action: "abort") } }
                .buttonStyle(WorkspaceButtonStyle(variant: .secondary, expands: expands)).disabled(model.busy)
        }
        if case .needsRecovery = phase {
            Button("Recover merge") { Task { await model.retryMerge() } }
                .buttonStyle(WorkspaceButtonStyle(variant: .primary, expands: expands)).disabled(model.busy)
        } else {
            Button(model.startingChecks ? "Starting…" : "Run checks") { Task { await model.runChecks() } }
                .buttonStyle(WorkspaceButtonStyle(variant: .secondary, expands: expands))
                .disabled(model.busy || model.startingChecks || isRunning(model.checkResult) || model.mergeability == .noChanges)
            Button {
                confirmMerge = true
            } label: {
                Label("Merge into \(record.targetBranch ?? "target")", systemImage: "arrow.triangle.merge")
            }
            .buttonStyle(WorkspaceButtonStyle(variant: .primary, expands: expands))
            .disabled(model.busy || !model.mergeability.canMerge || isRunning(model.checkResult))
            .accessibilityHint(model.mergeability.canMerge ? "Asks for confirmation" : model.mergeability.label)
            // Attached to the button so the iPhone popover points at it.
            .confirmationDialog(mergeQuestion, isPresented: $confirmMerge, titleVisibility: .visible) {
                Button("Merge") { Task { await model.merge() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text(mergeConsequence) }
        }
    }

    private func isRunning(_ summary: ReviewCheckSummary) -> Bool { if case .running = summary { return true }; return false }

    /// A check reads as what it checked: its recorded headline, never the shell plumbing or the
    /// worker directory the command started in. The command itself stays on the row below.
    private func runTitle(_ run: ProjectWorkItem) -> String {
        checkDisplayLabel(run) ?? (run.trigger == "manual" ? "Checks, started manually" : "Pull request checks")
    }

    @ViewBuilder private func mergedSummary(_ record: ProjectWorkItem) -> some View {
        readinessRow(icon: AnyView(ReviewStatusGlyph(status: "merged")),
                     title: "Merged into \(record.targetBranch ?? "the target branch")",
                     detail: record.mergedCommit.map { "\(record.targetBranch ?? "Target") is now at \($0.prefix(7))." } ?? "Merged.")
        Divider().opacity(0.6)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Then").font(WorkspaceStyle.metadata.weight(.semibold)).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                Spacer()
                if let result = model.mergeResult {
                    Button("View pipeline") { openPipeline(result.id) }.buttonStyle(.workspaceQuiet)
                }
            }
            if let result = model.mergeResult {
                PipelineRunView(run: result, jobs: model.jobs[result.id] ?? [], workers: workers, title: "Push pipeline on \(record.targetBranch ?? "target")")
            } else {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Looking for the pipeline this merge started…").font(WorkspaceStyle.metadata)
                        .foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                }
                Text("Nothing appears here when deploy.yaml has no push pipeline.").font(WorkspaceStyle.metadata)
                    .foregroundStyle(WorkspaceStyle.tertiary(scheme))
            }
        }.padding(14)
    }

    // MARK: Changes and checks

    @ViewBuilder private func changes(width: CGFloat, reader: ScrollViewProxy) -> some View {
        if let comparison = model.comparison {
            let files = changedFiles(fromPatch: comparison.patch)
            ReviewDiffList(files: files, patches: reviewFilePatches(comparison.patch, files: files), width: width, reader: reader,
                           emptyMessage: "No changes between these branches")
        } else { ProgressView().controlSize(.small) }
    }

    @ViewBuilder private var checks: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(model.checkResult.label).font(WorkspaceStyle.navigation.weight(.semibold))
            Spacer()
            if model.record?.status == "open" {
                Button(model.startingChecks ? "Starting…" : "Run checks") { Task { await model.runChecks() } }
                    .buttonStyle(.workspaceSecondary).disabled(model.busy || model.startingChecks || isRunning(model.checkResult))
            }
        }
        if model.checks.isEmpty {
            Text("Checks run the pipeline from deploy.yaml against this branch on the computers it names.")
                .font(WorkspaceStyle.navigation).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
        }
        // The runs on the commit this pull request would merge, and nothing else: one entry per
        // check with its retries folded under it. Anything older is history below.
        // Until the comparison says which commit is the head, no run can be placed against it.
        let runs = checkRuns(runs: model.checks, headCommit: model.comparison?.headCommit)
        if runs.current.isEmpty, !model.checks.isEmpty {
            Text("\(noHeadChecksMessage). Run checks again for the latest commit.")
                .font(WorkspaceStyle.navigation).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
        }
        ForEach(runs.current) { group in
            PipelineRunView(run: group.latest, jobs: model.jobs[group.latest.id] ?? [], workers: workers,
                            title: runTitle(group.latest), isCurrent: true)
            if let earlier = group.earlierLabel {
                DisclosureGroup(earlier) {
                    ForEach(group.earlier) { run in
                        PipelineRunView(run: run, jobs: model.jobs[run.id] ?? [], workers: workers,
                                        title: runTitle(run), isCurrent: false)
                    }
                }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            }
            Divider().opacity(0.5)
        }
        // Earlier runs keep their results, so a reviewer can see what was tried, but they never
        // speak for the version under review.
        if !runs.earlier.isEmpty {
            DisclosureGroup(earlierRunsLabel(runs.earlier.count)) {
                ForEach(runs.earlier) { run in
                    PipelineRunView(run: run, jobs: model.jobs[run.id] ?? [], workers: workers,
                                    title: runTitle(run), isCurrent: false)
                }
            }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
        }
    }
}

/// Issues share the pull request's header, panel and activity layout.
struct IssueDetailView: View {
    @Bindable var model: ProjectReviewModel
    var tasks: [WorkspaceTask] = []
    var showsBack = true
    var chromeInNavigationBar = false
    let openTask: (String) -> Void
    let edit: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let record = model.record {
                    ReviewRecordHeader(record: record, stateLabel: record.status == "open" ? "Open" : "Closed",
                                       tone: record.status == "open" ? "attention" : "inactive", glyph: .circle,
                                       back: showsBack ? { model.select("") } : nil, backTitle: "Issues",
                                       edit: edit, toggleOpen: { Task { await model.setOpen(record.status != "open") } },
                                       chromeInNavigationBar: chromeInNavigationBar)
                    if let error = model.error {
                        Label(error, systemImage: "exclamationmark.triangle.fill").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme))
                    }
                    workPanel(record)
                    ReviewTimeline(description: record.body, author: record.author, createdAt: record.createdAt,
                                   comments: model.comments, busy: model.busy) { await model.comment($0) }
                } else if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme))
                } else { WorkspaceSkeleton() }
            }
            .padding(24)
            .frame(maxWidth: WorkspaceStyle.contentWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }.background(WorkspaceStyle.canvas(scheme))
    }

    private func workPanel(_ record: ProjectWorkItem) -> some View {
        let linked = record.taskIds ?? []
        return VStack(alignment: .leading, spacing: 0) {
            if linked.isEmpty {
                HStack(alignment: .top, spacing: 12) {
                    WorkspaceGlyph(name: .chat, size: 20).foregroundStyle(WorkspaceStyle.accent(scheme))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(record.status == "open" ? "No task yet" : "Closed").font(WorkspaceStyle.navigation.weight(.semibold))
                        Text(record.status == "open" ? "Start a coding task from this issue. Its changes can become a pull request."
                             : "Reopen the issue to start work on it.")
                            .font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    }
                    Spacer(minLength: 0)
                }.padding(14)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Tasks").font(WorkspaceStyle.metadata.weight(.semibold)).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    ForEach(linked, id: \.self) { id in LinkedTaskRow(task: tasks.first { $0.id == id }, id: id) { openTask(id) } }
                }.padding(14)
            }
            if record.status == "open" {
                Divider().opacity(0.6)
                HStack {
                    Spacer()
                    Button {
                        Task { if let id = await model.startTask() { openTask(id) } }
                    } label: { Label(linked.isEmpty ? "Start task" : "Start another task", systemImage: "play.fill") }
                        .buttonStyle(linked.isEmpty ? .workspacePrimary : .workspaceSecondary)
                        .disabled(model.busy)
                }.padding(12)
            }
        }.modifier(ReviewPanel(emphasized: record.status == "open" && linked.isEmpty))
    }
}

/// Pipeline runs use the same run presentation as pull request checks and merge results.
struct PipelineDetailView: View {
    @Bindable var model: ProjectReviewModel
    var workers: [Worker] = []
    var showsBack = true
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let run = model.record {
                    HStack(spacing: 8) {
                        if showsBack {
                            WorkspaceIconButton(label: "Back to pipelines", icon: .back, shortcut: "Esc") { model.select("") }.keyboardShortcut(.cancelAction)
                        }
                        Spacer()
                        if !["succeeded", "failed", "cancelled", "skipped", "timed_out"].contains(run.status) {
                            Button("Cancel run") { Task { await model.cancelPipeline() } }.buttonStyle(.workspaceDanger).disabled(model.busy)
                        }
                    }
                    PipelineRunView(run: run, jobs: model.detail?.jobs ?? [], workers: workers)
                        .padding(14).modifier(ReviewPanel())
                } else { WorkspaceSkeleton() }
            }
            .padding(24)
            .frame(maxWidth: WorkspaceStyle.contentWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }.background(WorkspaceStyle.canvas(scheme))
    }
}
