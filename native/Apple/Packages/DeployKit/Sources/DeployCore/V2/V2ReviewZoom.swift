import Foundation

/// How far a design review screen can zoom out on iPhone.
public enum V2ReviewZoom {
    /// The zoom at which the whole width of a screen is in view. A 1440 pt web screen in a 390 pt
    /// window fits at about 0.27; a phone screen is already its own width, so it stays at 1.
    public static func fit(content: Double, viewport: Double) -> Double {
        guard content > 0, viewport > 0 else { return 1 }
        return min(1, viewport / content)
    }
}
