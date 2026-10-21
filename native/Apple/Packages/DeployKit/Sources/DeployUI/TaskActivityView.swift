import SwiftUI
import DeployCore

struct TaskActivityView: View {
    let activity: TaskActivity
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    var progress: [Message] = []
    var jobs: [WorkspaceJob] = []
    var workers: [Worker] = []
    var openActivity: () -> Void = {}
    var body: some View {
        #if os(iOS)
        if horizontalSizeClass == .compact {
            VStack(alignment: .leading, spacing: 4) {
                activityContent.disclosureGroupStyle(PhoneActivityDisclosureStyle())
                if !jobs.isEmpty { TaskActivitySummaryButton(summary: TaskActivitySummary(jobs: jobs, activity: []), open: openActivity) }
            }
        }
        else { activityContent }
        #else
        activityContent
        #endif
    }
    @ViewBuilder private var activityContent: some View {
        if !activity.items.isEmpty || !progress.isEmpty || !jobs.isEmpty {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(progress) { message in
                        MessageContent(content: message.content).font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(activity.items) { item in
                        DisclosureGroup {
                            if !item.detail.isEmpty { output(item.detail) }
                            if !item.output.isEmpty { output(item.output) }
                        } label: {
                            HStack(spacing: 8) {
                                Label(itemTitle(item), systemImage: item.kind == "command" ? "terminal" : item.kind == "search" ? "magnifyingglass" : "doc.text")
                                #if os(iOS)
                                if horizontalSizeClass != .compact { Spacer(minLength: 8) }
                                #else
                                Spacer(minLength: 8)
                                #endif
                                if item.status != "completed" { Text(item.status.capitalized).foregroundStyle(item.status == "failed" ? .red : .secondary) }
                                else if let exit = item.exitCode, exit != 0 { Text("Exit \(exit)").foregroundStyle(.secondary) }
                            }.font(.caption)
                        }
                    }
                }.padding(.leading, 8).padding(.top, 12)
            } label: {
                HStack(spacing: 8) {
                    Label(activity.summary, systemImage: "terminal").lineLimit(2)
                    #if os(macOS)
                    if !jobs.isEmpty { TaskActivitySummaryButton(summary: TaskActivitySummary(jobs: jobs, activity: []), open: openActivity) }
                    #else
                    if horizontalSizeClass != .compact && !jobs.isEmpty { TaskActivitySummaryButton(summary: TaskActivitySummary(jobs: jobs, activity: []), open: openActivity) }
                    #endif
                    #if os(iOS)
                    if horizontalSizeClass != .compact { Spacer(minLength: 4) }
                    #else
                    Spacer(minLength: 4)
                    #endif
                    if ["queued", "starting", "running"].contains(activity.status) { Text("Working").font(.caption2) }
                }
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
    private func itemTitle(_ item: ActivityItem) -> String {
        guard let job = jobs.first(where: { item.detail.contains($0.id) || item.output.contains($0.id) || (!$0.command.isEmpty && item.detail.contains($0.command)) }) else { return item.title }
        let computer = workers.first { $0.id == job.workerId }?.name ?? job.workerId ?? "Waiting for computer"
        return "\(computer) · \(job.statusLabel)"
    }
    private func output(_ value: String) -> some View {
        ScrollView { Text(value).font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
            .frame(maxHeight: 220).padding(10).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
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
        }
    }
}
