import Foundation
import Testing
@testable import DeployCore

@Test func baseUpdateReportsConflictsAndRecovery() throws {
    let update = try JSONDecoder().decode(BaseUpdate.self, from: Data(#"{"status":"conflicted","targetBranch":"release","conflicts":["App.swift"],"error":null}"#.utf8))
    #expect(update.pending)
    #expect(!update.running)
    #expect(update.caption == "Resolve conflicts: App.swift")
    let running = try JSONDecoder().decode(BaseUpdate.self, from: Data(#"{"status":"prepared","targetBranch":"main","conflicts":[],"error":null}"#.utf8))
    #expect(running.running)
    let aborted = try JSONDecoder().decode(BaseUpdate.self, from: Data(#"{"status":"aborted","targetBranch":"main","conflicts":[],"error":null}"#.utf8))
    #expect(!aborted.pending)
    #expect(aborted.caption == "Update aborted; workspace restored.")
}
