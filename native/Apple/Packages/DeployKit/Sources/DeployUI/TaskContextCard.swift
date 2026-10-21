import SwiftUI
import DeployCore

/// Lives only in the unused margin of the centered transcript and composer.
struct TaskContextCard: View {
    let detail: TaskDetail?
    let diff: TaskDiff?
    let workers: [Worker]
    let project: String?
    let changes: () -> Void
    let activity: () -> Void
    let sources: () -> Void
    @AppStorage("workspace.task-card.collapsed") private var collapsed = false
    @Environment(\.colorScheme) private var scheme
    private var summary: TaskActivitySummary { TaskActivitySummary(jobs: detail?.jobs ?? [], activity: detail?.activity ?? []) }
    private var running: [WorkspaceJob] { Array((detail?.jobs ?? []).filter(\.isActive).prefix(3)) }
    private var deployedURL: URL? {
        for event in (detail?.events ?? []).reversed() where event.type == "application.deployed" {
            if case .object(let payload) = event.payload, payload["status"]?.displayText == "running",
               let value = payload["url"]?.displayText, let url = URL(string: value), ["https", "http"].contains(url.scheme ?? "") { return url }
        }
        return nil
    }
    var body: some View {
        Group {
            if collapsed {
                WorkspaceIconButton(label: "Expand task card", icon: .panelRight) { collapsed = false }
            } else {
                VStack(alignment: .leading, spacing: WorkspaceStyle.space4) {
                    HStack {
                        Text(project ?? "Task").lineLimit(1)
                        Spacer()
                        WorkspaceIconButton(label: "Collapse task card", icon: .collapse, size: .compact) { collapsed = true }
                    }
                    Button(action: changes) {
                        HStack(spacing: WorkspaceStyle.space2) {
                            WorkspaceGlyph(name: .review, size: 16); Text("Changes"); Spacer()
                            if let diff {
                                let patches = reviewFilePatches(diff.patch, files: diff.files)
                                LineCounts(additions: patches.reduce(0) { $0 + $1.additions }, deletions: patches.reduce(0) { $0 + $1.deletions })
                                if diff.truncated == true { Text("…").help("Counts in the available, truncated patch") }
                            } else { Text("Unavailable") }
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Button(action: activity) {
                        HStack(spacing: WorkspaceStyle.space2) {
                            WorkspaceGlyph(name: .panelRight, size: 16); Text("Activity"); Spacer()
                            Text("◐ \(summary.runningCount)")
                            Text("✕ \(summary.failingCount)").foregroundStyle(summary.failingCount > 0 ? WorkspaceStyle.danger(scheme) : WorkspaceStyle.secondaryText(scheme))
                            Text("✓ \(summary.passedCount)")
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(summary.label)
                    if !running.isEmpty {
                        VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                            Text("Running now").foregroundStyle(WorkspaceStyle.tertiary(scheme))
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                ForEach(running) { job in
                                    let label = "\(job.title) · \(workers.first { $0.id == job.workerId }?.name ?? job.workerId ?? "Waiting for computer") · \(job.duration(now: context.date))"
                                    Text(label).lineLimit(1).help(label)
                                }
                            }
                        }
                    }
                    if !summary.sources.isEmpty {
                        HStack { WorkspaceGlyph(name: .file, size: 16); Text("Sources · \(summary.sources.count)"); Spacer(); Button("View all", action: sources).buttonStyle(.workspaceLink) }
                    }
                    if let url = deployedURL {
                        VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                            Text("Deployed").foregroundStyle(WorkspaceStyle.tertiary(scheme))
                            Link(url.absoluteString, destination: url).lineLimit(1).foregroundStyle(WorkspaceStyle.accent(scheme))
                        }
                    }
                }.frame(width: 248).padding(WorkspaceStyle.space4)
            }
        }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.space3))
            .overlay { RoundedRectangle(cornerRadius: WorkspaceStyle.space3).stroke(WorkspaceStyle.line(scheme), lineWidth: 1) }
            .shadow(color: WorkspaceStyle.line(scheme).opacity(0.3), radius: WorkspaceStyle.space3, x: 0, y: 4)
            .accessibilityElement(children: .contain).accessibilityLabel("Task card")
    }
}
