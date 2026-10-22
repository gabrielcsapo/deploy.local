import SwiftUI
import DeployCore

/// Lives only in the unused margin of the centered transcript and composer.
struct TaskContextCard: View {
    var width: CGFloat = 260
    var maximumHeight: CGFloat = .infinity
    @State private var contentHeight: CGFloat = 400
    let detail: TaskDetail?
    let diff: TaskDiff?
    let workers: [Worker]
    let project: String?
    let changes: () -> Void
    let activity: () -> Void
    let sources: () -> Void
    var keyboardActivity: (() -> Void)? = nil
    @AppStorage("workspace.task-card.collapsed") private var collapsed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    private var summary: TaskActivitySummary { TaskActivitySummary(jobs: detail?.jobs ?? [], activity: detail?.activity ?? []) }
    private var running: [WorkspaceJob] { Array((detail?.jobs ?? []).filter(\.isActive).prefix(3)) }
    private var deployedURL: URL? {
        for message in (detail?.messages ?? []).reversed() {
            if let deployment = message.deployment, deployment.status == "running",
               let value = deployment.url, let url = URL(string: value), ["https", "http"].contains(url.scheme ?? "") { return url }
        }
        return nil
    }
    var body: some View {
        ScrollView(.vertical) {
            cardContent
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .frame(width: collapsed ? WorkspaceStyle.Toolbar.targetSize : width, height: min(contentHeight, maximumHeight))
        .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: collapsed)
        .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: contentHeight)
        .background(WorkspaceStyle.raised(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.space4))
        .cardElevation(scheme, cornerRadius: WorkspaceStyle.space4)
        .accessibilityElement(children: .contain).accessibilityLabel("Task card")
    }
    private var cardContent: some View {
        Group {
            if collapsed {
                WorkspaceIconButton(label: "Expand task card", icon: .panelRight) { collapsed = false }
            } else {
                // As in Codex: a quiet project label and a ⋯ menu, then tight rows grouped by thin rules.
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text(project ?? "Task").lineLimit(1).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                        Spacer()
                        moreMenu
                    }.padding(.leading, WorkspaceStyle.space2)
                    group {
                        row(icon: .review, title: "Changes", action: changes) {
                            if let diff {
                                let patches = reviewFilePatches(diff.patch, files: diff.files)
                                LineCounts(additions: patches.reduce(0) { $0 + $1.additions }, deletions: patches.reduce(0) { $0 + $1.deletions })
                                if diff.truncated == true { Text("…").help("Counts in the available, truncated patch") }
                            } else { Text("Unavailable").foregroundStyle(WorkspaceStyle.secondaryText(scheme)) }
                        }
                        row(icon: .panelRight, title: "Activity", action: activity) {
                            // Only the counts that exist, as on the web card.
                            HStack(spacing: WorkspaceStyle.space1) {
                                if summary.runningCount > 0 { Text("◐ \(summary.runningCount)") }
                                if summary.failingCount > 0 { Text("✕ \(summary.failingCount)").foregroundStyle(WorkspaceStyle.danger(scheme)) }
                                if summary.passedCount > 0 { Text("✓ \(summary.passedCount)") }
                            }.foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                        }
                        .accessibilityLabel(summary.label)
                        .onKeyPress(keys: [.return, .space]) { _ in (keyboardActivity ?? activity)(); return .handled }
                    }
                    if !running.isEmpty {
                        divider
                        group {
                            sectionTitle("Running now")
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                VStack(spacing: 0) {
                                    ForEach(running) { job in
                                        let computer = workers.first { $0.id == job.workerId }?.name ?? job.workerId ?? "Waiting for computer"
                                        row(icon: .terminal, title: job.title) {
                                            Text("\(computer) · \(job.duration(now: context.date))").foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                                        }.help("\(job.title) · \(computer) · \(job.duration(now: context.date))")
                                    }
                                }
                            }
                        }
                    }
                    if !summary.sources.isEmpty {
                        divider
                        group {
                            sectionTitle("Sources")
                            ForEach(summary.sources.prefix(3), id: \.self) { source in
                                row(icon: source.hasPrefix("http") ? .external : .file, title: Self.sourceName(source), action: sources) { EmptyView() }.help(source)
                            }
                            row(icon: .link, title: "View all", quiet: true, action: sources) {
                                if summary.sources.count > 3 { Text("\(summary.sources.count)").foregroundStyle(WorkspaceStyle.secondaryText(scheme)) }
                            }
                        }
                    }
                    if let url = deployedURL {
                        divider
                        group {
                            sectionTitle("Deployed")
                            Link(destination: url) {
                                rowLabel(icon: .external, title: url.host() ?? url.absoluteString) { EmptyView() }
                            }.buttonStyle(TaskCardRowStyle()).help(url.absoluteString)
                        }
                    }
                }.padding(.horizontal, WorkspaceStyle.space2).padding(.top, WorkspaceStyle.space2).padding(.bottom, WorkspaceStyle.space1).frame(width: width)
            }
        }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.text(scheme))
    }

    private var moreMenu: some View {
        Menu {
            Button("Show activity", action: activity)
            if !summary.sources.isEmpty { Button("Show sources", action: sources) }
            Button("Collapse card") { collapsed = true }
        } label: {
            WorkspaceGlyph(name: .more, size: WorkspaceStyle.IconAction.standardGlyph)
                .frame(width: WorkspaceStyle.Toolbar.targetSize, height: WorkspaceStyle.Toolbar.targetSize)
                .contentShape(Rectangle())
        }
        .menuIndicator(.hidden).buttonStyle(WorkspaceToolbarButtonStyle()).fixedSize().help("Task card options")
        .foregroundStyle(WorkspaceStyle.secondaryText(scheme))
        .accessibilityLabel("Task card options")
    }
    private var divider: some View { Rectangle().fill(WorkspaceStyle.line(scheme)).frame(height: 1) }
    private func group<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0, content: content).padding(.vertical, WorkspaceStyle.space1)
    }
    private func sectionTitle(_ title: String) -> some View {
        Text(title).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            .padding(.horizontal, WorkspaceStyle.space2).padding(.vertical, WorkspaceStyle.space1)
    }
    private func rowLabel<Trailing: View>(icon: WorkspaceGlyphName, title: String, quiet: Bool = false, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: WorkspaceStyle.space2) {
            WorkspaceGlyph(name: icon, size: WorkspaceStyle.space4)
            Text(title).fontWeight(quiet ? .regular : .medium).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: WorkspaceStyle.space2)
            trailing()
        }
        .foregroundStyle(quiet ? WorkspaceStyle.tertiary(scheme) : WorkspaceStyle.text(scheme))
        .padding(.horizontal, WorkspaceStyle.space2)
        .frame(minHeight: WorkspaceStyle.space8)
        .contentShape(Rectangle())
    }
    @ViewBuilder private func row<Trailing: View>(icon: WorkspaceGlyphName, title: String, quiet: Bool = false, action: (() -> Void)? = nil, @ViewBuilder trailing: () -> Trailing) -> some View {
        if let action {
            Button(action: action) { rowLabel(icon: icon, title: title, quiet: quiet, trailing: trailing) }.buttonStyle(TaskCardRowStyle())
        } else {
            rowLabel(icon: icon, title: title, quiet: quiet, trailing: trailing)
        }
    }
    /// A file's name or a page's host and path, as the card shows sources.
    static func sourceName(_ source: String) -> String {
        if source.hasPrefix("http"), let url = URL(string: source), let host = url.host() {
            return host + (url.path() == "/" ? "" : url.path())
        }
        return source.split(separator: "/").last.map(String.init) ?? source
    }
}

/// Rows highlight on hover like Codex's context card.
private struct TaskCardRowStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    @State private var hovered = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background((hovered || configuration.isPressed) ? WorkspaceStyle.hover(scheme) : .clear, in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
            .onHover { hovered = $0 }
    }
}
