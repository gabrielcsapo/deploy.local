import Foundation

/// The same project/thread hierarchy feeds every native navigation layout.
public struct TaskTree: Sendable {
    public struct Group: Identifiable, Sendable {
        public let project: Project?
        public let tasks: [WorkspaceTask]
        public var id: String { project.map { "project:\($0.id)" } ?? "no-project" }
        public var name: String { project?.name ?? "No project" }
    }

    public let groups: [Group]
    public let isSearching: Bool

    public init(projects: [Project], tasks: [WorkspaceTask], search: String = "") {
        isSearching = !search.isEmpty
        let projectIDs = Set(projects.map(\.id))
        let dates = Dictionary(tasks.map { ($0.id, Self.activityDate($0.updatedAt) ?? .distantPast) }, uniquingKeysWith: { first, _ in first })
        let ordered = tasks.sorted {
            let left = dates[$0.id] ?? .distantPast, right = dates[$1.id] ?? .distantPast
            return left == right ? $0.id < $1.id : left > right
        }
        let byProject = Dictionary(grouping: ordered, by: \.projectId)
        var all = projects.map { Group(project: $0, tasks: byProject[$0.id] ?? []) }
        all.sort {
            if $0.tasks.isEmpty != $1.tasks.isEmpty { return !$0.tasks.isEmpty }
            let left = $0.tasks.first.flatMap { dates[$0.id] }, right = $1.tasks.first.flatMap { dates[$0.id] }
            if left != right { return (left ?? .distantPast) > (right ?? .distantPast) }
            let comparison = $0.name.localizedCaseInsensitiveCompare($1.name)
            return comparison == .orderedSame ? $0.id < $1.id : comparison == .orderedAscending
        }
        // Keep tasks visible even if their project is no longer in the summary.
        let unassigned = ordered.filter { $0.projectId.map(projectIDs.contains) != true }
        if !unassigned.isEmpty { all.append(Group(project: nil, tasks: unassigned)) }
        groups = search.isEmpty ? all : all.compactMap { group in
            let projectMatches = group.name.localizedCaseInsensitiveContains(search)
            let matches = group.tasks.filter { projectMatches || $0.title.localizedCaseInsensitiveContains(search) }
            guard projectMatches || !matches.isEmpty else { return nil }
            return Group(project: group.project, tasks: matches)
        }
    }

    public static func activityDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
