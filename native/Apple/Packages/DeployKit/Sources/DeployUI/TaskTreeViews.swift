import SwiftUI
import DeployCore

/// One project in the task list. On the Mac and iPad it reads like a chat list: a quiet project
/// label with a + for new tasks, then dense one-line task rows, with the first few tasks shown
/// and the rest behind Show more. The iPhone keeps collapsible project rows in an inset-grouped List.
/// Search forces groups open and shows every match without modifying per-device preferences.
struct TaskTreeGroup<Row: View>: View {
    let group: TaskTree.Group
    let searching: Bool
    var idle = false
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
    @FocusState private var disclosureFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    /// Tasks shown per project before Show more, like recent chats in Codex and Claude.
    static var visibleLimit: Int { 5 }

    init(group: TaskTree.Group, searching: Bool, idle: Bool = false, compact: Bool = false, selectedTaskId: String? = nil,
         canCompose: Bool, needsYou: @escaping (WorkspaceTask) -> Bool = { $0.needsApproval || $0.inReview || ["waiting", "review", "ready"].contains($0.status) }, compose: @escaping () -> Void, @ViewBuilder row: @escaping (WorkspaceTask) -> Row) {
        self.group = group; self.searching = searching; self.idle = idle; self.compact = compact
        self.selectedTaskId = selectedTaskId
        self.needsYou = needsYou
        self.canCompose = canCompose; self.compose = compose; self.row = row
        _savedExpanded = AppStorage(wrappedValue: false, "task-tree.projects.expanded.\(group.id)")
        _showAll = AppStorage(wrappedValue: false, "task-tree.show-all.\(group.id)")
    }

    private var expanded: Binding<Bool> {
        Binding(get: { searching || savedExpanded }, set: { if !searching { savedExpanded = $0 } })
    }

    var body: some View {
        #if os(iOS)
        if compact {
            phoneHeader
                .listRowInsets(EdgeInsets(top: 0, leading: WorkspaceStyle.space4, bottom: 0, trailing: WorkspaceStyle.space4))
            if expanded.wrappedValue { phoneContent }
        } else { list }
        #else
        list
        #endif
    }

    // MARK: Chat list (Mac, iPad)

    /// Selection never changes preview membership or shifts the Recents section.
    private var visibleTasks: [WorkspaceTask] {
        guard !searching, !showAll, group.tasks.count > Self.visibleLimit else { return group.tasks }
        return Array(group.tasks.prefix(Self.visibleLimit))
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 1) {
            listHeader
            if expanded.wrappedValue {
                ForEach(visibleTasks) { task in row(task).transition(.opacity.combined(with: .move(edge: .top))) }
                if !searching && group.tasks.count > Self.visibleLimit {
                    Button(showAll ? "Show less" : "Show more") { showAll.toggle() }
                        .buttonStyle(.workspaceLink)
                        .padding(.horizontal, WorkspaceStyle.space2)
                        .frame(maxWidth: .infinity, minHeight: WorkspaceStyle.taskNavigationHeight, alignment: .leading)
                        .accessibilityLabel(showAll ? "Show fewer tasks in \(group.name)" : "Show all \(group.tasks.count) tasks in \(group.name)")
                }
            }
        }
        .onHover { hovered = $0 }
        .animation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion), value: expanded.wrappedValue)
    }

    private var listHeader: some View {
        HStack(spacing: 4) {
            Button { withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { expanded.wrappedValue.toggle() } } label: {
                HStack(spacing: 4) {
                    WorkspaceGlyph(name: .folder, size: 16)
                    Text(group.name).lineLimit(1)
                    Spacer(minLength: 0)
                    projectSignal
                    WorkspaceGlyph(name: .chevron, size: WorkspaceStyle.IconAction.compactGlyph)
                        .rotationEffect(.degrees(expanded.wrappedValue ? 90 : 0))
                        .opacity(group.showsDisclosure(expanded: expanded.wrappedValue) || hovered || disclosureFocused || composeFocused ? 1 : 0)
                }
                .font(WorkspaceStyle.navigation)
                .foregroundStyle(idle && !hovered && !disclosureFocused && !composeFocused && !group.tasks.contains(where: { $0.id == selectedTaskId }) ? WorkspaceStyle.tertiary(scheme) : WorkspaceStyle.text(scheme))
                .frame(maxWidth: .infinity, minHeight: WorkspaceStyle.taskNavigationHeight).contentShape(Rectangle())
            }.buttonStyle(TaskNavigationButtonStyle()).focused($disclosureFocused)
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
        .padding(.trailing, 2)
        .accessibilityAddTraits(.isHeader)
    }

    /// The sidebar glyph is for work blocked on you (an answer or approval); review waits quietly.
    private func blocked(_ task: WorkspaceTask) -> Bool { task.needsApproval || ["waiting", "waiting_for_answer"].contains(task.status) }
    @ViewBuilder private var projectSignal: some View {
        if group.tasks.contains(where: blocked) { WorkspaceGlyph(name: .alert, size: 12).accessibilityLabel("Needs you") }
        else if group.tasks.contains(where: { ["running", "checking", "queued", "starting"].contains($0.status) }) { Group { if reduceMotion { WorkspaceGlyph(name: .refresh, size: WorkspaceStyle.space3) } else { ProgressView().controlSize(.mini) } }.accessibilityLabel("Running") }
    }

    // MARK: iPhone section

    @ViewBuilder private var phoneContent: some View {
        if group.tasks.isEmpty {
            Text("No tasks yet").font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: WorkspaceStyle.IconAction.touch, alignment: .leading)
        } else {
            ForEach(visibleTasks) { task in row(task) }
            if !searching && group.tasks.count > Self.visibleLimit { Button(showAll ? "Show less" : "Show more") { showAll.toggle() }.buttonStyle(.workspaceLink) }
        }
    }

    private var phoneHeader: some View {
        HStack(spacing: WorkspaceStyle.markupMedium) {
            Button { withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { expanded.wrappedValue.toggle() } } label: {
                HStack(spacing: WorkspaceStyle.space2) {
                    WorkspaceGlyph(name: .folder).foregroundStyle(.secondary)
                    Text(group.name).lineLimit(1)
                    Spacer(minLength: 0)
                    projectSignal
                    WorkspaceGlyph(name: .chevron, size: WorkspaceStyle.IconAction.compactGlyph)
                        .rotationEffect(.degrees(expanded.wrappedValue ? 90 : 0))
                }.frame(maxWidth: .infinity, minHeight: WorkspaceStyle.IconAction.touch).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel(group.name)
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed, \(group.tasks.count) tasks")
            WorkspaceIconButton(label: "New task in \(group.name)", icon: .plus, size: .touch, action: compose).foregroundStyle(.secondary)
                .disabled(!canCompose)
                .accessibilityLabel("New task in \(group.name)")
        }.font(WorkspaceStyle.project).textCase(nil)
            .foregroundStyle(idle && !group.tasks.contains(where: { $0.id == selectedTaskId }) ? WorkspaceStyle.tertiary(scheme) : WorkspaceStyle.text(scheme))
    }
}

/// A task in the chat list: its title on one line, with a trailing dot only when the task
/// needs something (running, ready to review, waiting). Finished tasks read quieter,
/// and hovering shows how long ago the task last changed.
struct TaskTreeRow: View {
    let task: WorkspaceTask
    let status: String
    let selected: Bool
    var selectedInk = false
    var indent: CGFloat = 0
    var hideSignal = false
    var reserveActions = false
    @State private var hovered = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Waiting on you (an answer or an approval) outranks being in review.
    private var dotStatus: String { task.needsApproval || status == "waiting" ? status : task.inReview ? "in_review" : status }
    private var tone: WorkspaceStyle.PhoneStatusTone { WorkspaceStyle.phoneStatusTone(dotStatus) }
    private var finished: Bool { tone == .healthy || tone == .inactive }

    var body: some View {
        HStack(spacing: 8) {
            Text(task.title).font(WorkspaceStyle.navigation)
                .foregroundStyle(finished && !selected && !selectedInk ? WorkspaceStyle.secondaryText(scheme) : WorkspaceStyle.text(scheme))
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
            if (task.needsApproval || ["waiting", "waiting_for_answer"].contains(status)) {
                WorkspaceGlyph(name: .alert, size: 12).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            } else if ["running", "checking", "queued", "starting"].contains(status) {
                if reduceMotion { WorkspaceGlyph(name: .refresh, size: WorkspaceStyle.space3) } else { ProgressView().controlSize(.mini) }
            }
            }.frame(width: reserveActions ? WorkspaceIconButtonSize.compact.target * 2 + WorkspaceStyle.IconAction.gap : WorkspaceStyle.space3, alignment: .trailing).opacity(hideSignal ? 0 : 1)
        }
        .padding(.leading, indent).padding(.horizontal, WorkspaceStyle.space2).frame(minHeight: WorkspaceStyle.taskNavigationHeight)
        .background(selected ? WorkspaceStyle.selected(scheme) : hovered ? WorkspaceStyle.hover(scheme) : .clear,
                    in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
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

/// Reads the same persisted disclosure preference as its project, so only one row has fill.
struct RecentTaskTreeRow: View {
    let task: WorkspaceTask
    let status: String
    let selected: Bool
    let searching: Bool
    let index: Int?
    var hideSignal = false
    var reserveActions = false
    @AppStorage private var expanded: Bool
    @AppStorage private var showAll: Bool
    init(task: WorkspaceTask, status: String, selected: Bool, searching: Bool, group: TaskTree.Group?, hideSignal: Bool = false, reserveActions: Bool = false) {
        self.reserveActions = reserveActions
        self.hideSignal = hideSignal
        self.task = task; self.status = status; self.selected = selected; self.searching = searching
        index = group?.tasks.firstIndex(where: { $0.id == task.id })
        _expanded = AppStorage(wrappedValue: false, "task-tree.projects.expanded.\(group?.id ?? "")")
        _showAll = AppStorage(wrappedValue: false, "task-tree.show-all.\(group?.id ?? "")")
    }
    var body: some View {
        TaskTreeRow(task: task, status: status, selected: selected && !InteractionLayout.taskHasProjectSelection(index: index, expanded: expanded, searching: searching, showAll: showAll), selectedInk: selected, hideSignal: hideSignal, reserveActions: reserveActions)
    }
}

struct TaskNavigationButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, WorkspaceStyle.space2)
            .background(configuration.isPressed ? WorkspaceStyle.selected(scheme) : hovered ? WorkspaceStyle.hover(scheme) : .clear, in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
            .onHover { hovered = $0 }
    }
    @State private var hovered = false
    @Environment(\.colorScheme) private var scheme
}

/// Selection and utility actions are siblings, preserving keyboard focus and hover prefetch.
struct SidebarTaskActions<Content: View>: View {
    let task: WorkspaceTask
    let store: WorkspaceStore
    @ViewBuilder let content: (Bool) -> Content
    @State private var hovered = false
    @FocusState private var focused: Bool
    private var showing: Bool {
        #if os(macOS)
        hovered || focused
        #else
        true
        #endif
    }
    var body: some View {
        content(showing).focused($focused)
            .overlay(alignment: .trailing) {
                WorkspaceActionCluster {
                    WorkspaceIconButton(label: store.pinnedTaskIDs.contains(task.id) ? "Unpin" : "Pin", icon: .pin, size: .compact, pressed: store.pinnedTaskIDs.contains(task.id)) { store.togglePin(task.id) }.focused($focused)
                    if !["done", "merged"].contains(task.status) {
                        WorkspaceIconButton(label: "Mark done", icon: .check, size: .compact) { Task { await store.markDone(task) } }
                            .focused($focused).disabled(TaskTree.isRunning(task) || store.busy)
                            .help(TaskTree.isRunning(task) ? "Stop active work before marking done" : "Mark done")
                    }
                }.padding(.trailing, WorkspaceStyle.space1)
                    .opacity(showing ? 1 : 0).allowsHitTesting(showing)
            }
            .onHover { hovered = $0 }
    }
}
