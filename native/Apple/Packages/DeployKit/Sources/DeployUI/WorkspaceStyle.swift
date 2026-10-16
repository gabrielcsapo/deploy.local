import SwiftUI

/// Shared optical sizes keep navigation and context controls on the same grid.
enum WorkspaceStyle {
    static func canvas(_ scheme: ColorScheme) -> Color { scheme == .dark ? Color(white: 0.094) : Color(white: 0.99) }
    static func sidebar(_ scheme: ColorScheme) -> Color { scheme == .dark ? Color(white: 0.133) : Color(white: 0.96) }
    static func rail(_ scheme: ColorScheme) -> Color { scheme == .dark ? Color(white: 0.19) : Color(white: 0.93) }
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
        Image(systemName: name)
            .font(.system(size: 15, weight: .regular))
            .frame(width: WorkspaceStyle.iconWidth, height: WorkspaceStyle.iconWidth)
            .accessibilityHidden(true)
    }
}

/// Consistent send affordance even while a model popover is active.
struct WorkspaceSendStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.controlSize)
            .foregroundStyle(isEnabled ? Color.white : Color.secondary.opacity(0.55))
            .background(isEnabled ? Color(red: 0.20, green: 0.47, blue: 0.96) : Color.primary.opacity(0.06), in: Circle())
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Circle())
    }
}
