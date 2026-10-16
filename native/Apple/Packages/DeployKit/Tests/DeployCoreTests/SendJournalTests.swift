import Testing
import Foundation
@testable import DeployCore

private func body(_ id: String = UUID().uuidString, revision: Int = 0, adapter: String = "codex", model: String? = nil) -> SendBody {
    SendBody(operationId: id, revision: revision, content: "Review this code", model: model, effort: nil, adapter: adapter)
}

@Test @MainActor func lostAcknowledgmentSurvivesRelaunchAndRevisionChange() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("pending.json")
    let connection = Connection(origin: "https://deploy.local", username: "alice", token: "first-token")
    let first = try SendJournal(url: url).prepare(connection: connection, taskId: "task", proposed: body("original"))
    // The server accepts this exact operation, but the client loses the response and exits.
    let rotated = Connection(origin: "https://DEPLOY.local:443/", username: "alice", token: "refreshed-token")
    let retry = try SendJournal(url: url).prepare(connection: rotated, taskId: "task", proposed: body("new", revision: 4))
    #expect(retry == first)
    #expect(!String(decoding: try Data(contentsOf: url), as: UTF8.self).contains("token"))
    try SendJournal(url: url).acknowledge(connection: rotated, operationId: retry.operationId)
    let subsequent = try SendJournal(url: url).prepare(connection: rotated, taskId: "task", proposed: body("next", revision: 4))
    #expect(subsequent.operationId == "next")
}

@Test @MainActor func retriesAreScopedToAccountOriginTaskAndProvider() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let journal = SendJournal(url: root.appendingPathComponent("pending.json"))
    let alice = Connection(origin: "https://deploy.local", username: "alice", token: "t")
    _ = try journal.prepare(connection: alice, taskId: "a", proposed: body("original"))
    #expect(try journal.prepare(connection: alice, taskId: "b", proposed: body("other-task")).operationId == "other-task")
    let bob = Connection(origin: alice.origin, username: "bob", token: "t")
    #expect(try journal.prepare(connection: bob, taskId: "a", proposed: body("other-user")).operationId == "other-user")
    let other = Connection(origin: "https://other.local", username: "alice", token: "t")
    #expect(try journal.prepare(connection: other, taskId: "a", proposed: body("other-origin")).operationId == "other-origin")
    #expect(try journal.prepare(connection: alice, taskId: "a", proposed: body("claude", adapter: "claude")).operationId == "claude")
    #expect(try journal.prepare(connection: alice, taskId: "a", proposed: body("model", model: "explicit")).operationId == "model")
    // Navigating to another task/provider never discards the original retry identity.
    #expect(try journal.prepare(connection: alice, taskId: "a", proposed: body("retry", revision: 10)).operationId == "original")
    try journal.acknowledge(connection: bob, operationId: "original")
    #expect(try journal.prepare(connection: alice, taskId: "a", proposed: body()).operationId == "original")
}

@Test @MainActor func corruptOrUnwritableRetryStoragePreventsDispatch() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let connection = Connection(origin: "https://deploy.local", username: "alice", token: "t")
    let file = root.appendingPathComponent("pending.json")
    try Data("broken record".utf8).write(to: file)
    #expect(throws: (any Error).self) { try SendJournal(url: file).prepare(connection: connection, taskId: "t", proposed: body()) }
    #expect(throws: (any Error).self) { try SendJournal(url: file.appendingPathComponent("child")).prepare(connection: connection, taskId: "t", proposed: body()) }
    #expect(String(decoding: try Data(contentsOf: file), as: UTF8.self) == "broken record")
}
