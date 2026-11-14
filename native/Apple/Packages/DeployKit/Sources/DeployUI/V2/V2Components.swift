#if os(iOS)
import SwiftUI
import DeployCore

struct V2Page<Content: View>: View {
    let title: String
    var action: (() -> Void)? = nil
    var icon = "square.and.pencil"
    /// Search, in the leading corner of the page's top row.
    var search: (() -> Void)? = nil
    var loading: [V2LoadState]? = nil
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let loading {
                    HStack {
                        if let search { Button(action: search) { Image(systemName: "magnifyingglass").font(.system(size: 20)).frame(width: 44, height: 44) }.accessibilityLabel("Search") }
                        else { Color.clear.frame(width: 44, height: 44) }
                        Spacer(minLength: 0)
                        V2LoadingHeader(states: loading)
                        Spacer(minLength: 0)
                        if let action { Button(action: action) { Image(systemName: icon).frame(width: 44, height: 44) }.accessibilityLabel(title == "Work" ? "New message" : "Search") }
                        else { Color.clear.frame(width: 44, height: 44) }
                    }
                }
                HStack {
                    Text(title).font(.system(size: 28, weight: .semibold)).tracking(-0.7)
                    Spacer()
                    if loading == nil, let action { Button(action: action) { Image(systemName: icon).frame(width: 44, height: 44) }.accessibilityLabel(title == "Work" ? "New message" : "Search") }
                }.padding(.top, loading == nil ? 26 : 0)
                content
            }.padding(.horizontal, 16).padding(.bottom, 24)
        }.background(WorkspaceStyle.canvas(scheme)).scrollIndicators(.hidden)
    }
}
struct V2Group<Content: View>: View {
    var title: String? = nil
    var compact = false
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 8) {
            if let title { Text(title).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, compact ? 16 : 12) }
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
    var identity: V2AgentAvatar? = nil
    var chevron = false
    var compact = false
    var pendingSubtitle = false
    var titleHealth: V2AppPresentation.ProjectHealth? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 12) {
            if let identity { AgentAvatar(glyph: identity.glyph, color: identity.color, size: 30) } else if let avatar { V2Avatar(name: avatar, size: compact ? 32 : 26) }
            else { Image(systemName: attention ? "exclamationmark.circle" : icon).foregroundStyle(attention ? WorkspaceStyle.warning(scheme) : WorkspaceStyle.secondary(scheme)).frame(width: 20) }
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(title).font(.system(size: 17)).foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(2)
                    if let titleHealth {
                        Spacer(minLength: 4)
                        V2Status(state: titleHealth.state, label: titleHealth.label)
                    }
                }
                if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).lineLimit(2) }
                else if pendingSubtitle { V2Skeleton(width: 130, height: 9).frame(height: 18) }
            }.multilineTextAlignment(.leading)
            Spacer(minLength: 4)
            if let state { V2Status(state: state) }
            else if let trailing { Text(trailing).font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme)) }
            if chevron {
                Image(systemName: "chevron.right").font(.system(size: 13))
                    .foregroundStyle(WorkspaceStyle.tertiary(scheme)).accessibilityHidden(true)
            }
        }.padding(.horizontal, compact ? 16 : 14).padding(.vertical, compact ? 6 : 12)
            .frame(minHeight: compact ? 44 : 56).contentShape(Rectangle())
    }
}
/// The roomier Settings board has its own spacing, without changing other lists.
struct V2SettingsGroup<Content: View>: View {
    var list = false
    var title: String? = nil
    var note: String? = nil
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title).font(.system(size: 13)).frame(minHeight: 18)
                    .foregroundStyle(WorkspaceStyle.tertiary(scheme))
                    .padding(.horizontal, 16).accessibilityAddTraits(.isHeader)
            }
            V2Group { content }
            if let note { Text(note).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 16) }
        }.padding(.top, title == nil ? 0 : list ? 20 : 28)
    }
}

struct V2SettingsRow<Accessory: View>: View {
    var list = false
    let title: String
    var monoTitle = false
    var subtitle: String? = nil
    var icon: String? = "square.grid.2x2"
    var glyph: WorkspaceGlyphName? = nil
    var avatar: String? = nil
    var identity: V2AgentAvatar? = nil
    var attention = false
    @ViewBuilder var accessory: Accessory
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 14) {
            if attention {
                Image(systemName: "exclamationmark.circle").font(.system(size: 18))
                    .foregroundStyle(WorkspaceStyle.warning(scheme)).accessibilityHidden(true)
            } else if let identity { AgentAvatar(glyph: identity.glyph, color: identity.color) } else if let avatar {
                Text(String(avatar.prefix(1)).uppercased()).font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .background(WorkspaceStyle.selected(scheme), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityHidden(true)
            } else if let glyph {
                WorkspaceGlyph(name: glyph, size: 18).frame(width: 30, height: 30)
                    .background(WorkspaceStyle.line(scheme).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
            } else if let icon {
                Image(systemName: icon).font(.system(size: 18))
                    .frame(width: 30, height: 30)
                    .background(WorkspaceStyle.line(scheme).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(monoTitle ? .system(size: 15, weight: .medium, design: .monospaced) : .system(size: list || identity != nil || avatar != nil ? 17 : 16, weight: avatar == nil ? .medium : .semibold))
                    .frame(minHeight: 22, alignment: .leading)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        .frame(minHeight: 18, alignment: .leading)
                }
            }.lineLimit(list && identity == nil ? nil : 1).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
            accessory
        }.foregroundStyle(WorkspaceStyle.text(scheme))
            .padding(.horizontal, 16).padding(.vertical, avatar == nil ? 10 : 12)
            .frame(minHeight: list ? (subtitle == nil ? 52 : 64) : (avatar == nil ? 56 : 72)).contentShape(Rectangle())
    }
}

struct V2SettingsChevron: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Image(systemName: "chevron.right").font(.system(size: 13))
            .frame(width: 16, height: 16)
            .foregroundStyle(WorkspaceStyle.tertiary(scheme)).accessibilityHidden(true)
    }
}

struct V2Avatar: View {
    let name: String
    var size: CGFloat = 26
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Text(String(name.prefix(1)).uppercased()).font(.system(size: 12, weight: .semibold))
            .foregroundStyle(name.lowercased() == "warden" ? WorkspaceStyle.success(scheme) : WorkspaceStyle.accent(scheme))
            .frame(width: size, height: size)
            .background(name.lowercased() == "warden" ? WorkspaceStyle.success(scheme).opacity(0.1) : WorkspaceStyle.accentSoft(scheme), in: RoundedRectangle(cornerRadius: size > 26 ? 8 : 6))
    }
}
struct V2Status: View {
    let state: HealthState
    var label: String? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 5, height: 5)
            Text(label ?? state.rawValue.capitalized).font(.system(size: 11))
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
    var inSheet = false
    @State private var confirmation: InboxAction?
    @State private var note = ""
    @Environment(\.colorScheme) private var scheme
    private var current: InboxItem { store.snapshot.inbox.first { $0.id == item.id } ?? item }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if current.kind == .question && current.state == .waiting {
                V2QuestionDecision(item: current, store: store, note: $note) { action in
                    if action.confirm != nil { confirmation = action }
                    else { respond(action) }
                }
            } else {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: current.state == .waiting ? "exclamationmark.circle" : "checkmark.circle")
                        .foregroundStyle(current.state == .waiting ? WorkspaceStyle.warning(scheme) : WorkspaceStyle.success(scheme))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(current.title).font(.system(size: 17, weight: .medium))
                        Text(current.text).font(.system(size: 15)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                    }
                }
                if let answer = current.answer {
                    Text("\(V2Labels.outcome(current)) · \(answer.by) · \(source(answer.on)) · \(formatted(answer.at))")
                        .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                    if let note = answer.note { Text(note).font(.system(size: 15)) }
                    if current.kind == .rollback, let project = current.projectId, V2Labels.outcome(current) == "Approved" { V2ProjectRollback(store: store, project: project) }
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
            }
            if store.online, let error = store.error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
        }.padding(inSheet ? 0 : 16).background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.edge(scheme), style: StrokeStyle(lineWidth: inSheet ? 0 : 1, dash: current.answer == nil ? [] : [4, 3])))
            .confirmationDialog(confirmation?.confirm ?? "Confirm", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
                if let action = confirmation { Button(action.label) { respond(action) } }
                Button("Cancel", role: .cancel) { confirmation = nil }
            }
    }
    private func respond(_ action: InboxAction) { Task { await store.answer(current, action: action, note: note.isEmpty ? nil : note) } }
    private func source(_ value: AnswerSource) -> String { value == .iphone ? "This iPhone" : value.rawValue.capitalized }
    private func formatted(_ value: String) -> String { V2Labels.shortDate(value) }
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
/// Explicit contrast avoids inherited foreground styles hiding primary button labels.
struct V2PrimaryButtonStyle: ButtonStyle {
    var inline = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: inline ? 13 : 17, weight: .medium))
            .foregroundStyle(WorkspaceStyle.surface(scheme))
            .padding(.horizontal, inline ? 12 : 16)
            .frame(maxWidth: inline ? nil : .infinity, minHeight: 44)
            .background(WorkspaceStyle.text(scheme), in: RoundedRectangle(cornerRadius: 10))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.35)
    }
}

struct V2AgentHeader: View {
    let agent: V2Agent
    var body: some View {
        HStack(spacing: 8) {
            AgentAvatar(glyph: agent.identity.glyph, color: agent.identity.color, size: 28)
            Text(agent.name).font(.system(size: 17, weight: .semibold)).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 12))
        }.foregroundStyle(.primary)
    }
}
#endif
