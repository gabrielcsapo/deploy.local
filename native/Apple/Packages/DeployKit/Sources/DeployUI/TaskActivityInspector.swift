import SwiftUI
import DeployCore

struct ActivitySelection: Equatable { var runId: String?; var check: String?; var sources = false; var request = UUID() }
struct TaskActivitySummaryButton: View {
    let summary: TaskActivitySummary
    let open: () -> Void
    var selected = false
    var compact = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if summary.isVisible {
            Button(action: open) {
                HStack(spacing: 8) {
                    if compact && summary.runningCount > 0 { Label("\(summary.runningCount) running", systemImage: "circle.lefthalf.filled") }
                    if compact && summary.failingCount > 0 { Label("\(summary.failingCount) failing", systemImage: "xmark") }
                    if compact && summary.runningCount == 0 && summary.failingCount == 0 && summary.passedCount == summary.checkCount && summary.checkCount > 0 { Label("\(summary.passedCount) check\(summary.passedCount == 1 ? "" : "s") passed", systemImage: "checkmark") }
                    else if !compact || (summary.runningCount == 0 && summary.failingCount == 0) { Text(summary.text) }
                }.font(WorkspaceStyle.metadata).foregroundStyle(summary.failingCount > 0 ? WorkspaceStyle.danger(scheme) : WorkspaceStyle.secondaryText(scheme))
                    .frame(minHeight: WorkspaceStyle.controlSize, alignment: .leading)
            }.buttonStyle(.workspaceLink).background(selected ? WorkspaceStyle.selected(scheme) : .clear)
                .accessibilityLabel(summary.label).accessibilityValue(selected ? "Activity open" : "")
                .accessibilityIdentifier("task-activity-summary")
        }
    }
}
struct TaskActivityInspector: View {
    let detail: TaskDetail?
    let workers: [Worker]
    let cancel: (WorkspaceJob) -> Void
    var showConversation: ((String) -> Void)? = nil
    var selection: ActivitySelection? = nil
    @State private var scope: ActivitySelection?
    @State private var filter = "Latest"
    private var jobs: [WorkspaceJob] { detail?.jobs ?? [] }
    private var selected: [WorkspaceJob] { jobs.filter { (scope?.runId == nil || ($0.runId ?? "") == scope?.runId) && (scope?.check == nil || $0.checkIdentity == scope?.check) } }
    private var visible: [WorkspaceJob] { filter == "All attempts" ? selected : TaskActivitySummary.latestChecks(selected).map(\.latest).filter { filter != "Failed" || $0.isFailed } }
    private var nowJobs: [WorkspaceJob] { scope != nil || filter == "Failed" ? [] : TaskActivitySummary.orderedJobs(selected.filter(\.isActive)) }
    private var attentionJobs: [WorkspaceJob] { scope != nil ? [] : TaskActivitySummary.latestChecks(visible).map(\.latest).filter { $0.isFailed || ($0.status == "queued" && $0.waitingReason != nil) } }
    private var pinned: Set<String> { Set((nowJobs + attentionJobs).map(\.id)) }
    var body: some View {
        ScrollViewReader { reader in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 16) {
                    let summary = TaskActivitySummary(jobs: jobs, activity: [])
                    ActivityCounters(summary: summary).id("activity-top")
                    Picker("Activity filter", selection: $filter) { ForEach(["Latest", "All attempts", "Failed"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
                    if scope != nil { Button("Show all turns and checks") { scope = nil }.buttonStyle(.workspaceLink) }
                    if visible.isEmpty { Text(jobs.isEmpty ? "No jobs yet." : "No matching jobs.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
                    let active = nowJobs
                    if !active.isEmpty { Text("Now").font(.headline); ForEach(active) { row($0) } }
                    let attention = attentionJobs
                    if !attention.isEmpty { Text("Needs attention").font(.headline); ForEach(attention) { row($0) } }
                    ForEach(TaskActivitySummary.turns(visible, runs: detail?.runs ?? [], messages: detail?.messages ?? [], attempts: selected)) { turn in
                        ActivityTurnDisclosure(turn: turn, expand: scope != nil) {
                            ForEach(turn.jobs.filter { !pinned.contains($0.id) }) { row($0, number: turn.number) }
                            if turn.jobs.contains(where: { pinned.contains($0.id) }) { Button { scope = ActivitySelection(runId: turn.id) } label: { HStack { Text("Show all jobs in this turn"); WorkspaceGlyph(name: .chevron, size: WorkspaceStyle.IconAction.compactGlyph) } }.buttonStyle(.workspaceQuiet) }
                        }
                            .id("\(turn.id)-\(filter)-\(scope?.request.uuidString ?? "")")
                    }
                    TaskSourcesView(activity: detail?.activity ?? [], expanded: selection?.sources == true, roots: [detail?.task.workspacePath, detail?.task.remoteWorkspacePath].compactMap { $0 }).id("activity-sources")
                    let questions = (detail?.questions ?? []).filter { $0.status != "pending" }
                    if !questions.isEmpty {
                        Text("Questions and answers").font(.headline)
                        ForEach(questions) { question in VStack(alignment: .leading) { Text(question.question); Text(question.answer ?? question.status.capitalized).foregroundStyle(.secondary) }.font(WorkspaceStyle.metadata) }
                    }
                    if let events = detail?.events, !events.isEmpty {
                        DisclosureGroup("Raw events") {
                            let encoder = JSONEncoder()
                            let _ = encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                            if let data = try? encoder.encode(events), let text = String(data: data, encoding: .utf8) { WorkspaceCopyButton(label: "Copy JSON", text: text) }
                            ForEach(events) { event in DisclosureGroup(event.type) { Text(event.payload.prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled) } }
                        }.font(WorkspaceStyle.metadata)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(WorkspaceStyle.conversationGutter)
            }.onAppear { scope = selection; if selection?.sources == true { reader.scrollTo("activity-sources", anchor: .top) } }
                .onChange(of: selection) { _, value in scope = value; filter = "Latest"; reader.scrollTo(value?.sources == true ? "activity-sources" : "activity-top", anchor: .top) }
        }.accessibilityIdentifier("task-activity-inspector")
            #if os(iOS)
            .modifier(PhoneActivityDisclosure())
            #endif
    }
    private func row(_ job: WorkspaceJob, number: Int? = nil) -> some View {
        let runNumbers = Dictionary(uniqueKeysWithValues: (detail?.runs ?? []).sorted { $0.createdAt < $1.createdAt }.enumerated().map { ($0.element.id, $0.offset + 1) })
        return CheckpointJobRow(job: job, computerName: workers.first { $0.id == job.workerId }?.name ?? job.workerId,
                         cancel: { cancel(job) }, showConversation: showConversation, turnNumber: number ?? runNumbers[job.runId ?? ""],
                         earlier: filter == "All attempts" ? [] : TaskActivitySummary.latestChecks(jobs).first { $0.latest.id == job.id }?.earlier ?? [], runNumbers: runNumbers)
    }
}
private struct ActivityTurnDisclosure<Content: View>: View {
    let turn: ActivityTurn
    @State private var expanded: Bool
    let content: () -> Content
    init(turn: ActivityTurn, expand: Bool, @ViewBuilder content: @escaping () -> Content) { self.turn = turn; self.content = content; _expanded = State(initialValue: expand || !turn.allPassed) }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded, content: content) { Text("\(turn.title) · \(turn.jobCount) job\(turn.jobCount == 1 ? "" : "s")\(turn.allPassed ? " · all passed" : "")").font(WorkspaceStyle.metadata) }
    }
}
struct ActivityCounters: View {
    let summary: TaskActivitySummary
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 12) {
            Label("\(summary.runningCount) running", systemImage: "circle.lefthalf.filled")
            Label("\(summary.failingCount) failing", systemImage: "xmark").foregroundStyle(summary.failingCount > 0 ? WorkspaceStyle.danger(scheme) : WorkspaceStyle.secondaryText(scheme))
            Label("\(summary.passedCount) passed", systemImage: "checkmark")
        }.font(WorkspaceStyle.metadata)
    }
}
struct TaskActivityRail<Content: View>: View {
    @Binding var mode: String
    @Binding var width: Double
    let summary: TaskActivitySummary
    let content: () -> Content
    @State private var dragWidth: Double?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 0) {
            if mode == "collapsed" {
                Button { mode = "open" } label: {
                    VStack(spacing: 16) { Label("\(summary.runningCount)", systemImage: "circle.lefthalf.filled"); Label("\(summary.failingCount)", systemImage: "xmark"); Label("\(summary.passedCount)", systemImage: "checkmark") }.font(WorkspaceStyle.metadata).frame(width: 44, height: 160)
                }.buttonStyle(.workspaceLink).accessibilityLabel("Expand " + summary.label)
            } else {
                Rectangle().fill(WorkspaceStyle.line(scheme)).frame(width: 6).contentShape(Rectangle())
                    .gesture(DragGesture().onChanged { value in if dragWidth == nil { dragWidth = width }; width = min(560, max(320, (dragWidth ?? width) - value.translation.width)) }.onEnded { _ in dragWidth = nil })
                    .accessibilityLabel("Resize Activity").accessibilityValue("\(Int(width)) points")
                    .accessibilityAdjustableAction { direction in width = min(560, max(320, width + (direction == .increment ? 16 : -16))) }
                    .focusable()
                    .onKeyPress(.leftArrow) { width = min(560, width + 16); return .handled }
                    .onKeyPress(.rightArrow) { width = max(320, width - 16); return .handled }
                VStack(spacing: 0) {
                    HStack { Text("Activity").font(.headline); Spacer(); WorkspaceActionCluster { WorkspaceIconButton(label: "Collapse Activity", icon: .panelRightClose, size: .compact) { mode = "collapsed" }; WorkspaceIconButton(label: "Close Activity", icon: .close, size: .compact, shortcut: "Esc") { mode = "closed" } } }.padding(16)
                    content()
                }.frame(width: min(560, max(320, width)) - 6)
            }
        }.background(WorkspaceStyle.canvas(scheme)).accessibilityElement(children: .contain).accessibilityLabel("Activity")
            .onKeyPress(.escape) { mode = "closed"; return .handled }
    }
}
