import SwiftUI

/// Native counterparts of app/design-tokens.json: v2 surfaces, neutral actions and semantic status.
enum WorkspaceStyle {
    private static func color(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 255) / 255,
              green: Double((value >> 8) & 255) / 255,
              blue: Double(value & 255) / 255)
    }
    // BEGIN GENERATED TOKENS
    static func canvas(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x18171b : 0xfafafb) }
    static func sidebar(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x141317 : 0xf6f6f8) }
    static func rail(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x100e16 : 0xebe4f2) }
    static func surface(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x211f25 : 0xffffff) }
    static func raised(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x25202f : 0xf8f4fc) }
    static func field(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x211c2b : 0xf0eaf6) }
    static func hover(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x292333 : 0xede5f5) }
    static func selected(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x2f2c34 : 0xebeaee) }
    static func text(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xf3f2f5 : 0x1c1b1f) }
    static func secondary(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc5c1cc : 0x55525b) }
    static func tertiary(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x9a95a3 : 0x67636f) }
    static func line(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x2e2c33 : 0xe8e7eb) }
    static func edge(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x403d46 : 0xd6d4db) }
    static func accent(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc9adf1 : 0x6a3fc4) }
    static func accentSoft(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x2d2539 : 0xefe9fa) }
    static func success(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xa0deb8 : 0x1f6b43) }
    static func warning(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xf2cd91 : 0x8a5208) }
    static func danger(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xffb3ba : 0xb42318) }
    static func action(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xebe9ef : 0x232127) }
    static func onAction(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x1e1c21 : 0xffffff) }
    static func actionHover(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc8afe8 : 0x63388c) }
    static func chartPrimary(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xb1cdff : 0x245aa6) }
    static func chartSecondary(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x9ddbcf : 0x17665f) }
    static func chartTertiary(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xd2befa : 0x6b469f) }
    static func chartReference(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc8d2e1 : 0x536176) }
    static func focus(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x77727f : 0x8a8692) }
    static func active(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x9cc0ff : 0x2f5bb7) }
    static func secondaryText(_ scheme: ColorScheme) -> Color { secondary(scheme) }
    static func userMessage(_ scheme: ColorScheme) -> Color { selected(scheme) }
    enum Space {
        static let `step1`: CGFloat = 4
        static let `step2`: CGFloat = 8
        static let `step3`: CGFloat = 12
        static let `step4`: CGFloat = 16
        static let `step5`: CGFloat = 20
        static let `step6`: CGFloat = 24
        static let `step8`: CGFloat = 32
        static let `step10`: CGFloat = 40
        static let `step12`: CGFloat = 48
    }
    enum Typography {
        static let `display`: CGFloat = 26
        static let `title`: CGFloat = 22
        static let `section`: CGFloat = 15
        static let `body`: CGFloat = 15
        static let `conversation`: CGFloat = 15
        static let `meta`: CGFloat = 12
        static let `caption`: CGFloat = 11
        static let `phoneBody`: CGFloat = 17
        static let `navigation`: CGFloat = 13
        static let `reply`: CGFloat = 16
        static let `ui`: CGFloat = 13
        static let `code`: CGFloat = 12
    }
    enum Size {
        static let `desktopControl`: CGFloat = 36
        static let `touchControl`: CGFloat = 44
        static let `rail`: CGFloat = 52
        static let `sidebar`: CGFloat = 256
        static let `readingWidth`: CGFloat = 768
        static let `taskDetails`: CGFloat = 218
        static let `locationBar`: CGFloat = 52
        static let `navigationRow`: CGFloat = 40
        static let `repositoryTree`: CGFloat = 200
        static let `dialog`: CGFloat = 520
        static let `inspectorDialog`: CGFloat = 440
        static let `popover`: CGFloat = 260
        static let `overlayRow`: CGFloat = 38
        static let `workspaceInset`: CGFloat = 24
        static let `compactInset`: CGFloat = 16
        static let `workToolbar`: CGFloat = 56
        static let `touchToolbar`: CGFloat = 56
        static let `compactControl`: CGFloat = 32
        static let `sidebarMin`: CGFloat = 180
        static let `sidebarMax`: CGFloat = 420
        static let `workPaneMin`: CGFloat = 360
        static let `resizeTarget`: CGFloat = 8
        static let `tableDialog`: CGFloat = 880
        static let `tableMinimum`: CGFloat = 720
        static let `resourceRow`: CGFloat = 56
        static let `resourceHeader`: CGFloat = 44
        static let `rowPadding`: CGFloat = 12
        static let `sectionGap`: CGFloat = 32
        static let `header`: CGFloat = 48
        static let `page`: CGFloat = 960
        static let `panel`: CGFloat = 320
    }
    enum Form {
        static let `height`: CGFloat = 36
        static let `touchHeight`: CGFloat = 44
        static let `radius`: CGFloat = 6
        static let `paddingInline`: CGFloat = 12
        static let `fontSize`: CGFloat = 13
        static let `touchFontSize`: CGFloat = 16
        static let `labelGap`: CGFloat = 6
        static let `helperSize`: CGFloat = 12
        static let `focusWidth`: CGFloat = 2
        static let `focusOffset`: CGFloat = 2
        static let `textareaMinHeight`: CGFloat = 96
    }
    enum Radius {
        static let `control`: CGFloat = 8
        static let `card`: CGFloat = 12
        static let `dialog`: CGFloat = 16
        static let `composer`: CGFloat = 18
        static let `full`: CGFloat = 999
    }
    // END GENERATED TOKENS

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
