import Foundation

public enum V2DesignComparison {
    public static let modeKey = "deploy.design.compareMode"
    public static func percent(_ value: Double) -> Double { min(100, max(0, value.rounded())) }
    /// Moving the divider left reveals more After.
    public static func after(at x: Double, width: Double) -> Double {
        width > 0 ? percent(100 * (1 - x / width)) : 50
    }
}
