import SwiftUI
#if os(macOS)
import AppKit
#endif

struct MediaViewerPresentation {
    var content: (@escaping () -> Void) -> AnyView
    var restoreFocus: () -> Void
}
private struct OpenMediaViewerKey: EnvironmentKey {
    static let defaultValue: (@MainActor @Sendable (MediaViewerPresentation) -> Void)? = nil
}
extension EnvironmentValues {
    var openMediaViewer: (@MainActor @Sendable (MediaViewerPresentation) -> Void)? {
        get { self[OpenMediaViewerKey.self] }
        set { self[OpenMediaViewerKey.self] = newValue }
    }
}

/// Owns the modal at the workspace boundary, rather than at a transcript thumbnail.
struct MediaViewerHost: ViewModifier {
    @State private var presentation: MediaViewerPresentation?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content
            .disabled(presentation != nil)
            .accessibilityHidden(presentation != nil)
            .environment(\.openMediaViewer, { request in
                withAnimation(WorkspaceStyle.Motion.enter(reduceMotion: reduceMotion)) { presentation = request }
            })
            .overlay {
                if let presentation {
                    ZStack {
                        WorkspaceStyle.overlay(scheme).ignoresSafeArea().onTapGesture { close() }
                            .accessibilityHidden(true)
                        presentation.content(close)
                            .clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
                            .padding(WorkspaceStyle.space4)
                            .accessibilityAddTraits(.isModal)
                    }
                    .transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: WorkspaceStyle.Motion.enterScale)))
                }
            }
    }
    private func close() {
        let restore = presentation?.restoreFocus
        presentation = nil
        // Return focus after SwiftUI has re-enabled the transcript.
        Task { @MainActor in await Task.yield(); restore?() }
    }
}

#if os(macOS)
/// Observe wheel gestures only inside this media viewport and its owning window.
/// Vertical wheel motion zooms; a horizontal trackpad gesture pages once per gesture.
struct MediaWheelInput: NSViewRepresentable {
    @Binding var zoom: Double
    var step: (Int) -> Void
    func makeNSView(context: Context) -> WheelView { WheelView() }
    func updateNSView(_ view: WheelView, context: Context) {
        view.zoom = $zoom; view.step = step
    }
    static func dismantleNSView(_ view: WheelView, coordinator: ()) { view.stop() }
    final class WheelView: NSView {
        var zoom: Binding<Double>?
        var step: ((Int) -> Void)?
        private var monitor: Any?
        private var horizontal: CGFloat = 0
        private var paged = false
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self, let window = self.window, event.window === window,
                      self.bounds.contains(self.convert(event.locationInWindow, from: nil)) else { return event }
                if event.phase == .began { self.horizontal = 0; self.paged = false }
                if abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY), self.zoom?.wrappedValue == 1 {
                    self.horizontal += event.scrollingDeltaX
                    if abs(self.horizontal) > WorkspaceStyle.space8, !self.paged {
                        self.paged = true; self.step?(self.horizontal < 0 ? 1 : -1)
                    }
                    return nil
                }
                if event.momentumPhase.isEmpty, !self.paged, let zoom = self.zoom {
                    zoom.wrappedValue = min(5, max(1, zoom.wrappedValue * exp(Double(event.scrollingDeltaY) / 300)))
                }
                return nil
            }
        }
        func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
    }
}
#endif
