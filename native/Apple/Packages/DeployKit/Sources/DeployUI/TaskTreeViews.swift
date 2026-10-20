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
         canCompose: Bool, compose: @escaping () -> Void, @ViewBuilder row: @escaping (WorkspaceTask) -> Row) {
        self.group = group; self.searching = searching; self.compact = compact
        self.selectedTaskId = selectedTaskId
        self.canCompose = canCompose; self.compose = compose; self.row = row
        _savedExpanded = AppStorage(wrappedValue: true, "task-tree.expanded.\(group.id)")
        _showAll = AppStorage(wrappedValue: false, "task-tree.show-all.\(group.id)")
    }

    private var expanded: Binding<Bool> {
        Binding(get: { searching || savedExpanded }, set: { if !searching { savedExpanded = $0 } })
    }

    var body: some View {
        #if os(iOS)
        if compact {
            Section(isExpanded: expanded) { phoneContent } header: { phoneHeader }
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
                        .frame(maxWidth: .infinity, minHeight: WorkspaceStyle.rowHeight, alignment: .leading)
                        .accessibilityLabel(showAll ? "Show fewer tasks in \(group.name)" : "Show all \(group.tasks.count) tasks in \(group.name)")
                }
            }
        }
        .onHover { hovered = $0 }
    }

    private var listHeader: some View {
        HStack(spacing: 4) {
            Button { expanded.wrappedValue.toggle() } label: {
                HStack(spacing: 4) {
                    Text(group.name).lineLimit(1)
                    // The chevron appears on hover, and stays while the project is collapsed.
                    WorkspaceGlyph(name: expanded.wrappedValue ? .chevronDown : .chevron, size: 12)
                        .opacity(!expanded.wrappedValue || hovered ? 1 : 0)
                    Spacer(minLength: 0)
                }
                .font(WorkspaceStyle.metadata.weight(.medium))
                .foregroundStyle(WorkspaceStyle.tertiary(scheme))
                .frame(maxWidth: .infinity, minHeight: 28).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel(group.name)
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed, \(group.tasks.count) tasks")
            Button(action: compose) {
                WorkspaceGlyph(name: .plus, size: 14).frame(width: 28, height: 28).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .foregroundStyle(WorkspaceStyle.tertiary(scheme))
                .opacity(hovered || composeFocused ? 1 : 0.6)
                .disabled(!canCompose).focused($composeFocused)
                .accessibilityLabel("New task in \(group.name)")
                .help("New task in \(group.name)")
        }
        .padding(.leading, 10).padding(.trailing, 2)
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: iPhone section

    @ViewBuilder private var phoneContent: some View {
        if group.tasks.isEmpty {
            Text("No tasks yet").font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        } else { ForEach(group.tasks) { task in row(task) } }
    }

    private var phoneHeader: some View {
        HStack(spacing: 4) {
            Button { expanded.wrappedValue.toggle() } label: {
                HStack(spacing: 8) {
                    WorkspaceGlyph(name: .folder).foregroundStyle(.secondary)
                    Text(group.name).lineLimit(1)
                    Spacer(minLength: 0)
                    if !expanded.wrappedValue {
                        Text(group.tasks.count, format: .number).monospacedDigit().foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel(group.name)
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed, \(group.tasks.count) tasks")
            Button(action: compose) {
                WorkspaceGlyph(name: .plus, size: 16).frame(width: 44, height: 44)
            }.buttonStyle(.plain).foregroundStyle(.secondary)
                .disabled(!canCompose)
                .accessibilityLabel("New task in \(group.name)")
        }.font(WorkspaceStyle.project).textCase(nil)
    }
}

/// A task in the chat list: its title on one line, with a trailing dot only when the task
/// needs something (running, ready to review, waiting, failed). Finished tasks read quieter,
/// and hovering shows how long ago the task last changed.
struct TaskTreeRow: View {
    let task: WorkspaceTask
    let status: String
    let selected: Bool
    @State private var hovered = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize

    private var tone: WorkspaceStyle.PhoneStatusTone { WorkspaceStyle.phoneStatusTone(status) }
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
            } else if !finished {
                PhoneStatusDot(status: status, size: 7)
            }
        }
        .padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.rowHeight)
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
        switch status {
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
