import SwiftUI
import DeployCore

/// Search forces groups open without modifying their per-device preference.
struct TaskTreeGroup<Rows: View>: View {
    let group: TaskTree.Group
    let searching: Bool
    var compact = false
    let canCompose: Bool
    let compose: () -> Void
    @ViewBuilder let rows: () -> Rows
    @AppStorage private var savedExpanded: Bool
    @State private var hovered = false
    @FocusState private var composeFocused: Bool
    @FocusState private var headerFocused: Bool

    init(group: TaskTree.Group, searching: Bool, compact: Bool = false, canCompose: Bool,
         compose: @escaping () -> Void, @ViewBuilder rows: @escaping () -> Rows) {
        self.group = group; self.searching = searching; self.compact = compact
        self.canCompose = canCompose; self.compose = compose; self.rows = rows
        _savedExpanded = AppStorage(wrappedValue: true, "task-tree.expanded.\(group.id)")
    }

    private var expanded: Binding<Bool> {
        Binding(get: { searching || savedExpanded }, set: { if !searching { savedExpanded = $0 } })
    }

    var body: some View {
        #if os(iOS)
        if compact {
            Section(isExpanded: expanded) { content } header: { header }
        } else { disclosure }
        #else
        disclosure
        #endif
    }

    private var disclosure: some View {
        DisclosureGroup(isExpanded: expanded) { content } label: { header }
            .onHover { hovered = $0 }
    }

    @ViewBuilder private var content: some View {
        if group.tasks.isEmpty {
            Text("No tasks yet").font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        } else { rows() }
    }

    private var header: some View {
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
            }.buttonStyle(.plain).focused($headerFocused)
                .accessibilityLabel(group.name)
                .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed, \(group.tasks.count) tasks")
            Button(action: compose) {
                WorkspaceGlyph(name: .plus, size: 16).frame(width: 44, height: 44)
            }.buttonStyle(.plain).foregroundStyle(.secondary)
                .disabled(!canCompose).focused($composeFocused)
                .accessibilityLabel("New task in \(group.name)")
                .help("New task in \(group.name)")
                #if os(macOS)
                .opacity(hovered || headerFocused || composeFocused ? 1 : 0)
                #endif
        }.font(WorkspaceStyle.project).textCase(nil)
    }
}

struct TaskTreeRow: View {
    let task: WorkspaceTask
    let status: String
    let selected: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 8) {
            PhoneStatusDot(status: status, size: 8)
            Text(task.title).font(WorkspaceStyle.navigation)
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let date = TaskTree.activityDate(task.updatedAt) {
                TaskRelativeTime(date: date).font(.caption).foregroundStyle(.secondary)
                    .fixedSize()
            }
        }.padding(.horizontal, 10).padding(.vertical, 4).frame(minHeight: 44)
            .background(selected ? WorkspaceStyle.selected(scheme) : .clear, in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text(task.title) + Text(", \(statusLabel)"))
            .accessibilityValue(ageLabel)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var statusLabel: String {
        switch status {
        case "waiting", "waiting_for_answer": "Waiting for your answer"
        case "review", "ready": "Ready to review"
        default: status.capitalized
        }
    }

    private var ageLabel: Text {
        if let date = TaskTree.activityDate(task.updatedAt) {
            Text(date, format: .relative(presentation: .named, unitsStyle: .wide))
        } else { Text("Update time unavailable") }
    }
}
