#if os(iOS)
import SwiftUI
import DeployCore

struct V2Page<Content: View>: View {
    let title: String
    var action: (() -> Void)? = nil
    var icon = "square.and.pencil"
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text(title).font(.system(size: 28, weight: .semibold)).tracking(-0.7)
                    Spacer()
                    if let action { Button(action: action) { Image(systemName: icon).frame(width: 44, height: 44) }.accessibilityLabel(title == "Work" ? "New message" : "Search") }
                }.padding(.top, 26)
                content
            }.padding(.horizontal, 16).padding(.bottom, 24)
        }.background(WorkspaceStyle.canvas(scheme)).scrollIndicators(.hidden)
    }
}
struct V2Group<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 12) }
            VStack(spacing: 0) { content }
                .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme), lineWidth: 1))
        }
    }
}
struct V2Row: View {
    let title: String
    var subtitle: String? = nil
    var icon = "square.grid.2x2"
    var trailing: String? = nil
    var state: HealthState? = nil
    var attention = false
    var avatar: String? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 12) {
            if let avatar { V2Avatar(name: avatar) }
            else { Image(systemName: attention ? "exclamationmark.circle" : icon).foregroundStyle(attention ? WorkspaceStyle.warning(scheme) : WorkspaceStyle.secondary(scheme)).frame(width: 20) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 17)).foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(2)
                if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).lineLimit(2) }
            }
            Spacer(minLength: 4)
            if let state { V2Status(state: state) }
            else if let trailing { Text(trailing).font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme)) }
        }.padding(.horizontal, 14).padding(.vertical, 12).frame(minHeight: 56).contentShape(Rectangle())
    }
}
struct V2Avatar: View {
    let name: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Text(String(name.prefix(1)).uppercased()).font(.system(size: 12, weight: .semibold))
            .foregroundStyle(name.lowercased() == "warden" ? WorkspaceStyle.success(scheme) : WorkspaceStyle.accent(scheme))
            .frame(width: 26, height: 26)
            .background(name.lowercased() == "warden" ? WorkspaceStyle.success(scheme).opacity(0.1) : WorkspaceStyle.accentSoft(scheme), in: RoundedRectangle(cornerRadius: 6))
    }
}
struct V2Status: View {
    let state: HealthState
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 5, height: 5)
            Text(state.rawValue.capitalized).font(.system(size: 11))
        }.foregroundStyle(WorkspaceStyle.secondary(scheme))
    }
    private var color: Color {
        switch state {
        case .healthy: WorkspaceStyle.success(scheme)
        case .warning: WorkspaceStyle.warning(scheme)
        case .failing: WorkspaceStyle.danger(scheme)
        case .stopped: WorkspaceStyle.tertiary(scheme)
        }
    }
}
struct V2ActionStyle: ButtonStyle {
    var primary = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 17)).frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(primary ? WorkspaceStyle.onAction(scheme) : WorkspaceStyle.text(scheme))
            .background(primary ? WorkspaceStyle.action(scheme) : WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(primary ? .clear : WorkspaceStyle.edge(scheme), lineWidth: 1))
            .opacity(!enabled ? 0.45 : configuration.isPressed ? 0.7 : 1)
    }
}
struct V2Decision: View {
    let item: InboxItem
    @Bindable var store: V2Store
    @State private var confirmation: InboxAction?
    @State private var note = ""
    @Environment(\.colorScheme) private var scheme
    private var current: InboxItem { store.snapshot.inbox.first { $0.id == item.id } ?? item }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: current.state == .waiting ? "exclamationmark.circle" : "checkmark.circle")
                    .foregroundStyle(current.state == .waiting ? WorkspaceStyle.warning(scheme) : WorkspaceStyle.success(scheme))
                VStack(alignment: .leading, spacing: 6) {
                    Text(current.title).font(.system(size: 17, weight: .medium))
                    Text(current.text).font(.system(size: 15)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                }
            }
            if let answer = current.answer {
                Text("\(answer.by) · \(source(answer.on)) · \(formatted(answer.at))")
                    .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                if let note = answer.note { Text(note).font(.system(size: 15)) }
            } else if current.state == .waiting {
                if current.actions.contains(where: { $0.id == "answer" }) {
                    TextField("Your answer", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
                }
                ForEach(current.actions, id: \.id) { action in
                    Button(action.label) {
                        if action.confirm != nil { confirmation = action }
                        else { respond(action) }
                    }.buttonStyle(V2ActionStyle(primary: action.primary == true))
                        .disabled(!store.online || store.busy || (action.id == "answer" && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            } else { Text(current.state.rawValue.capitalized).font(.system(size: 13)).foregroundStyle(.secondary) }
            if store.online, let error = store.error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
        }.padding(16).background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.edge(scheme), style: StrokeStyle(lineWidth: 1, dash: current.answer == nil ? [] : [4, 3])))
            .confirmationDialog(confirmation?.confirm ?? "Confirm", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
                if let action = confirmation { Button(action.label) { respond(action) } }
                Button("Cancel", role: .cancel) { confirmation = nil }
            }
    }
    private func respond(_ action: InboxAction) { Task { await store.answer(current, action: action, note: note.isEmpty ? nil : note) } }
    private func source(_ value: AnswerSource) -> String { value == .iphone ? "This iPhone" : value.rawValue.capitalized }
    private func formatted(_ value: String) -> String { V2Store.date(value)?.formatted(date: .abbreviated, time: .shortened) ?? value }
}
struct V2Empty: View {
    let title: String
    let message: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 17, weight: .medium))
            Text(message).font(.system(size: 15)).foregroundStyle(.secondary)
        }.padding(.vertical, 20).frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
