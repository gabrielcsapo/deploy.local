#if os(macOS)
import SwiftUI
import DeployCore

/// A movable surface inside the conversation. It never creates an OS window.
struct FloatingComputerViewer: View {
    let store: WorkspaceStore
    @Binding var isPresented: Bool
    @State private var expanded = false
    @State private var aspectRatio: CGFloat = 1.4
    @State private var origin: CGPoint?
    @State private var translation = CGSize.zero

    private func clamp(_ point: CGPoint, in size: CGSize, panel: CGSize) -> CGPoint {
        CGPoint(x: min(max(12, point.x), max(12, size.width - panel.width - 12)),
                y: min(max(12, point.y), max(12, size.height - panel.height - 12)))
    }

    var body: some View {
        GeometryReader { geometry in
            let width = min(expanded ? 760 : 380, max(0, geometry.size.width - 24), max(0, geometry.size.height - 24) * aspectRatio)
            let size = CGSize(width: width, height: width / aspectRatio)
            let base = origin ?? CGPoint(x: geometry.size.width - size.width - 16, y: 58)
            let position = expanded
                ? CGPoint(x: (geometry.size.width - size.width) / 2, y: (geometry.size.height - size.height) / 2)
                : clamp(CGPoint(x: base.x + translation.width, y: base.y + translation.height), in: geometry.size, panel: size)
            BrowserPanel(store: store, onReveal: { isPresented = true }, onClose: { isPresented = false },
                         onAspectRatioChange: { aspectRatio = max(0.2, min(5, $0)) },
                         onExpansionChange: { expanded = $0 },
                         onDragChanged: { if !expanded { translation = $0 } },
                         onDragEnded: { delta in
                             if !expanded { origin = clamp(CGPoint(x: base.x + delta.width, y: base.y + delta.height), in: geometry.size, panel: size) }
                             translation = .zero
                         })
                .id(store.selectedTaskId)
                .frame(width: size.width, height: size.height)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.08)))
                .shadow(color: .black.opacity(0.22), radius: 22, y: 8)
                .offset(x: position.x, y: position.y)
                .opacity(isPresented ? 1 : 0)
                .allowsHitTesting(isPresented)
                .accessibilityHidden(!isPresented)
        }.clipped()
    }
}
#endif
