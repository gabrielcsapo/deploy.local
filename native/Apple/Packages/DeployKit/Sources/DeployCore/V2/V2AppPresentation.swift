import Foundation

public enum V2AppPresentation {
    public struct ProjectHealth: Equatable, Sendable {
        public let state: HealthState
        public let label: String
    }

    public static func projectID(for app: V2LiveApp) -> String {
        app.project ?? "app:\(app.name)"
    }

    /// Summarize the same states Live already received, without introducing new checks.
    public static func health(_ apps: [V2LiveApp]) -> ProjectHealth? {
        guard !apps.isEmpty else { return nil }
        let failing = apps.filter { $0.state == .failing }.count
        if failing > 0 { return ProjectHealth(state: .failing, label: "\(failing) failing") }
        if let warning = apps.first(where: { $0.state == .warning }) {
            let memory = warning.summary.range(of: #"memory|% of \d+(?:\.\d+)? GB"#, options: [.regularExpression, .caseInsensitive]) != nil
            let label = memory ? "High memory" : warning.summary.contains("baseline") ? "Learning baseline" : warning.summary.contains("overdue") ? "Report overdue" : warning.summary.contains("waiting") ? "Queue delayed" : "Checks unavailable"
            return ProjectHealth(state: .warning, label: label)
        }
        if apps.allSatisfy({ $0.state == .stopped }) { return ProjectHealth(state: .stopped, label: "Not running") }
        return ProjectHealth(state: .healthy, label: "Healthy")
    }
}
