import Foundation

public enum InteractionLayout {
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
}
