import SwiftUI
#if os(iOS)
import UIKit
#endif

extension WorkspaceStyle {
    /// Toolbar actions share one optical size and target; color signals open panels.
    enum Toolbar {
        static let spacing: CGFloat = WorkspaceStyle.IconAction.gap
        static let radius: CGFloat = 8
        #if os(macOS)
        static let iconSize: CGFloat = WorkspaceStyle.IconAction.standardGlyph
        static let targetSize: CGFloat = 32
        #else
        static let iconSize: CGFloat = WorkspaceStyle.IconAction.touchGlyph
        static let targetSize: CGFloat = 44
        #endif
    }
}

struct WorkspaceToolbarIcon: View {
    let title: String
    let icon: WorkspaceGlyphName
    init(_ title: String, icon: WorkspaceGlyphName) { self.title = title; self.icon = icon }
    var body: some View {
        Label { Text(title) } icon: {
            WorkspaceGlyph(name: icon, size: WorkspaceStyle.Toolbar.iconSize)
        }.labelStyle(.iconOnly)
            .accessibilityLabel(title)
            .frame(width: WorkspaceStyle.Toolbar.targetSize, height: WorkspaceStyle.Toolbar.targetSize)
    }
}

struct WorkspaceToolbarButtonStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        ToolbarButtonSurface(label: configuration.label, selected: selected, pressed: configuration.isPressed)
    }

    private struct ToolbarButtonSurface: View {
        let label: Configuration.Label
        let selected: Bool
        let pressed: Bool
        @State private var hovered = false
        @Environment(\.isEnabled) private var enabled
        @Environment(\.colorScheme) private var scheme
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        var body: some View {
            label
                .foregroundStyle(!enabled ? WorkspaceStyle.tertiary(scheme) : selected || pressed ? WorkspaceStyle.accent(scheme) : WorkspaceStyle.secondaryText(scheme))
                .background {
                    RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius)
                        .fill((selected || pressed) && enabled ? WorkspaceStyle.selected(scheme)
                              : (pressed || hovered && enabled ? WorkspaceStyle.hover(scheme) : Color.clear))
                }
                .contentShape(RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))

                .scaleEffect(pressed && !reduceMotion ? WorkspaceStyle.Motion.pressedScale : 1)
                .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: pressed)
                .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: hovered)
                .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: selected)
                .onHover { hovered = $0 }
        }
    }
}

extension ToolbarContent {
    /// Let the title bar breathe instead of wrapping unrelated actions in glass.
    @ToolbarContentBuilder func workspaceToolbarChrome() -> some ToolbarContent {
        if #available(macOS 26, iOS 26, *) { sharedBackgroundVisibility(.hidden) }
        else { self }
    }
}

/// Color and fill use the same status classification; only inactive dots are hollow.
struct PhoneStatusDot: View {
    let status: String
    var size: CGFloat = 6
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let color = WorkspaceStyle.phoneStatusColor(status, scheme)
        Circle().fill(WorkspaceStyle.phoneStatusTone(status) == .inactive ? Color.clear : color)
            .overlay(Circle().strokeBorder(color, lineWidth: 1))
            .frame(width: size, height: size).accessibilityHidden(true)
    }
}

struct TaskRelativeTime: View {
    let date: Date
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let elapsed = max(0, context.date.timeIntervalSince(date))
            let compact = elapsed < 60 ? "now" : elapsed < 3_600 ? "\(Int(elapsed / 60))m"
                : elapsed < 86_400 ? "\(Int(elapsed / 3_600))h" : elapsed < 604_800 ? "\(Int(elapsed / 86_400))d" : "\(Int(elapsed / 604_800))w"
            Text(compact).monospacedDigit().accessibilityLabel(Text(date, format: .relative(presentation: .named, unitsStyle: .wide)))
        }
    }
}

#if os(iOS)
/// Show eight identifying characters; copying always uses the complete value.
struct PhoneIdentifier: View {
    let title: String
    let value: String
    static func abbreviated(_ value: String) -> String {
        value.count > 8 ? String(value.prefix(4)) + "…" + String(value.suffix(4)) : value
    }
    var body: some View {
        Text("\(title) \(Self.abbreviated(value))").font(.caption.monospaced()).foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.middle)
            .accessibilityLabel("\(title): \(value)")
            .contextMenu { Button("Copy \(title.lowercased())") { UIPasteboard.general.string = value } }
    }
}

struct PhoneActivityDisclosure: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    func body(content: Content) -> some View {
        if horizontalSizeClass == .compact { content.disclosureGroupStyle(PhoneActivityDisclosureStyle()) }
        else { content }
    }
}

/// The disclosure indicator belongs to the label, rather than the row's trailing edge.
struct PhoneActivityDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { configuration.isExpanded.toggle() } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    configuration.label
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right").font(.caption)
                }.frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
                .accessibilityHint("Double tap to \(configuration.isExpanded ? "collapse" : "expand") activity")
            if configuration.isExpanded { configuration.content }
        }
    }
}
#endif
