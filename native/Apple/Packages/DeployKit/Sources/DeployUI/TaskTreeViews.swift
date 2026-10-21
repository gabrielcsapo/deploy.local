import SwiftUI
import DeployCore

/// One project in the task list. On the Mac and iPad it reads like a chat list: a quiet project
/// label with a + for new tasks, then dense one-line task rows, with the first few tasks shown
/// and the rest behind Show more. The iPhone keeps a collapsible List section.
/// Search forces groups open and shows every match without modifying per-device preferences.
struct TaskTreeGroup<Row: View>: View {
    let group: TaskTree.Group
    let searching: Bool
    var compact = false
    var selectedTaskId: String? = nil
    var needsYou: (WorkspaceTask) -> Bool = { $0.needsApproval || $0.inReview || ["waiting", "review", "ready"].contains($0.status) }
    let canCompose: Bool
    let compose: () -> Void
    @ViewBuilder let row: (WorkspaceTask) -> Row
    @AppStorage private var savedExpanded: Bool
    @AppStorage private var showAll: Bool
    @State private var hovered = false
    @FocusState private var composeFocused: Bool
    @Environment(\.colorScheme) private var scheme

    /// Tasks shown per project before Show more, like recent chats in Codex and Claude.
    static var visibleLimit: Int { 5 }

    init(group: TaskTree.Group, searching: Bool, compact: Bool = false, selectedTaskId: String? = nil,
         canCompose: Bool, needsYou: @escaping (WorkspaceTask) -> Bool = { $0.needsApproval || $0.inReview || ["waiting", "review", "ready"].contains($0.status) }, compose: @escaping () -> Void, @ViewBuilder row: @escaping (WorkspaceTask) -> Row) {
        self.group = group; self.searching = searching; self.compact = compact
        self.selectedTaskId = selectedTaskId
        self.needsYou = needsYou
        self.canCompose = canCompose; self.compose = compose; self.row = row
        _savedExpanded = AppStorage(wrappedValue: group.tasks.contains { $0.id == selectedTaskId }, "task-tree.projects.expanded.\(group.id)")
        _showAll = AppStorage(wrappedValue: false, "task-tree.show-all.\(group.id)")
    }

    private var expanded: Binding<Bool> {
        Binding(get: { searching || savedExpanded }, set: { if !searching { savedExpanded = $0 } })
    }

    var body: some View {
        #if os(iOS)
        if compact {
            Section(isExpanded: expanded) { phoneContent } header: { phoneHeader }
                .onAppear { if group.tasks.contains(where: { $0.id == selectedTaskId }) { savedExpanded = true } }
        } else { list }
        #else
        list
        #endif
    }

    // MARK: Chat list (Mac, iPad)

    /// The first tasks by recent activity; the selected task always stays visible.
    private var visibleTasks: [WorkspaceTask] {
        guard !searching, !showAll, group.tasks.count > Self.visibleLimit else { return group.tasks }
        var shown = Array(group.tasks.prefix(Self.visibleLimit))
        if let selectedTaskId, !shown.contains(where: { $0.id == selectedTaskId }),
           let selected = group.tasks.first(where: { $0.id == selectedTaskId }) { shown.append(selected) }
        return shown
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 1) {
            listHeader
            if expanded.wrappedValue {
                ForEach(visibleTasks) { task in row(task) }
                if !searching && group.tasks.count > Self.visibleLimit {
                    Button(showAll ? "Show less" : "Show more") { showAll.toggle() }
                        .buttonStyle(.workspaceLink)
                        .padding(.horizontal, 10)
                        .frame(maxWidth: .infinity, minHeight: WorkspaceStyle.taskNavigationHeight, alignment: .leading)
                        .accessibilityLabel(showAll ? "Show fewer tasks in \(group.name)" : "Show all \(group.tasks.count) tasks in \(group.name)")
                }
            }
        }
        .onHover { hovered = $0 }
        .onAppear { if group.tasks.contains(where: { $0.id == selectedTaskId }) { savedExpanded = true } }
        .onChange(of: selectedTaskId) { _, selected in
            if group.tasks.contains(where: { $0.id == selected }) { savedExpanded = true }
        }
    }

    private var listHeader: some View {
        HStack(spacing: 4) {
            Button { expanded.wrappedValue.toggle() } label: {
                HStack(spacing: 4) {
                    WorkspaceGlyph(name: .folder, size: 16)
                    Text(group.name).lineLimit(1)
                    Spacer(minLength: 0)
                    projectSignal
                }
                .font(WorkspaceStyle.navigation)
                .foregroundStyle(group.tasks.contains(where: needsYou) || group.tasks.contains(where: { ["running", "checking", "queued"].contains($0.status) }) ? WorkspaceStyle.text(scheme) : WorkspaceStyle.secondaryText(scheme))
                .frame(maxWidth: .infinity, minHeight: WorkspaceStyle.taskNavigationHeight).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel(group.name)
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed, \(group.tasks.count) tasks")
            WorkspaceIconButton(label: "New task in \(group.name)", icon: .plus, size: .compact, action: compose)
                .foregroundStyle(WorkspaceStyle.tertiary(scheme))
                #if os(macOS)
                .opacity(hovered || composeFocused ? 1 : 0)
                #endif
                .disabled(!canCompose).focused($composeFocused)
                .accessibilityLabel("New task in \(group.name)")
                .help("New task in \(group.name)")
        }
        .padding(.leading, 10).padding(.trailing, 2)
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private var projectSignal: some View {
        if group.tasks.contains(where: needsYou) { WorkspaceGlyph(name: .alert, size: 12).accessibilityLabel("Needs you") }
        else if group.tasks.contains(where: { ["running", "checking", "queued", "starting"].contains($0.status) }) { ProgressView().controlSize(.mini).accessibilityLabel("Running") }
    }

    // MARK: iPhone section

    @ViewBuilder private var phoneContent: some View {
        if group.tasks.isEmpty {
            Text("No tasks yet").font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        } else {
            ForEach(visibleTasks) { task in row(task) }
            if !searching && group.tasks.count > Self.visibleLimit { Button(showAll ? "Show less" : "Show more") { showAll.toggle() }.buttonStyle(.workspaceLink) }
        }
    }

    private var phoneHeader: some View {
        HStack(spacing: 4) {
            Button { expanded.wrappedValue.toggle() } label: {
                HStack(spacing: 8) {
                    WorkspaceGlyph(name: .folder).foregroundStyle(.secondary)
                    Text(group.name).lineLimit(1)
                    Spacer(minLength: 0)
                    projectSignal
                }.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel(group.name)
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed, \(group.tasks.count) tasks")
            WorkspaceIconButton(label: "New task in \(group.name)", icon: .plus, size: .touch, action: compose).foregroundStyle(.secondary)
                .disabled(!canCompose)
                .accessibilityLabel("New task in \(group.name)")
        }.font(WorkspaceStyle.project).textCase(nil)
    }
}

/// A task in the chat list: its title on one line, with a trailing dot only when the task
/// needs something (running, ready to review, waiting). Finished tasks read quieter,
/// and hovering shows how long ago the task last changed.
struct TaskTreeRow: View {
    let task: WorkspaceTask
    let status: String
    let selected: Bool
    @State private var hovered = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Waiting on you (an answer or an approval) outranks being in review.
    private var dotStatus: String { task.needsApproval || status == "waiting" ? status : task.inReview ? "in_review" : status }
    private var tone: WorkspaceStyle.PhoneStatusTone { WorkspaceStyle.phoneStatusTone(dotStatus) }
    private var finished: Bool { tone == .healthy || tone == .inactive }

    var body: some View {
        HStack(spacing: 8) {
            Text(task.title).font(WorkspaceStyle.navigation)
                .foregroundStyle(finished && !selected ? WorkspaceStyle.secondaryText(scheme) : WorkspaceStyle.text(scheme))
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hovered, let date = TaskTree.activityDate(task.updatedAt) {
                TaskRelativeTime(date: date).font(WorkspaceStyle.metadata)
                    .foregroundStyle(WorkspaceStyle.tertiary(scheme)).fixedSize()
            } else if task.needsApproval || task.inReview || ["waiting", "waiting_for_answer", "ready", "review"].contains(status) {
                WorkspaceGlyph(name: .alert, size: 12).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            } else if ["running", "checking", "queued", "starting"].contains(status) {
                ProgressView().controlSize(.mini)
            }
        }
        .padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.taskNavigationHeight)
        .background(selected ? WorkspaceStyle.selected(scheme) : hovered ? WorkspaceStyle.hover(scheme) : .clear,
                    in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        #if os(macOS)
        .onHover { hovered = $0 }
        #endif
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(task.title) + Text(", \(statusLabel)"))
        .accessibilityValue(ageLabel)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var statusLabel: String {
        if task.needsApproval { return "Needs your approval" }
        if let label = task.reviewLabel { return label }
        return switch status {
        case "waiting", "waiting_for_answer": "Waiting for your answer"
        case "review", "ready": "Ready to review"
        case "succeeded", "done", "completed": "Done"
        default: status.capitalized
        }
    }

    private var ageLabel: Text {
        if let date = TaskTree.activityDate(task.updatedAt) {
            Text(date, format: .relative(presentation: .named, unitsStyle: .wide))
        } else { Text("Update time unavailable") }
    }
}
