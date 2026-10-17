import SwiftUI

/// Native counterparts of app/design-tokens.json: quiet surfaces, violet actions and semantic status.
enum WorkspaceStyle {
    private static func color(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 255) / 255,
              green: Double((value >> 8) & 255) / 255,
              blue: Double(value & 255) / 255)
    }
    static func canvas(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x0d0b13 : 0xfbf9fd) }
    static func surface(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x1d1926 : 0xffffff) }
    static func line(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x322b3d : 0xe0d6e9) }
    static func sidebar(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x15121c : 0xf3eff8) }
    static func rail(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x100e16 : 0xebe4f2) }
    static func accent(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc9adf1 : 0x70439a) }
    static func secondaryText(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc0b8cd : 0x5f516c) }
    static func action(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xb79bdd : 0x74459f) }
    static func onAction(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x21152e : 0xffffff) }
    static func userMessage(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x2b2039 : 0xeee3f8) }
    static func success(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xa0deb8 : 0x21643f) }
    static func warning(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xf2cd91 : 0x7d4b09) }
    static func danger(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xffb3ba : 0xa72633) }

    /// Motion communicates an action; polling and streaming updates stay still.
    enum Motion {
        static func fast(reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : .timingCurve(0.2, 0, 0, 1, duration: 0.12)
        }
        static func standard(reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : .timingCurve(0.2, 0, 0, 1, duration: 0.18)
        }
        static let pressedScale: CGFloat = 0.98
    }
    static let contentWidth: CGFloat = 760
    static let iconWidth: CGFloat = 18
    static var projectHeadingHeight: CGFloat {
        #if os(macOS)
        20
        #else
        44
        #endif
    }
    static var projectDisclosureWidth: CGFloat {
        #if os(macOS)
        24
        #else
        44
        #endif
    }
    static var projectHeaderInset: CGFloat {
        #if os(macOS)
        0
        #else
        10
        #endif
    }
    static var projectChildInset: CGFloat {
        #if os(macOS)
        40
        #else
        26
        #endif
    }
    static var conversationGutter: CGFloat {
        #if os(macOS)
        24
        #else
        16
        #endif
    }
    static var messageInset: CGFloat {
        #if os(macOS)
        16
        #else
        0
        #endif
    }
    static var controlSize: CGFloat {
        #if os(macOS)
        36
        #else
        44
        #endif
    }
    static var secondaryAction: Font {
        #if os(macOS)
        .system(size: 12)
        #else
        .subheadline
        #endif
    }
    static var navigation: Font {
        #if os(macOS)
        .system(size: 14)
        #else
        .system(.callout)
        #endif
    }
    static var project: Font {
        #if os(macOS)
        .system(size: 14, weight: .medium)
        #else
        .body.weight(.medium)
        #endif
    }
    static var metadata: Font {
        #if os(macOS)
        .system(size: 12)
        #else
        .caption
        #endif
    }
    static var body: Font {
        #if os(macOS)
        .system(size: 16)
        #else
        .body
        #endif
    }
    static var rowHeight: CGFloat {
        #if os(macOS)
        30
        #else
        46
        #endif
    }
}

/// Raised controls sit above a quiet canvas; messages and navigation stay unboxed.
struct WorkspaceSurface: ViewModifier {
    var radius: CGFloat = 24
    var elevated = true
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius)
                .stroke(Color.primary.opacity(colorScheme == .dark ? 0.14 : 0.08), lineWidth: 0.5))
            .shadow(color: .black.opacity(elevated ? (colorScheme == .dark ? 0.18 : 0.065) : 0.025), radius: elevated ? 12 : 3, x: 0, y: elevated ? 4 : 1)
            .shadow(color: .black.opacity(0.04), radius: 2, x: 0, y: 1)
    }
}

struct WorkspaceMenuLabel: View {
    let title: String
    var symbol: String? = nil
    var body: some View {
        HStack(spacing: 6) {
            if let symbol { WorkspaceSymbol(name: symbol) }
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .medium))
        }.font(WorkspaceStyle.navigation).contentShape(Rectangle())
    }
}

struct WorkspaceMenuStyle: ViewModifier {
    func body(content: Content) -> some View {
        #if os(macOS)
        content.menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        #else
        content.buttonStyle(.plain)
        #endif
    }
}

struct WorkspaceSymbol: View {
    let name: String
    var body: some View {
        Group {
            if let glyph = productGlyph {
                WorkspaceGlyph(name: glyph, size: 18)
            } else {
                Image(systemName: name).font(.system(size: 15, weight: .regular))
            }
        }.frame(width: WorkspaceStyle.iconWidth, height: WorkspaceStyle.iconWidth)
            .accessibilityHidden(true)
    }
    private var productGlyph: WorkspaceGlyphName? {
        switch name {
        case "folder", "folder.fill": .folder
        case "square.and.pencil": .compose
        case "magnifyingglass": .search
        case "gearshape": .settings
        default: nil
        }
    }
}

/// Consistent send affordance even while a model popover is active.
struct WorkspaceSendStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.controlSize)
            .foregroundStyle(isEnabled ? WorkspaceStyle.onAction(colorScheme) : Color.secondary.opacity(0.55))
            .background(isEnabled ? WorkspaceStyle.action(colorScheme) : Color.primary.opacity(0.06), in: Circle())
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? WorkspaceStyle.Motion.pressedScale : 1)
            .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: configuration.isPressed)
            .contentShape(Circle())
    }
}

/// The prompt is the only raised work surface; viewers remain on the canvas.
struct WorkspacePromptSurface: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(WorkspaceStyle.line(scheme), lineWidth: 1))
            .shadow(color: .black.opacity(scheme == .dark ? 0.08 : 0.025), radius: 8, x: 0, y: 2)
    }
}
