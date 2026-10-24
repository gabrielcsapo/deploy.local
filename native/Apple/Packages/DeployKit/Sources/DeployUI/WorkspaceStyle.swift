import SwiftUI

/// Native counterparts of app/design-tokens.json: quiet surfaces, violet actions and semantic status.
enum WorkspaceStyle {
    private static func color(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 255) / 255,
              green: Double((value >> 8) & 255) / 255,
              blue: Double(value & 255) / 255)
    }
    static func canvas(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x121116 : 0xf7f6f9) }
    static func sidebar(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x19181e : 0xefeef3) }
    static func rail(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x19181e : 0xefeef3) }
    static func surface(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x212027 : 0xffffff) }
    static func raised(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x2a2931 : 0xf3f2f6) }
    static func field(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x212027 : 0xffffff) }
    static func hover(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x26252c : 0xecebf1) }
    static func selected(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x34313d : 0xe5d9f5) }
    static func line(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x34323c : 0xdedce4) }
    static func edge(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x5a5764 : 0x797581) }
    static func text(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xf8f6fc : 0x1f1b27) }
    static func tertiary(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xb4adbf : 0x615a6c) }
    static func accent(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc9adf1 : 0x70439a) }
    static func accentHover(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xd7c3f4 : 0x63388c) }
    static func action(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x7c52d6 : 0x6a3fc4) }
    static func actionHover(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x875cde : 0x5c32b2) }
    static func onAction(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xffffff : 0xffffff) }
    static func statusActive(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xb1cdff : 0x245aa6) }
    static func statusAttention(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xf2cd91 : 0x7d4b09) }
    static func statusHealthy(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xa0deb8 : 0x21643f) }
    static func statusFailed(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xffb3ba : 0xa72633) }
    static func statusInactive(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xb4adbf : 0x615a6c) }
    static func success(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xa0deb8 : 0x21643f) }
    static func warning(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xf2cd91 : 0x7d4b09) }
    static func danger(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xffb3ba : 0xa72633) }
    static func secondaryText(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0xc8c3d0 : 0x514b5c) }
    static func userMessage(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x34313d : 0xe5d9f5) }

    static func shadow(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? 0x000000 : 0x000000) }
    static let overlayOpacity = 0.6
    static func overlay(_ scheme: ColorScheme) -> Color { shadow(scheme).opacity(overlayOpacity) }

    /// Motion communicates an action; polling and streaming updates stay still.
    static let skeletonRowHeight: CGFloat = 52
    static let minimapMinimumWidth: CGFloat = 640
    static let minimapMaximumHeight: CGFloat = 320
    enum Motion {
        static func shimmer(reduceMotion: Bool) -> Animation? { reduceMotion ? nil : .linear(duration: 1.6).repeatForever(autoreverses: false) }
        static func fast(reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : .timingCurve(0.2, 0, 0, 1, duration: 0.12)
        }
        static func standard(reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : .timingCurve(0.2, 0, 0, 1, duration: 0.18)
        }
        static func enter(reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: 0.22)
        }
        static let enterScale: CGFloat = 0.985
        static let pressedScale: CGFloat = 0.98
    }
    static let endedFrameOpacity = 0.4
    static let display = Font.system(.title, design: .default).weight(.regular)
    static let resourceRowHeight: CGFloat = 56
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let space6: CGFloat = 24
    static let space8: CGFloat = 32
    static let radius: CGFloat = 6
    static let mediaThumbnailWidth: CGFloat = 180
    static let mediaThumbnailHeight: CGFloat = 120
    static let mediaStripWidth: CGFloat = 96
    static let mediaStripHeight: CGFloat = 72
    static let markupFine: CGFloat = 2
    static let markupMedium: CGFloat = 4
    static let markupBroad: CGFloat = 8
    static let markupLabelSize: CGFloat = 17
    static let mediaViewerWidth: CGFloat = 800
    static let mediaViewerHeight: CGFloat = 600
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
        .system(.footnote)
        #else
        .subheadline
        #endif
    }
    static var navigation: Font {
        #if os(macOS)
        .system(.subheadline)
        #else
        .system(.callout)
        #endif
    }
    static var project: Font {
        #if os(macOS)
        .system(.subheadline, weight: .medium)
        #else
        .body.weight(.medium)
        #endif
    }
    static var metadata: Font {
        #if os(macOS)
        .system(.footnote)
        #else
        .caption
        #endif
    }
    static var body: Font {
        #if os(macOS)
        .system(.body)
        #else
        .body
        #endif
    }
    static var taskNavigationHeight: CGFloat {
        #if os(macOS)
        IconAction.standard
        #else
        IconAction.touch
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
            .background(elevated ? WorkspaceStyle.raised(colorScheme) : WorkspaceStyle.surface(colorScheme), in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius)
                .stroke(WorkspaceStyle.line(colorScheme), lineWidth: 0.5))
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
            Image(systemName: "chevron.down").font(.system(.caption, weight: .medium))
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
                Image(systemName: name).font(.system(.body, weight: .regular))
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
            .foregroundStyle(isEnabled ? WorkspaceStyle.onAction(colorScheme) : WorkspaceStyle.tertiary(colorScheme))
            .background(isEnabled ? WorkspaceStyle.action(colorScheme) : WorkspaceStyle.hover(colorScheme), in: Circle())
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
            // The composer floats above the transcript: a soft ambient lift plus a tight contact shadow.
            .shadow(color: .black.opacity(scheme == .dark ? 0.38 : 0.09), radius: 18, x: 0, y: 8)
            .shadow(color: .black.opacity(scheme == .dark ? 0.22 : 0.05), radius: 2, x: 0, y: 1)
    }
}

extension WorkspaceStyle {
    enum PhoneStatusTone { case attention, healthy, failed, active, inactive }

    static func phoneStatusTone(_ status: String) -> PhoneStatusTone {
        switch status {
        case "review", "ready", "blocked", "waiting", "waiting_for_answer": .attention
        case "succeeded", "completed", "done", "merged", "online", "healthy": .healthy
        case "failed", "error": .failed
        case "running", "checking", "queued", "starting", "in_review": .active
        default: .inactive
        }
    }

    static func phoneStatusColor(_ status: String, _ scheme: ColorScheme) -> Color {
        switch phoneStatusTone(status) {
        case .attention: statusAttention(scheme)
        case .healthy: statusHealthy(scheme)
        case .failed: statusFailed(scheme)
        case .active: statusActive(scheme)
        case .inactive: statusInactive(scheme)
        }
    }
}

extension WorkspaceStyle {
    /// Bounded control scale shared with the web (`size.compactControl`, `size.touchControl`,
    /// `form.radius`). Buttons, inputs and pickers on one row use the same height and radius.
    enum Control {
        static let compact: CGFloat = 32
        static let touch: CGFloat = 44
        static let radius: CGFloat = 6
    }
    enum IconAction {
        static let compact: CGFloat = 28
        static let standard: CGFloat = 32
        static let touch: CGFloat = 44
        static let compactGlyph: CGFloat = 14
        static let standardGlyph: CGFloat = 16
        static let touchGlyph: CGFloat = 18
        static let gap: CGFloat = 2
    }
}

/// Attached to the prompt; existing tasks provide labels, new tasks provide pickers.
struct WorkspaceContextTray<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        content.frame(maxWidth: .infinity, alignment: .leading)
            .font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            .padding(.horizontal, WorkspaceStyle.space4).padding(.vertical, WorkspaceStyle.space2)
            .background(WorkspaceStyle.sidebar(scheme), in: UnevenRoundedRectangle(topLeadingRadius: WorkspaceStyle.space4, topTrailingRadius: WorkspaceStyle.space4))
            .overlay(alignment: .bottom) { Rectangle().fill(WorkspaceStyle.line(scheme)).frame(height: 1) }
    }
}

extension View {
    /// Resting cards beside the conversation, one step below the composer (the web's
    /// `--ds-shadow-card`): a contact shadow plus a soft ambient one, and in dark mode a
    /// top-edge highlight, since shadows barely read on dark canvases.
    func cardElevation(_ scheme: ColorScheme, cornerRadius: CGFloat) -> some View {
        let dark = scheme == .dark
        return overlay {
            RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(WorkspaceStyle.line(scheme).opacity(0.6), lineWidth: 1)
        }
        .overlay {
            if dark {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(LinearGradient(colors: [WorkspaceStyle.text(scheme).opacity(0.1), .clear], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.08)), lineWidth: 1)
            }
        }
        .shadow(color: .black.opacity(dark ? 0.35 : 0.06), radius: 1, x: 0, y: 1)
        .shadow(color: .black.opacity(dark ? 0.36 : 0.11), radius: 12, x: 0, y: 8)
    }
}
