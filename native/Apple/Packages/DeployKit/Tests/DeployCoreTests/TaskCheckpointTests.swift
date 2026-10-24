import Foundation
import Testing
@testable import DeployCore

@Test func checkpointSummaryDecodesFreshAndStaleOffers() throws {
    let fresh = try JSONDecoder().decode(TaskCheckpointSummary.self, from: Data(#"{"id":"checkpoint","createdAt":"2026-10-23T12:05:00.000Z","fileCount":43,"fresh":true,"reason":null}"#.utf8))
    #expect(fresh.fresh)
    #expect(fresh.id == "checkpoint")
    #expect(fresh.publishCaption.hasPrefix("Captured "))
    #expect(fresh.publishCaption.hasSuffix(" · 43 files · the full change set"))
    let stale = try JSONDecoder().decode(TaskCheckpointSummary.self, from: Data(#"{"id":"checkpoint","createdAt":"2026-10-23T12:05:00Z","fileCount":43,"fresh":false,"reason":"Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step"}"#.utf8))
    #expect(!stale.fresh)
    #expect(stale.reason == "Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step")
}
