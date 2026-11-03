import SwiftUI

/// DiceBear Glyphs by Matt Houser, CC BY 4.0; generated vector paths, no JavaScript.
public struct AgentAvatar: View {
    public let glyph: String
    public let color: String
    public let size: CGFloat
    @Environment(\.colorScheme) private var scheme
    public init(glyph: String, color: String, size: CGFloat = 30) { self.glyph = glyph; self.color = color; self.size = size }
    public static func tint(_ hex: String) -> Color {
        let rgb = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x8c8c8c
        return Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
    public var body: some View {
        Canvas { context, bounds in
            context.scaleBy(x: bounds.width / 72, y: bounds.height / 72)
            let tint = Self.tint(color)
            let base = Path(CGRect(x: 0, y: 0, width: 72, height: 72))
            context.fill(base, with: .color(WorkspaceStyle.surface(scheme)))
            context.fill(base, with: .color(tint.opacity(0.2)))
            var glyphContext = context
            AgentGlyphPaths.draw(glyph, in: &glyphContext, tint: tint)
            let shoulders = Path(ellipseIn: CGRect(x: 36 - 43.31, y: 103.72 - 50, width: 86.62, height: 100))
            context.fill(shoulders, with: .color(tint))
            context.fill(shoulders, with: .color(.black.opacity(0.5)))
        }.frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
    }
}
