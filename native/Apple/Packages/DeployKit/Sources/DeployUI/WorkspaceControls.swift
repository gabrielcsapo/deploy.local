import SwiftUI

/// Native counterparts of the web `Button` variants. Primary is the one solid violet action on a
/// surface; secondary is quietly bounded; quiet is text-only; danger is reserved for destruction.
/// Tertiary actions use `WorkspaceLinkStyle` instead (docs/design-system.md, Action hierarchy).
struct WorkspaceButtonStyle: ButtonStyle {
    enum Variant { case primary, secondary, quiet, danger }
    var variant: Variant = .secondary
    var expands = false

    func makeBody(configuration: Configuration) -> some View {
        Surface(label: configuration.label, variant: variant, expands: expands, pressed: configuration.isPressed)
    }

    private struct Surface: View {
        let label: Configuration.Label
        let variant: Variant
        let expands: Bool
        let pressed: Bool
        @State private var hovered = false
        @Environment(\.isEnabled) private var enabled
        @Environment(\.colorScheme) private var scheme
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        private var foreground: Color {
            guard enabled else { return WorkspaceStyle.tertiary(scheme) }
            switch variant {
            case .primary: return WorkspaceStyle.onAction(scheme)
            case .secondary: return WorkspaceStyle.text(scheme)
            case .quiet: return WorkspaceStyle.accent(scheme)
            case .danger: return WorkspaceStyle.danger(scheme)
            }
        }
        private var fill: Color {
            switch variant {
            case .primary:
                guard enabled else { return WorkspaceStyle.hover(scheme) }
                return pressed || hovered ? WorkspaceStyle.actionHover(scheme) : WorkspaceStyle.action(scheme)
            case .secondary: return pressed || hovered && enabled ? WorkspaceStyle.hover(scheme) : WorkspaceStyle.surface(scheme)
            case .quiet, .danger: return pressed || hovered && enabled ? WorkspaceStyle.hover(scheme) : .clear
            }
        }
        var body: some View {
            label
                .font(WorkspaceStyle.navigation.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(foreground)
                .padding(.horizontal, variant == .quiet ? 10 : 14)
                .frame(minHeight: WorkspaceStyle.buttonHeight)
                .frame(maxWidth: expands ? .infinity : nil)
                .background(fill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.controlRadius))
                .overlay {
                    if variant == .secondary {
                        RoundedRectangle(cornerRadius: WorkspaceStyle.controlRadius)
                            .strokeBorder(WorkspaceStyle.line(scheme), lineWidth: 1)
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: WorkspaceStyle.controlRadius))
                .scaleEffect(pressed && !reduceMotion ? WorkspaceStyle.Motion.pressedScale : 1)
                .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: pressed)
                .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: hovered)
                #if os(macOS)
                .onHover { hovered = $0 }
                #endif
        }
    }
}

/// A tertiary action as quiet text: Show more, Mark done, Try again, Cancel, Disconnect.
/// Secondary colour at rest; ink and an underline on hover or press, like the Codex app.
/// It never gets a fill or border, so it can't compete with the surface's one primary button.
struct WorkspaceLinkStyle: ButtonStyle {
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        LinkLabel(label: configuration.label, destructive: destructive, pressed: configuration.isPressed)
    }

    private struct LinkLabel: View {
        let label: Configuration.Label
        let destructive: Bool
        let pressed: Bool
        @State private var hovered = false
        @Environment(\.isEnabled) private var enabled
        @Environment(\.colorScheme) private var scheme

        private var foreground: Color {
            guard enabled else { return WorkspaceStyle.tertiary(scheme) }
            if destructive { return WorkspaceStyle.danger(scheme) }
            return hovered || pressed ? WorkspaceStyle.text(scheme) : WorkspaceStyle.secondaryText(scheme)
        }
        var body: some View {
            label
                .font(WorkspaceStyle.navigation.weight(.medium))
                .underline(enabled && (hovered || pressed), color: foreground.opacity(0.6))
                .lineLimit(1)
                .foregroundStyle(foreground)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                #if os(macOS)
                .onHover { hovered = $0 }
                #endif
        }
    }
}

extension ButtonStyle where Self == WorkspaceLinkStyle {
    static var workspaceLink: WorkspaceLinkStyle { WorkspaceLinkStyle() }
    static var workspaceDangerLink: WorkspaceLinkStyle { WorkspaceLinkStyle(destructive: true) }
}

extension ButtonStyle where Self == WorkspaceButtonStyle {
    static var workspacePrimary: WorkspaceButtonStyle { WorkspaceButtonStyle(variant: .primary) }
    static var workspaceSecondary: WorkspaceButtonStyle { WorkspaceButtonStyle(variant: .secondary) }
    static var workspaceQuiet: WorkspaceButtonStyle { WorkspaceButtonStyle(variant: .quiet) }
    static var workspaceDanger: WorkspaceButtonStyle { WorkspaceButtonStyle(variant: .danger) }
}

extension WorkspaceStyle {
    static var buttonHeight: CGFloat {
        #if os(macOS)
        Control.compact
        #else
        Control.touch
        #endif
    }
    static let controlRadius: CGFloat = Control.radius
    static let panelRadius: CGFloat = 14

    /// Map a status tone name ("attention", "healthy", …) to the five semantic status colors.
    static func tone(_ tone: String, _ scheme: ColorScheme) -> Color {
        switch tone {
        case "attention": statusAttention(scheme)
        case "healthy": statusHealthy(scheme)
        case "failed": statusFailed(scheme)
        case "active": statusActive(scheme)
        default: statusInactive(scheme)
        }
    }
}

/// A semantic state pill: dot plus sentence-case label on a soft wash of the status color.
/// Inactive uses a hollow dot, exactly like `StatusBadge`.
struct ReviewStateBadge: View {
    let label: String
    let tone: String
    var glyph: WorkspaceGlyphName? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let color = WorkspaceStyle.tone(tone, scheme)
        HStack(spacing: 6) {
            if let glyph { WorkspaceGlyph(name: glyph, size: 14) }
            else {
                Circle().fill(tone == "inactive" ? Color.clear : color)
                    .overlay(Circle().strokeBorder(color, lineWidth: 1.2)).frame(width: 7, height: 7)
            }
            Text(label).font(.system(.caption, weight: .semibold))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(color.opacity(scheme == .dark ? 0.16 : 0.11), in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(label)")
    }
}

/// A branch name presented as a quiet monospaced token, optionally opening a picker.
struct BranchToken: View {
    let name: String
    var placeholder = "Choose branch"
    var showsChevron = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch").font(.system(.caption, weight: .semibold))
                .foregroundStyle(WorkspaceStyle.secondaryText(scheme)).accessibilityHidden(true)
            Text(name.isEmpty ? placeholder : name)
                .font(.system(.subheadline, design: .monospaced, weight: .medium))
                .foregroundStyle(name.isEmpty ? WorkspaceStyle.tertiary(scheme) : WorkspaceStyle.text(scheme))
                .lineLimit(1).truncationMode(.middle)
            if showsChevron {
                Image(systemName: "chevron.up.chevron.down").font(.system(.caption2, weight: .semibold))
                    .foregroundStyle(WorkspaceStyle.secondaryText(scheme)).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.buttonHeight - 4)
        .background(WorkspaceStyle.raised(scheme), in: RoundedRectangle(cornerRadius: 8))
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// A composer metadata chip (Linear-style): icon, value, and an optional picker affordance.
struct ComposerChip: View {
    let icon: String
    let title: String
    var isSet = true
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(.caption, weight: .semibold)).accessibilityHidden(true)
            Text(title).font(WorkspaceStyle.secondaryAction.weight(.medium)).lineLimit(1)
        }
        .foregroundStyle(isSet ? WorkspaceStyle.text(scheme) : WorkspaceStyle.secondaryText(scheme))
        .padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.buttonHeight - 4)
        .background(Capsule().fill(isSet ? WorkspaceStyle.selected(scheme).opacity(0.65) : Color.clear))
        .overlay(Capsule().strokeBorder(isSet ? Color.clear : WorkspaceStyle.line(scheme), style: StrokeStyle(lineWidth: 1, dash: isSet ? [] : [3, 3])))
        .contentShape(Capsule())
    }
}

/// One bounded surface per screen for the thing a person acts on (composer, merge readiness).
struct ReviewPanel: ViewModifier {
    var emphasized = false
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.panelRadius))
            .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.panelRadius)
                .strokeBorder(emphasized ? WorkspaceStyle.accent(scheme).opacity(0.45) : WorkspaceStyle.line(scheme), lineWidth: 1))
            .shadow(color: .black.opacity(scheme == .dark ? 0.08 : 0.025), radius: 8, x: 0, y: 2)
    }
}

/// Quiet uppercase-free section heading used across review screens.
struct ReviewSectionHeading: View {
    let title: String
    var detail: String? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(WorkspaceStyle.navigation.weight(.semibold)).foregroundStyle(WorkspaceStyle.text(scheme))
            if let detail { Text(detail).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme)) }
            Spacer(minLength: 0)
        }.accessibilityAddTraits(.isHeader)
    }
}

/// "5m ago" style relative time that refreshes each minute.
struct ReviewRelativeTime: View {
    let date: Date
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let elapsed = max(0, context.date.timeIntervalSince(date))
            Text(elapsed < 60 ? "just now" : date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
        }
    }
}

/// The deploy.local mark on its violet tile, matching the app icon and the web lockup.
struct BrandTile: View {
    var size: CGFloat = 44
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        WorkspaceGlyph(name: .brand, size: size * 0.62)
            .foregroundStyle(WorkspaceStyle.onAction(scheme))
            .frame(width: size, height: size)
            .background(WorkspaceStyle.action(scheme), in: RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A text input on the field surface with a violet focus ring, matching the web `Input`.
struct WorkspaceInput: ViewModifier {
    var focused: Bool
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(WorkspaceStyle.body)
            .padding(.horizontal, 12)
            // Same height as the buttons beside it, so a field and its action align.
            .frame(minHeight: WorkspaceStyle.buttonHeight)
            .background(WorkspaceStyle.field(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.controlRadius))
            .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.controlRadius)
                .strokeBorder(focused ? WorkspaceStyle.accent(scheme) : WorkspaceStyle.line(scheme), lineWidth: focused ? 1.5 : 1))
    }
}

/// An inline notice: status glyph, a sentence, and optional actions on a soft wash of the tone.
struct WorkspaceNotice<Actions: View>: View {
    let message: String
    var tone = "attention"
    @ViewBuilder var actions: () -> Actions
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let color = WorkspaceStyle.tone(tone, scheme)
        HStack(alignment: .center, spacing: 10) {
            WorkspaceGlyph(name: .alert, size: 16).foregroundStyle(color).accessibilityHidden(true)
            Text(message).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.text(scheme))
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            actions()
        }
        .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
        .background(color.opacity(scheme == .dark ? 0.12 : 0.09), in: RoundedRectangle(cornerRadius: WorkspaceStyle.controlRadius))
        .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.controlRadius).strokeBorder(color.opacity(0.3), lineWidth: 1))
    }
}

extension WorkspaceNotice where Actions == EmptyView {
    init(message: String, tone: String = "attention") {
        self.init(message: message, tone: tone) { EmptyView() }
    }
}
