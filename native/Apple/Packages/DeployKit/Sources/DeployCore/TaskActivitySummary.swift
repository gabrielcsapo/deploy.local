import Foundation

/// Counts and ordering shared by the conversation shortcut and activity inspector.
public struct TaskActivitySummary: Equatable, Sendable {
    public let processCount: Int
    public let runningCount: Int
    public let sources: [String]
    public var isVisible: Bool { processCount > 0 || !sources.isEmpty }
    public var label: String { "Activity: \(processCount) processes, \(runningCount) running, \(sources.count) sources" }
    public var text: String { "\(processCount) processes · \(runningCount) running · \(sources.count) sources" }

    public init(jobs: [WorkspaceJob], activity: [TaskActivity]) {
        processCount = jobs.count
        runningCount = jobs.filter { $0.status == "running" }.count
        sources = Array(Set(activity.flatMap(\.items).compactMap(\.source).filter { !$0.isEmpty })).sorted()
    }

    public static func orderedJobs(_ jobs: [WorkspaceJob]) -> [WorkspaceJob] {
        jobs.sorted {
            if ($0.status == "running") != ($1.status == "running") { return $0.status == "running" }
            if $0.createdAt != $1.createdAt { return ($0.createdAt ?? "") > ($1.createdAt ?? "") }
            return $0.id < $1.id
        }
    }
}
