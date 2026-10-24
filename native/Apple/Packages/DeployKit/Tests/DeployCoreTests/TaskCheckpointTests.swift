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

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(type, from: Data(json.utf8)) }
private let mergedPullJSON = #"{"id":"pr-1","number":1,"title":"Build the app","status":"merged","sourceBranch":"task/abcd1234","targetBranch":"main","createdAt":"2026-10-23T11:00:00Z","mergedAt":"2026-10-23T12:00:00Z","mergedCommit":"c41dde0"}"#
private let pendingDiffJSON = #"{"baseRevision":"c41dde0","headRevision":"5b0a8c6","patch":"","status":"Remote workspace changes have not been uploaded since the commit; waiting for the worker to refresh","files":[],"checks":[],"baselinePending":true}"#

@Test func mergedTaskWithoutNewWorkShowsHistoryAndNoPublish() throws {
    let merged = try decode(ProjectWorkItem.self, mergedPullJSON)
    let checkpoint = try decode(TaskCheckpointSummary.self, #"{"id":"c","createdAt":"2026-10-23T11:55:00Z","fileCount":55,"changedFileCount":0,"fresh":true,"reason":null}"#)
    let state = TaskPublishState(taskStatus: "merged", workspaceStatus: "ready", pulls: [merged], latestCheckpoint: checkpoint,
                                 diff: try decode(TaskDiff.self, pendingDiffJSON), working: false, busy: false)
    #expect(state.merged)
    #expect(state.pull?.id == "pr-1")
    #expect(!state.offersPublish)
    #expect(state.checkpoint == nil)
    #expect(state.reason == "No changes since #1 merged.")
}

@Test func newWorkAfterMergeOffersFollowUpFromFreshCheckpoint() throws {
    let merged = try decode(ProjectWorkItem.self, mergedPullJSON)
    let checkpoint = try decode(TaskCheckpointSummary.self, #"{"id":"c2","createdAt":"2026-10-24T02:39:14.699Z","fileCount":55,"changedFileCount":4,"fresh":true,"reason":null}"#)
    let state = TaskPublishState(taskStatus: "review", workspaceStatus: "ready", pulls: [merged], latestCheckpoint: checkpoint,
                                 diff: try decode(TaskDiff.self, pendingDiffJSON), working: false, busy: false)
    #expect(state.followUp)
    #expect(state.offersPublish)
    #expect(state.open == nil)
    #expect(state.checkpoint?.id == "c2")
    #expect(state.action == "Publish follow-up")
    #expect(!state.unavailable)
    #expect(state.reason?.hasSuffix(" · 4 files · since #1 merged") == true)
    // An older coordinator without changed counts: a checkpoint from after the merge is new work.
    let legacy = try decode(TaskCheckpointSummary.self, #"{"id":"c3","createdAt":"2026-10-24T02:39:14.699Z","fileCount":55,"fresh":true,"reason":null}"#)
    let older = TaskPublishState(taskStatus: "review", workspaceStatus: "ready", pulls: [merged], latestCheckpoint: legacy,
                                 diff: try decode(TaskDiff.self, pendingDiffJSON), working: false, busy: false)
    #expect(older.followUp)
    // Once the follow-up is open, it updates like any pull request.
    let followUp = try decode(ProjectWorkItem.self, #"{"id":"pr-2","number":2,"title":"Settings","status":"open","sourceBranch":"task/abcd1234","targetBranch":"main","createdAt":"2026-10-24T03:00:00Z"}"#)
    let complete = try decode(TaskDiff.self, #"{"baseRevision":"c41dde0","headRevision":"c41dde0","patch":"diff --git a/s b/s","status":"","files":[],"checks":[],"hasUnpublishedChanges":true}"#)
    let open = TaskPublishState(taskStatus: "review", workspaceStatus: "ready", pulls: [merged, followUp], latestCheckpoint: nil,
                                diff: complete, working: false, busy: false)
    #expect(open.pull?.id == "pr-2")
    #expect(!open.merged)
    #expect(open.action == "Update pull request")
}
