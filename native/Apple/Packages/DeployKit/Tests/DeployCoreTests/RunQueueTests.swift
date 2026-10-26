import Testing
import Foundation
@testable import DeployCore

@Test func queuedRunDecodesReasonPositionAndEligibleComputers() throws {
    let data = Data(#"{"id":"r","taskId":"t","adapter":"codex","status":"queued","createdAt":"","updatedAt":"","queue":{"reason":"Waiting for bazzite — busy with Build bricks","position":2,"total":3,"alternatives":[{"id":"mac","name":"MacBook Pro"}]}}"#.utf8)
    let run = try JSONDecoder().decode(Run.self, from: data)
    #expect(run.isActive)
    #expect(run.queue?.detail == "Waiting for bazzite — busy with Build bricks · Position 2 of 3")
    #expect(run.queue?.alternatives.first?.id == "mac")
}

@Test func queuedTaskAndPendingAnswerOutrankReview() throws {
    let data = Data(#"{"id":"t","title":"Build","status":"queued","revision":1,"workspacePath":"","baseRevision":"","createdAt":"","updatedAt":"","pull":{"id":"pr","number":1,"status":"open"},"waitingForAnswer":false}"#.utf8)
    var task = try JSONDecoder().decode(WorkspaceTask.self, from: data)
    #expect(task.displayStatus == "queued")
    task.waitingForAnswer = true
    #expect(task.displayStatus == "waiting")
}

@Test func busyComputerNoticeUsesRecordedLoadAndOlderModelsStillDecode() throws {
    let data = Data(#"{"id":"b","name":"bazzite","platform":"linux","architecture":"x64","status":"online","capabilities":["codex"],"activeTaskCount":1,"queuedTaskCount":2}"#.utf8)
    let worker = try JSONDecoder().decode(Worker.self, from: data)
    #expect(worker.busyNotice == "bazzite is busy with 1 task — this will wait")
    let oldRun = try JSONDecoder().decode(Run.self, from: Data(#"{"id":"r","taskId":"t","adapter":"codex","status":"running","createdAt":"","updatedAt":""}"#.utf8))
    #expect(oldRun.queue == nil)
}
