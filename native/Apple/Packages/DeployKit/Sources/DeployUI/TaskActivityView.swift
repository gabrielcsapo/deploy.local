import SwiftUI
import DeployCore

struct TaskActivityView: View {
    let activity: TaskActivity
    var run: Run? = nil
    var progress: [Message] = []
    var jobs: [WorkspaceJob] = []
    var workers: [Worker] = []
    var openActivity: () -> Void = {}
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 14) {
                Text(activity.summary).font(WorkspaceStyle.metadata)
                if !jobs.isEmpty { TaskActivitySummaryButton(summary: TaskActivitySummary(jobs: jobs, activity: []), open: openActivity) }
                ForEach(progress) { message in MessageContent(content: message.content).font(WorkspaceStyle.metadata) }
                ForEach(activity.items) { item in
                    DisclosureGroup {
                        if !item.detail.isEmpty { output(item.detail) }
                        if !item.output.isEmpty { output(item.output) }
                    } label: {
                        HStack(spacing: WorkspaceStyle.space2) {
                            WorkspaceGlyph(name: item.kind == "command" ? .terminal : item.kind == "search" ? .search : .file, size: 14)
                            Text(itemTitle(item))
                            Spacer(minLength: 4)
                            if item.status != "completed" { Text(item.status.capitalized) }
                            else if let exit = item.exitCode, exit != 0 { Text("Exit \(exit)") }
                        }.font(WorkspaceStyle.metadata)
                    }
                }
            }.padding(.top, WorkspaceStyle.space3)
        } label: {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(spacing: WorkspaceStyle.space2) {
                    let duration = run?.workedDuration(now: context.date) ?? ""
                    Text("\(run?.isActive == true ? "Working" : "Worked")\(duration.isEmpty ? "" : " for " + duration)")
                    if !jobs.isEmpty {
                        let summary = TaskActivitySummary(jobs: jobs, activity: [])
                        Text("· \(jobs.count) job\(jobs.count == 1 ? "" : "s")\(summary.computerCount > 0 ? " on \(summary.computerCount) computer\(summary.computerCount == 1 ? "" : "s")" : "")")
                            .foregroundStyle(summary.failingCount > 0 ? WorkspaceStyle.danger(scheme) : WorkspaceStyle.secondaryText(scheme))
                    }
                }.font(WorkspaceStyle.metadata)
            }
        }.foregroundStyle(activity.status == "failed" || TaskActivitySummary(jobs: jobs, activity: []).failingCount > 0 ? WorkspaceStyle.danger(scheme) : WorkspaceStyle.secondaryText(scheme))
            .padding(.bottom, WorkspaceStyle.space2)
            .overlay(alignment: .bottom) { Rectangle().fill(WorkspaceStyle.line(scheme)).frame(height: 1) }
    }
    private func itemTitle(_ item: ActivityItem) -> String {
        guard let job = jobs.first(where: { item.detail.contains($0.id) || item.output.contains($0.id) || (!$0.command.isEmpty && item.detail.contains($0.command)) }) else { return item.title }
        let computer = workers.first { $0.id == job.workerId }?.name ?? job.workerId ?? "Waiting for computer"
        return "\(computer) · \(job.statusLabel)"
    }
    private func output(_ value: String) -> some View {
        ScrollView { Text(value).font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
            .frame(maxHeight: 220).padding(WorkspaceStyle.space3).background(WorkspaceStyle.hover(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.space3))
    }
}

struct TaskSourcesView: View {
    let activity: [TaskActivity]
    var expanded = false
    var roots: [String] = []
    @State private var isExpanded = false
    private var sources: [String] {
        TaskActivitySummary(jobs: [], activity: activity).sources.map { source in
            guard let root = roots.first(where: { source.hasPrefix($0 + "/") }) else { return source }
            return String(source.dropFirst(root.count + 1))
        }
    }
    var body: some View {
        if !sources.isEmpty {
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(sources, id: \.self) { source in
                        if let url = URL(string: source), ["https", "http"].contains(url.scheme ?? "") {
                            Link(destination: url) { Label(source, systemImage: "globe").frame(minHeight: WorkspaceStyle.controlSize, alignment: .leading) }
                        } else {
                            VStack(alignment: .leading, spacing: 3) {
                                Label(source.components(separatedBy: "/").last ?? source, systemImage: "doc.text")
                                Text(source.components(separatedBy: "/").dropLast().joined(separator: "/")).font(WorkspaceStyle.metadata).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                            }
                        }
                    }
                }.padding(.top, 10).font(.caption)
            } label: { Label("Read \(sources.count) file\(sources.count == 1 ? "" : "s")", systemImage: "doc.text") }
                .font(.caption).foregroundStyle(.secondary)
                .onAppear { isExpanded = expanded }
                .onChange(of: expanded) { _, value in if value { isExpanded = true } }
        }
    }
}
