import Foundation
import Testing
@testable import DeployCore

private func run(_ id: String, adapter: String = "codex", model: String?, effort: String?, status: String = "running") -> Run {
    Run(id: id, taskId: "t1", adapter: adapter, model: model, effort: effort, status: status, sessionId: nil,
        createdAt: "2026-10-24T00:51:05Z", updatedAt: "2026-10-24T00:51:05Z", error: nil)
}

@Test func composerAdoptsTheLatestRunWhenATaskOpens() {
    let next = latestRunSettings(taskId: "t1", runs: [run("r0", model: nil, effort: nil), run("r1", model: "gpt-6.1-sol", effort: "high")], adopted: nil)
    #expect(next?.settings == ComposerSettings(adapter: "codex", model: "gpt-6.1-sol", effort: "high"))
    #expect(next?.adopted == "t1:r1")
}

@Test func runFinishingOrPollingKeepsThePersonsPick() {
    // The same run, now finished, was already adopted: nothing replaces a later pick.
    #expect(latestRunSettings(taskId: "t1", runs: [run("r1", model: "gpt-6.1-sol", effort: "high", status: "succeeded")], adopted: "t1:r1") == nil)
}

@Test func aNewRunBecomesTheComposerDefault() {
    let runs = [run("r1", model: "gpt-6.1-sol", effort: "high"), run("r2", adapter: "claude", model: "opus", effort: nil)]
    #expect(latestRunSettings(taskId: "t1", runs: runs, adopted: "t1:r1")?.settings == ComposerSettings(adapter: "claude", model: "opus", effort: ""))
    // Opening another task re-adopts even when its run id happens to match.
    #expect(latestRunSettings(taskId: "t2", runs: runs, adopted: "t1:r2") != nil)
}

@Test func aTaskWithoutRunsKeepsTheComposerAsItIs() {
    #expect(latestRunSettings(taskId: "t1", runs: [], adopted: nil) == nil)
}
