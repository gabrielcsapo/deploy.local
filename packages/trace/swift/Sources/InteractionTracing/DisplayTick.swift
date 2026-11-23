#if canImport(UIKit)
  import SwiftUI
  import UIKit

  extension View {
    /// From SwiftUI observing the named view to the next display callback. Pass nil for a hidden view.
    public func traceDisplayTick(
      _ name: String?, start: @escaping @MainActor (String) -> Interaction?
    ) -> some View {
      modifier(DisplayTickModifier(name: name, start: start))
    }
  }

  private struct DisplayTickModifier: ViewModifier {
    let name: String?
    let start: @MainActor (String) -> Interaction?
    @Environment(\.scenePhase) private var phase
    @State private var pending: DisplayTick?

    func body(content: Content) -> some View {
      let visible = phase == .background ? nil : name
      content.onChange(of: visible, initial: true) { _, name in
        pending?.cancel()
        pending = name.flatMap { start($0) }.map(DisplayTick.init)
      }.onDisappear {
        pending?.cancel()
        pending = nil
      }
    }
  }

  @MainActor private final class DisplayTick: NSObject {
    private var link: CADisplayLink?
    private var interaction: Interaction?

    init(_ interaction: Interaction) {
      self.interaction = interaction
      super.init()
      let link = CADisplayLink(target: self, selector: #selector(tick))
      self.link = link
      link.add(to: .main, forMode: .common)
    }

    @objc private func tick() { finish("screen.display_tick", outcome: "ok") }
    func cancel() { finish("navigation.left", outcome: "cancelled") }

    private func finish(_ milestone: String, outcome: String) {
      link?.invalidate()
      link = nil
      interaction?.finish(milestone, outcome: outcome)
      interaction = nil
    }
  }
#endif
