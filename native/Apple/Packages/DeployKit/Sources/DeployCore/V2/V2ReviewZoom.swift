import Foundation

/// How far a design review screen can zoom out on iPhone.
public enum V2ReviewZoom {
    /// The zoom at which the whole width of a screen is in view. A 1440 pt web screen in a 390 pt
    /// window fits at about 0.27; a phone screen is already its own width, so it stays at 1.
    public static func fit(content: Double, viewport: Double) -> Double {
        guard content > 0, viewport > 0 else { return 1 }
        return min(1, viewport / content)
    }

    /// A swipe moves to the next screen when there is nothing sideways to look at instead: the screen
    /// is zoomed all the way out, or it is still where it opened. Scrolling a fitted screen up and
    /// down does not take that away.
    public static func passesPaging(zoom: Double, minimum: Double, whereItOpened: Bool) -> Bool {
        whereItOpened || zoom <= minimum + 0.01
    }

    /// The zoom to keep when the window changes size, as on rotation. A screen that was fitted stays
    /// fitted at the new size; anything else keeps its zoom, raised to the new smallest if needed.
    public static func afterResize(zoom: Double, oldMinimum: Double, newMinimum: Double) -> Double {
        if oldMinimum < 0.999, zoom <= oldMinimum + 0.01 { return newMinimum }
        return max(zoom, newMinimum)
    }

    /// Where a screen smaller than the window sits: in the middle, not against the top-left corner.
    public static func centred(content: Double, viewport: Double) -> Double {
        max(0, (viewport - content) / 2)
    }
}
