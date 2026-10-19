import Foundation
import Testing
@testable import DeployCore

private func treeProject(_ id: String, _ name: String) -> Project {
    Project(id: id, name: name, owner: "owner", sourcePath: nil, repositoryPath: "/repo", createdAt: "2026-01-01T00:00:00Z")
}

private func treeTask(_ id: String, project: String? = nil, title: String = "Task", updated: String) -> WorkspaceTask {
    WorkspaceTask(id: id, projectId: project, workerId: nil, title: title, status: "running", revision: 1,
                  workspacePath: "/workspace", baseRevision: "main", createdAt: updated, updatedAt: updated)
}

@Test func taskTreeOrdersByActivityAndKeepsEmptyAndUnassignedGroups() {
    let projects = [treeProject("z", "Zulu"), treeProject("b", "Beta"), treeProject("a", "Alpha"), treeProject("c", "Charlie")]
    let tasks = [
        treeTask("old", project: "a", updated: "2026-10-01T12:00:00Z"),
        treeTask("independent", updated: "2026-10-19T12:00:00Z"),
        treeTask("new", project: "b", updated: "2026-10-02T12:00:00.100Z"),
        treeTask("orphan", project: "missing", updated: "2026-10-18T12:00:00Z"),
        treeTask("newer", project: "b", updated: "2026-10-02T10:00:00-04:00")
    ]
    let tree = TaskTree(projects: projects, tasks: tasks)
    #expect(tree.groups.map(\.name) == ["Beta", "Alpha", "Charlie", "Zulu", "No project"])
    #expect(tree.groups[0].tasks.map(\.id) == ["newer", "new"])
    #expect(tree.groups[2].tasks.isEmpty)
    #expect(tree.groups.last?.tasks.map(\.id) == ["independent", "orphan"])
    #expect(!tree.isSearching)
}

@Test func taskTreeSearchMatchesTitlesAndProjectNamesWithoutChangingSource() {
    let projects = [treeProject("a", "Deploy"), treeProject("b", "Website"), treeProject("c", "Empty")]
    let tasks = [
        treeTask("a1", project: "a", title: "Fix sidebar", updated: "2026-10-19T12:00:00Z"),
        treeTask("a2", project: "a", title: "Ship", updated: "2026-10-18T12:00:00Z"),
        treeTask("b1", project: "b", title: "Fix search", updated: "2026-10-17T12:00:00Z"),
        treeTask("free", title: "FIX a bug", updated: "2026-10-16T12:00:00Z")
    ]
    let titles = TaskTree(projects: projects, tasks: tasks, search: "fIX")
    #expect(titles.isSearching)
    #expect(titles.groups.map(\.name) == ["Deploy", "Website", "No project"])
    #expect(titles.groups.flatMap(\.tasks).map(\.id) == ["a1", "b1", "free"])
    let name = TaskTree(projects: projects, tasks: tasks, search: "dEPloY")
    #expect(name.groups.map(\.name) == ["Deploy"])
    #expect(name.groups[0].tasks.map(\.id) == ["a1", "a2"])
    #expect(TaskTree(projects: projects, tasks: tasks, search: "EMPTY").groups.first?.tasks.isEmpty == true)
    #expect(TaskTree(projects: projects, tasks: tasks, search: "absent").groups.isEmpty)
    #expect(TaskTree(projects: [], tasks: []).groups.isEmpty)
    #expect(TaskTree(projects: projects, tasks: tasks).groups.flatMap(\.tasks).count == tasks.count)
}
