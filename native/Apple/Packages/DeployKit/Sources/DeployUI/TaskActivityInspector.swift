import SwiftUI
import DeployCore

struct ActivitySelection: Equatable { var runId: String?; var check: String?; var sources = false; var request = UUID() }
struct TaskActivitySummaryButton: View {
    let summary: TaskActivitySummary
    let open: () -> Void
    var selected = false
    var compact = false
    var keyboardOpen: (() -> Void)? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if summary.isVisible {
            Button(action: open) {
                HStack(spacing: 8) {
                    if compact {
                        if summary.failingCount > 0 { Label("\(summary.failingCount) failing", systemImage: "xmark") }
                        else if summary.runningCount > 0 { Label("\(summary.runningCount) running", systemImage: "circle.lefthalf.filled") }
                        else if summary.passedCount == summary.checkCount && summary.checkCount > 0 { Label("\(summary.passedCount) check\(summary.passedCount == 1 ? "" : "s") passed", systemImage: "checkmark") }
                        else { Text(summary.text) }
                    } else { Text(summary.text) }
                }.font(WorkspaceStyle.metadata).foregroundStyle(summary.failingCount > 0 ? WorkspaceStyle.danger(scheme) : WorkspaceStyle.secondaryText(scheme))
                    .frame(minHeight: WorkspaceStyle.controlSize, alignment: .leading)
            }.buttonStyle(.workspaceLink)
                .padding(.horizontal, WorkspaceStyle.space2)
                .background(selected ? WorkspaceStyle.selected(scheme) : WorkspaceStyle.hover(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
                .accessibilityLabel(summary.label).accessibilityValue(selected ? "Activity open" : "")
                .accessibilityIdentifier("task-activity-summary")
                .onKeyPress(keys: [.return, .space]) { _ in (keyboardOpen ?? open)(); return .handled }
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
    /// Everything the body needs, derived once per render. Computed properties here used to be
    /// re-derived per row (`pinned` per job, `latestChecks` and run numbers per row), which made
    /// the inspector quadratic in the number of jobs.
    private struct Model {
        let summary: TaskActivitySummary
        let selected: [WorkspaceJob]
        let visible: [WorkspaceJob]
        let now: [WorkspaceJob]
        let attention: [WorkspaceJob]
        let pinned: Set<String>
        let turns: [ActivityTurn]
        let runNumbers: [String: Int]
        let earlier: [String: [WorkspaceJob]]
        let computerNames: [String: String]
    }
    private func makeModel() -> Model {
        let jobs = self.jobs
        let selected = jobs.filter { (scope?.runId == nil || ($0.runId ?? "") == scope?.runId) && (scope?.check == nil || $0.checkIdentity == scope?.check) }
        let visible = filter == "All attempts" ? selected : TaskActivitySummary.latestChecks(selected).map(\.latest).filter { filter != "Failed" || $0.isFailed }
        let now = scope != nil || filter == "Failed" ? [] : TaskActivitySummary.orderedJobs(selected.filter(\.isActive))
        let attention = scope != nil ? [] : TaskActivitySummary.latestChecks(visible).map(\.latest).filter { $0.isFailed || ($0.status == "queued" && $0.waitingReason != nil) }
        let runNumbers = Dictionary(uniqueKeysWithValues: (detail?.runs ?? []).sorted { $0.createdAt < $1.createdAt }.enumerated().map { ($0.element.id, $0.offset + 1) })
        let earlier = filter == "All attempts" ? [:] : Dictionary(TaskActivitySummary.latestChecks(jobs).map { ($0.latest.id, $0.earlier) }, uniquingKeysWith: { first, _ in first })
        return Model(summary: TaskActivitySummary(jobs: jobs, activity: []), selected: selected, visible: visible, now: now, attention: attention,
                     pinned: Set((now + attention).map(\.id)),
                     turns: TaskActivitySummary.turns(visible, runs: detail?.runs ?? [], messages: detail?.messages ?? [], attempts: selected),
                     runNumbers: runNumbers, earlier: earlier,
                     computerNames: Dictionary(workers.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }))
    }
    var body: some View {
        ScrollViewReader { reader in
            ScrollView(.vertical) {
                let model = makeModel()
                VStack(alignment: .leading, spacing: 16) {
                    ActivityCounters(summary: model.summary).id("activity-top")
                    Picker("Activity filter", selection: $filter) { ForEach(["Latest", "All attempts", "Failed"], id: \.self) { Text($0) } }.pickerStyle(.segmented).labelsHidden()
                    if scope != nil { Button("Show all turns and checks") { scope = nil }.buttonStyle(.workspaceLink) }
                    if detail == nil { WorkspaceSkeleton(label: "Loading activity") }
                    else if model.visible.isEmpty { Text(jobs.isEmpty ? "No jobs yet." : "No matching jobs.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
                    if !model.now.isEmpty { Text("Now").font(.headline); ForEach(model.now) { row($0, model: model) } }
                    if !model.attention.isEmpty { Text("Needs attention").font(.headline); ForEach(model.attention) { row($0, model: model) } }
                    ForEach(model.turns) { turn in
                        ActivityTurnDisclosure(turn: turn, expand: scope != nil) {
                            ForEach(turn.jobs.filter { !model.pinned.contains($0.id) }) { row($0, model: model, number: turn.number) }
                            if turn.jobs.contains(where: { model.pinned.contains($0.id) }) { Button { scope = ActivitySelection(runId: turn.id) } label: { HStack { Text("Show all jobs in this turn"); WorkspaceGlyph(name: .chevron, size: WorkspaceStyle.IconAction.compactGlyph) } }.buttonStyle(.workspaceQuiet) }
                        }
                            .id("\(turn.id)-\(filter)-\(scope?.request.uuidString ?? "")")
                    }
                    TaskSourcesView(activity: detail?.activity ?? [], expanded: selection?.sources == true, roots: [detail?.task.workspacePath, detail?.task.remoteWorkspacePath].compactMap { $0 }).id("activity-sources")
                    let questions = (detail?.questions ?? []).filter { $0.status != "pending" }
                    if !questions.isEmpty {
                        Text("Questions and answers").font(.headline)
                        ForEach(questions) { question in VStack(alignment: .leading) { Text(question.question); Text(question.answer ?? question.status.capitalized).foregroundStyle(.secondary) }.font(WorkspaceStyle.metadata) }
                    }
                    if let events = detail?.events, !events.isEmpty { RawEventsDisclosure(events: events) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(WorkspaceStyle.conversationGutter)
            }.onAppear { scope = selection; if selection?.sources == true { reader.scrollTo("activity-sources", anchor: .top) } }
                .onChange(of: selection) { _, value in scope = value; filter = "Latest"; reader.scrollTo(value?.sources == true ? "activity-sources" : "activity-top", anchor: .top) }
        }.accessibilityIdentifier("task-activity-inspector")
            #if os(iOS)
            .modifier(PhoneActivityDisclosure())
            #endif
    }
    private func row(_ job: WorkspaceJob, model: Model, number: Int? = nil) -> some View {
        CheckpointJobRow(job: job, computerName: job.workerId.flatMap { model.computerNames[$0] } ?? job.workerId,
                         cancel: { cancel(job) }, showConversation: showConversation, turnNumber: number ?? model.runNumbers[job.runId ?? ""],
                         earlier: model.earlier[job.id] ?? [], runNumbers: model.runNumbers)
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
            // Only the counts that exist, as on the web.
            if summary.runningCount > 0 { Label("\(summary.runningCount) running", systemImage: "circle.lefthalf.filled") }
            if summary.failingCount > 0 { Label("\(summary.failingCount) failing", systemImage: "xmark").foregroundStyle(WorkspaceStyle.danger(scheme)) }
            if summary.passedCount > 0 { Label("\(summary.passedCount) passed", systemImage: "checkmark") }
        }.font(WorkspaceStyle.metadata)
    }
}
struct TaskActivityRail<Content: View>: View {
    @Binding var mode: String
    @Binding var width: Double
    let summary: TaskActivitySummary
    var focusHeading = false
    @FocusState private var headingFocused: Bool
    let content: () -> Content
    @State private var dragWidth: Double?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 0) {
                Rectangle().fill(WorkspaceStyle.line(scheme)).frame(width: 6).contentShape(Rectangle())
                    .gesture(DragGesture().onChanged { value in if dragWidth == nil { dragWidth = width }; width = min(560, max(320, (dragWidth ?? width) - value.translation.width)) }.onEnded { _ in dragWidth = nil })
                    .accessibilityLabel("Resize Activity").accessibilityValue("\(Int(width)) points")
                    .accessibilityAdjustableAction { direction in width = min(560, max(320, width + (direction == .increment ? 16 : -16))) }
                    .focusable()
                    .onKeyPress(.leftArrow) { width = min(560, width + 16); return .handled }
                    .onKeyPress(.rightArrow) { width = max(320, width - 16); return .handled }
                VStack(spacing: 0) {
                    HStack { Text("Activity").font(.headline).focusable().focused($headingFocused); Spacer(); WorkspaceActionCluster { WorkspaceIconButton(label: "Close Activity", icon: .close, size: .compact, shortcut: "Esc") { mode = "closed" } } }.padding(16)
                    content()
                }.frame(width: min(560, max(320, width)) - 6)
        }.background(WorkspaceStyle.canvas(scheme)).accessibilityElement(children: .contain).accessibilityLabel("Activity")
            .onChange(of: mode) { _, next in headingFocused = next == "open" && focusHeading }
            .onAppear { if mode == "open", focusHeading { headingFocused = true } }
            .onKeyPress(.escape) { mode = "closed"; return .handled }
    }
}

/// The event log, encoded only while open. SwiftUI builds a DisclosureGroup's content even when it
/// is collapsed, and encoding every event to JSON on each render dominated the inspector's cost.
private struct RawEventsDisclosure: View {
    let events: [WorkspaceEvent]
    @State private var expanded = false
    var body: some View {
        DisclosureGroup("Raw events", isExpanded: $expanded) {
            if expanded {
                let encoder = JSONEncoder()
                let _ = encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                if let data = try? encoder.encode(events), let text = String(data: data, encoding: .utf8) { WorkspaceCopyButton(label: "Copy JSON", text: text) }
                ForEach(events) { event in RawEventRow(event: event) }
            }
        }.font(WorkspaceStyle.metadata)
    }
}
private struct RawEventRow: View {
    let event: WorkspaceEvent
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(event.type, isExpanded: $expanded) {
            if expanded { Text(event.payload.prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
        }
    }
}
