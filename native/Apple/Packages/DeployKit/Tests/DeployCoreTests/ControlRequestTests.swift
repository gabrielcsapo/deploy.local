import Foundation
import Testing
@testable import DeployCore

private let base = #""id":"t","projectId":null,"workerId":"w","title":"Task","status":"running","revision":3,"workspacePath":"/w","baseRevision":"abc","createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z""#

@Test func tasksDecodeAPendingControlRequestAndNeedApproval() throws {
    let request = #""controlRequest":{"id":"r","kind":"browser","targetLabel":"Task browser","workerName":"SER","record":false,"expiresAt":1792509999000}"#
    let task = try JSONDecoder().decode(WorkspaceTask.self, from: Data("{\(base),\(request)}".utf8))
    #expect(task.needsApproval)
    #expect(task.controlRequest?.targetLabel == "Task browser")
    let plain = try JSONDecoder().decode(WorkspaceTask.self, from: Data("{\(base),\"controlRequest\":null}".utf8))
    #expect(!plain.needsApproval)
}
