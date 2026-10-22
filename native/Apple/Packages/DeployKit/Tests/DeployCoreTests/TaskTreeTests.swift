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

@Test func idleProjectsUseThirtyDayBoundaryAndLatestActivity() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let boundary = now.addingTimeInterval(-30 * 24 * 60 * 60)
    let task = treeTask("old", updated: boundary.ISO8601Format())
    #expect(TaskTree.isIdle([task], now: now))
    #expect(!TaskTree.isIdle([task], now: now.addingTimeInterval(-1)))
    #expect(TaskTree.isIdle([], now: now))
    #expect(!TaskTree.isIdle([task, treeTask("new", updated: now.ISO8601Format())], now: now))
}

@Test func sidebarPinsStayLocalToAccountAndCoordinator() {
    let suite = "deploy-sidebar-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let alice = SidebarPreferences(origin: "https://one.local", account: "alice", defaults: defaults)
    let bob = SidebarPreferences(origin: "https://one.local", account: "bob", defaults: defaults)
    let other = SidebarPreferences(origin: "https://two.local", account: "alice", defaults: defaults)
    #expect(alice.toggle("task") == ["task"])
    #expect(SidebarPreferences(origin: "https://one.local", account: "alice", defaults: defaults).pins == ["task"])
    #expect(bob.pins.isEmpty)
    #expect(other.pins.isEmpty)
    #expect(alice.toggle("task").isEmpty)
}

@Test func minimapExtractsOnlyUserPromptsAndFirstLines() {
    let messages = [
        Message(id: "first", taskId: "task", role: "user", content: "First line\nSecond line", createdAt: "", runId: nil, isProgress: nil),
        Message(id: "reply", taskId: "task", role: "assistant", content: "Reply", createdAt: "", runId: nil, isProgress: nil),
        Message(id: "second", taskId: "task", role: "user", content: String(repeating: "x", count: 80), createdAt: "", runId: nil, isProgress: nil)
    ]
    let turns = TranscriptTurn.extract(messages)
    #expect(turns.map(\.id) == ["first", "second"])
    #expect(turns[0].excerpt == "First line")
    #expect(turns[1].excerpt.count == 60)
}
