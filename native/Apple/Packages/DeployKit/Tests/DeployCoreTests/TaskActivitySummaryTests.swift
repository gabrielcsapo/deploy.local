import Foundation
import Testing
@testable import DeployCore

@Test func activitySummaryRequiresProcessesOrSources() throws {
    let empty = TaskActivitySummary(jobs: [], activity: [])
    #expect(!empty.isVisible)
    let activity = try JSONDecoder().decode([TaskActivity].self, from: Data(#"""
    [{"id":"turn","status":"completed","summary":"Read sources","items":[
      {"id":"a","kind":"read","title":"Read","status":"completed","source":"/app.swift","detail":"","output":"","background":false},
      {"id":"b","kind":"read","title":"Read again","status":"completed","source":"/app.swift","detail":"","output":"","background":false}
    ]}]
    """#.utf8))
    let summary = TaskActivitySummary(jobs: [], activity: activity)
    #expect(summary.isVisible)
    #expect(summary.sources == ["/app.swift"])
    #expect(summary.label == "Activity: 1 source")
}

@Test func activityJobsSortRunningFirstThenNewest() throws {
    let jobs = try JSONDecoder().decode([WorkspaceJob].self, from: Data(#"""
    [
      {"id":"done","status":"succeeded","createdAt":"2026-10-21T10:00:00Z","command":"test","digest":"abc","output":"","truncated":false},
      {"id":"running","status":"running","createdAt":"2026-10-21T09:00:00Z","command":"build","digest":"def","output":"","truncated":false},
      {"id":"queued","status":"queued","createdAt":"2026-10-21T11:00:00Z","command":"lint","digest":"ghi","output":"","truncated":false}
    ]
    """#.utf8))
    #expect(TaskActivitySummary.orderedJobs(jobs).map(\.id) == ["running", "queued", "done"])
    let summary = TaskActivitySummary(jobs: jobs, activity: [])
    #expect(summary.isVisible)
    #expect(summary.runningCount == 1)
    #expect(summary.label == "Activity: 3 processes, 1 running")
}
