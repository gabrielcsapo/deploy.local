import Foundation

public enum InteractionLayout {
    public static func splitWidth(_ saved: Double) -> Double { saved.isFinite ? min(720, max(320, saved)) : 400 }
    public static func activityMode(_ saved: String) -> String { saved == "open" ? "open" : "closed" }
    public static func taskCardWidth(pane: Double, reading: Double) -> Double? {
        let margin = (pane - reading) / 2
        return margin >= 240 ? min(260, margin - 24) : nil
    }
    public static func taskHasProjectSelection(index: Int?, expanded: Bool, searching: Bool, showAll: Bool) -> Bool {
        guard let index else { return false }
        return (searching || expanded) && (searching || showAll || index < 5)
    }
    public static func composerActivityVisible(card: Bool, mode: String, running: Int, failing: Int) -> Bool {
        !card && mode == "closed" && (running > 0 || failing > 0)
    }
    /// A panel that drops from a button at the trailing end of a pane whose trailing edge is the
    /// window's. A popover is centered on its anchor, so one anchored on a trailing button would
    /// hang past that edge; this narrows the panel and slides the anchor left, by at most half
    /// the button so its arrow still points at the button. `offset` is in button coordinates.
    public static func trailingPanel(pane: Double, buttonX: Double, buttonWidth: Double,
                                     ideal: Double = 400, minimum: Double = 280, margin: Double = 12)
        -> (width: Double, offset: Double) {
        guard pane.isFinite, buttonX.isFinite, buttonWidth > 0, pane > 2 * margin else { return (ideal, 0) }
        let ceiling = min(ideal, pane - 2 * margin)
        let center = buttonX + buttonWidth / 2
        let slide = min(buttonWidth / 2, max(0, center + ceiling / 2 - (pane - margin)))
        let anchor = center - slide
        // The widest panel this anchor can hold between both margins. A button closer to the
        // edge than half the minimum keeps that minimum and lets the window clamp the rest.
        let fits = 2 * min(anchor - margin, pane - margin - anchor)
        return (max(min(ceiling, minimum), min(ceiling, fits)), -slide)
    }
}
