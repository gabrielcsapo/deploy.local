import SwiftUI

extension WorkspaceStyle {
    /// Toolbar actions share one optical size and target; color signals open panels.
    enum Toolbar {
        static let spacing: CGFloat = 6
        static let radius: CGFloat = 8
        #if os(macOS)
        static let iconSize: CGFloat = 16
        static let targetSize: CGFloat = 32
        #else
        static let iconSize: CGFloat = 18
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
                .foregroundStyle(selected ? WorkspaceStyle.accent(scheme) : WorkspaceStyle.secondaryText(scheme))
                .background {
                    RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius)
                        .fill(selected ? WorkspaceStyle.accent(scheme).opacity(pressed ? 0.22 : 0.12)
                              : Color.primary.opacity(pressed ? 0.10 : hovered && enabled ? 0.06 : 0))
                }
                .contentShape(RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
                .opacity(enabled ? 1 : 0.35)
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
