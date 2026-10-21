import SwiftUI
import DeployCore

struct TaskActivitySummaryButton: View {
    let summary: TaskActivitySummary
    let open: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if summary.isVisible {
            Button(action: open) {
                HStack(spacing: 8) {
                    WorkspaceGlyph(name: .terminal, size: 14)
                    if summary.runningCount > 0 {
                        Circle().fill(WorkspaceStyle.statusActive(colorScheme)).frame(width: 5, height: 5)
                    }
                    Text(summary.text).lineLimit(1).truncationMode(.tail)
                    WorkspaceGlyph(name: .chevron, size: 14)
                }.font(WorkspaceStyle.metadata).frame(minHeight: WorkspaceStyle.controlSize)
            }.buttonStyle(.workspaceLink)
                .accessibilityLabel(summary.label)
                .accessibilityIdentifier("task-activity-summary")
        }
    }
}

struct TaskActivityInspector: View {
    let detail: TaskDetail?
    let workers: [Worker]
    let cancel: (WorkspaceJob) -> Void
    @Environment(\.colorScheme) private var colorScheme
    private var activity: [TaskActivity] { detail?.activity ?? [] }
    private var jobs: [WorkspaceJob] { TaskActivitySummary.orderedJobs(detail?.jobs ?? []) }
    private var questions: [WorkspaceQuestion] { (detail?.questions ?? []).filter { $0.status != "pending" } }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    heading("Processes")
                    if jobs.isEmpty { empty("No processes yet.") }
                    ForEach(jobs) { job in
                        CheckpointJobRow(job: job,
                            computerName: workers.first(where: { $0.id == job.workerId })?.name ?? job.workerId ?? "Waiting for computer",
                            cancel: { cancel(job) })
                        Divider()
                    }
                }
                VStack(alignment: .leading, spacing: 12) {
                    heading("Sources")
                    if TaskActivitySummary(jobs: jobs, activity: activity).sources.isEmpty { empty("No sources yet.") }
                    else { TaskSourcesView(activity: activity, expanded: true) }
                }
                VStack(alignment: .leading, spacing: 12) {
                    heading("Questions and answers")
                    if questions.isEmpty { empty("No answered questions yet.") }
                    ForEach(questions) { question in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(question.question)
                            Text(question.answer ?? question.status.capitalized).foregroundStyle(.secondary)
                        }.font(WorkspaceStyle.metadata).textSelection(.enabled)
                    }
                }
                VStack(alignment: .leading, spacing: 12) {
                    heading("Agent activity")
                    if !activity.contains(where: { !$0.items.isEmpty }) { empty("No agent activity yet.") }
                    ForEach(activity) { turn in TaskActivityView(activity: turn) }
                }
                DisclosureGroup("Technical event log") {
                    if detail?.events.isEmpty != false { empty("No events yet.") }
                    ForEach(Array((detail?.events ?? []).suffix(60))) { event in
                        DisclosureGroup(event.type) {
                            Text(event.payload.prettyText).font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(.vertical, 8)
                    }
                }.font(WorkspaceStyle.metadata)
            }.frame(maxWidth: .infinity, alignment: .leading)
                .padding(WorkspaceStyle.conversationGutter)
        }.accessibilityIdentifier("task-activity-inspector")
            #if os(iOS)
            .modifier(PhoneActivityDisclosure())
            #endif
    }

    private func heading(_ text: String) -> some View {
        Text(text).font(.headline).accessibilityAddTraits(.isHeader)
    }
    private func empty(_ text: String) -> some View {
        Text(text).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(colorScheme))
    }
}
