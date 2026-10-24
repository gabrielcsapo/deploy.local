import Foundation
import Testing
@testable import DeployCore

@Test func pullPatchRecoversChangedFilesAndCounts() {
    let patch = """
    diff --git a/web/server.js b/web/server.js
    index 1111111..2222222 100644
    --- a/web/server.js
    +++ b/web/server.js
    @@ -1,2 +1,3 @@
     const a = 1
    -const b = 2
    +const b = 3
    +const c = 4
    diff --git a/docs/new dir/notes.md b/docs/new dir/notes.md
    new file mode 100644
    index 0000000..3333333
    --- /dev/null
    +++ b/docs/new dir/notes.md
    @@ -0,0 +1 @@
    +hello
    diff --git a/old.txt b/old.txt
    deleted file mode 100644
    index 4444444..0000000
    --- a/old.txt
    +++ /dev/null
    @@ -1 +0,0 @@
    -bye
    diff --git a/from.txt b/to.txt
    similarity index 100%
    rename from from.txt
    rename to to.txt
    """
    let files = changedFiles(fromPatch: patch)
    #expect(files.map(\.path) == ["web/server.js", "docs/new dir/notes.md", "old.txt", "to.txt"])
    #expect(files.map(\.status) == ["M", "A", "D", "R"])
    #expect(files.map { changedFileLabel($0.status) } == ["Modified", "Added", "Deleted", "Renamed"])
    let patches = reviewFilePatches(patch, files: files)
    #expect(patches.first { $0.path == "web/server.js" }.map { [$0.additions, $0.deletions] } == [2, 1])
    #expect(patches.first { $0.path == "docs/new dir/notes.md" }?.additions == 1)
    #expect(patches.first { $0.path == "old.txt" }?.deletions == 1)
}

@Test func emptyPullPatchHasNoFiles() {
    #expect(changedFiles(fromPatch: "").isEmpty)
}

@Test func checkSummaryUsesNewestRunForTheHeadCommit() {
    let head = String(repeating: "a", count: 40), old = String(repeating: "b", count: 40)
    let failedOld = ProjectWorkItem(id: "1", status: "failed", commit: old, createdAt: "2026-10-19T10:00:00.000Z")
    let passed = ProjectWorkItem(id: "2", status: "succeeded", commit: head, createdAt: "2026-10-19T11:00:00.000Z")
    let running = ProjectWorkItem(id: "3", status: "running", commit: head, createdAt: "2026-10-19T12:00:00.000Z")
    let failed = ProjectWorkItem(id: "4", status: "failed", commit: head, createdAt: "2026-10-19T12:30:00.000Z")
    #expect(checkSummary(runs: [], headCommit: head) == .none)
    #expect(checkSummary(runs: [failedOld], headCommit: head) == .outdated)
    #expect(checkSummary(runs: [failedOld, passed], headCommit: head) == .passed(1))
    #expect(checkSummary(runs: [passed, running], headCommit: head) == .running(2))
    #expect(checkSummary(runs: [passed, running, failed], headCommit: head) == .failed(2))
    // Cancelled or unknown results never read as passed.
    let cancelled = ProjectWorkItem(id: "5", status: "cancelled", commit: head, createdAt: "2026-10-19T13:00:00.000Z")
    #expect(checkSummary(runs: [passed, cancelled], headCommit: head) == .failed(1))
}

@Test func pullPhaseStaysMergingUntilTheRecordIsMerged() {
    let open = ProjectWorkItem(id: "p", status: "open")
    #expect(pullPhase(record: open, operation: nil) == .open)
    #expect(pullPhase(record: open, operation: nil, requestedMerge: true) == .merging)
    #expect(pullPhase(record: open, operation: MergeOperation(status: "queued")) == .merging)
    #expect(pullPhase(record: open, operation: MergeOperation(status: "succeeded")) == .merging)
    #expect(pullPhase(record: open, operation: MergeOperation(status: "failed", error: "Branches have diverged")) == .mergeFailed("Branches have diverged"))
    // A retried merge must not flash the earlier failure while the new operation is being created.
    #expect(pullPhase(record: open, operation: MergeOperation(status: "failed", error: "x"), requestedMerge: true) == .merging)
    #expect(pullPhase(record: open, operation: MergeOperation(status: "unknown")) == .needsRecovery("The merge outcome is unknown."))
    #expect(pullPhase(record: open.with(status: "merged"), operation: MergeOperation(status: "queued")) == .merged)
    #expect(pullPhase(record: open.with(status: "closed"), operation: nil) == .closed)
}

@Test func mergeabilityFollowsTheComparison() {
    let a = String(repeating: "a", count: 40), b = String(repeating: "b", count: 40), c = String(repeating: "c", count: 40)
    #expect(pullMergeability(nil) == .unknown)
    #expect(pullMergeability(PullComparison(baseCommit: a, headCommit: b, mergeBase: a, patch: "", fastForward: true)) == .ready)
    #expect(pullMergeability(PullComparison(baseCommit: a, headCommit: b, mergeBase: c, patch: "", fastForward: false)) == .diverged)
    #expect(pullMergeability(PullComparison(baseCommit: a, headCommit: a, mergeBase: a, patch: "", fastForward: true)) == .noChanges)
}

@Test func resultingPipelineIsThePushRunForTheMergedCommit() {
    let merged = String(repeating: "m", count: 40)
    let check = ProjectWorkItem(id: "check", status: "succeeded", commit: merged, trigger: "manual", createdAt: "2026-10-19T17:35:57.892Z", pullId: "p")
    let push = ProjectWorkItem(id: "push", status: "succeeded", commit: merged, trigger: "push", createdAt: "2026-10-19T17:52:39.677Z",
                               deployment: PipelineDeployment(application: "tally", status: "succeeded", releaseId: "r"))
    let other = ProjectWorkItem(id: "other", status: "failed", commit: String(repeating: "o", count: 40), trigger: "push", createdAt: "2026-10-19T18:00:00.000Z")
    #expect(resultingPipeline(runs: [push, check, other], mergedCommit: merged)?.id == "push")
    #expect(resultingPipeline(runs: [check, other], mergedCommit: merged) == nil)
    #expect(resultingPipeline(runs: [push], mergedCommit: nil) == nil)
}

@Test func branchComparisonFindsAheadBehindAndFastForward() {
    let c = { (id: String) in RepositoryCommit(oid: id) }
    // main: m2 m1 base ; feature: f2 f1 base  → diverged
    let diverged = compareBranches(source: [c("f2"), c("f1"), c("base")], target: [c("m2"), c("m1"), c("base")])
    #expect(diverged.ahead.map(\.oid) == ["f2", "f1"])
    #expect(diverged.behind.map(\.oid) == ["m2", "m1"])
    #expect(diverged.mergeBase == "base")
    #expect(!diverged.fastForward)
    // feature built on main's head → fast-forward
    let ahead = compareBranches(source: [c("f1"), c("m2"), c("m1")], target: [c("m2"), c("m1")])
    #expect(ahead.ahead.map(\.oid) == ["f1"])
    #expect(ahead.behind.isEmpty)
    #expect(ahead.fastForward)
    // identical branches have nothing to merge
    let same = compareBranches(source: [c("m2")], target: [c("m2")])
    #expect(same.ahead.isEmpty && !same.fastForward)
}

@Test func workItemsDecodeOptionalPullFields() throws {
    let json = """
    {"id":"p","projectId":"x","number":1,"author":"gabe","title":"Add reset","body":"","status":"merged","revision":2,
     "taskIds":["t"],"sourceBranch":"task-reset","targetBranch":"main","issueIds":[],"createdAt":"2026-10-19T17:35:49.173Z",
     "updatedAt":"2026-10-19T17:52:38.879Z","mergeOperationId":"op","mergedCommit":"9b5c","mergedBaseCommit":"0bf6","mergedAt":"2026-10-19T17:52:38.879Z"}
    """
    let item = try JSONDecoder().decode(ProjectWorkItem.self, from: Data(json.utf8))
    #expect(item.author == "gabe")
    #expect(item.mergedCommit == "9b5c")
    #expect(workspaceDate(item.updatedAt) != nil)
    let legacy = try JSONDecoder().decode(ProjectWorkItem.self, from: Data(#"{"id":"i","status":"open","createdAt":"2026-10-19T17:00:00Z"}"#.utf8))
    #expect(legacy.author == nil && workspaceDate(legacy.createdAt) != nil)
}

@Test func conversationMentionsIgnoreCodeAndAnchors() {
    let text = """
    Opened PR #3 for the web half; issue #2 tracks Swift. See #3 again and #7.
    `#9` in code, page#4, C#5 and &#6; are not mentions.
    ```
    let x = "#10"
    ```
    """
    let mentions = reviewMentions(in: text)
    #expect(mentions == [ReviewMention(number: 3, kind: .pull), ReviewMention(number: 2, kind: .issue), ReviewMention(number: 7, kind: .any)])
    #expect(reviewMentions(in: "Pull request #12 merged") == [ReviewMention(number: 12, kind: .pull)])
}

@Test func mentionsResolveToRecordsOfTheRightKind() {
    let pull = ProjectWorkItem(id: "p3", number: 3, status: "open", sourceBranch: "a", targetBranch: "main")
    let issue = ProjectWorkItem(id: "i2", number: 2, status: "open")
    let resolved = resolveMentions([ReviewMention(number: 3, kind: .any), ReviewMention(number: 2, kind: .pull),
                                    ReviewMention(number: 2, kind: .issue), ReviewMention(number: 8, kind: .any)],
                                   pulls: [pull], issues: [issue])
    #expect(resolved.map(\.id) == ["p3", "i2"])
}

@Test func conversationPullEventsKeepOnlyOpenReviewBars() {
    let pull = ProjectWorkItem(id: "p", title: "Daily streaks", number: 1, status: "open", sourceBranch: "task/streak", targetBranch: "main", mergedCommit: "f77b014abcdef")
    #expect(pull.showsConversationReviewBar)
    #expect(pull.conversationEventLabel == "Opened #1 Daily streaks")
    let merged = pull.with(status: "merged")
    #expect(!merged.showsConversationReviewBar)
    #expect(merged.conversationEventLabel == "Merged #1 Daily streaks into main · f77b014")
    let closed = pull.with(status: "closed")
    #expect(!closed.showsConversationReviewBar)
    #expect(closed.conversationEventLabel == "Closed #1 Daily streaks")
}

@Test func deploymentEventsDecodeRecordedApplicationAndPreserveURL() throws {
    let running = try JSONDecoder().decode(MessageDeployment.self, from: Data(#"{"application":"habit-harbor","status":"running","url":"https://habit-harbor.local"}"#.utf8))
    #expect(running.application == "habit-harbor")
    #expect(running.conversationEventLabel == "Deployed habit-harbor")
    #expect(running.url == "https://habit-harbor.local")
    let failed = try JSONDecoder().decode(MessageDeployment.self, from: Data(#"{"application":"habit-harbor","status":"failed"}"#.utf8))
    #expect(failed.conversationEventLabel == "Deployed habit-harbor · failed")
    let legacy = try JSONDecoder().decode(MessageDeployment.self, from: Data(#"{"status":"running"}"#.utf8))
    #expect(legacy.application == nil)
    #expect(legacy.url == nil)
}

@Test func pipelineDeploymentDecodesBuildLinksAndOlderReceipts() throws {
    let current = try JSONDecoder().decode(PipelineDeployment.self, from: Data(#"{"application":"home-gym","status":"failed","buildLogId":42,"url":"https://home-gym.local","error":"Missing required secret"}"#.utf8))
    #expect(current.buildLogId == 42)
    #expect(current.url == "https://home-gym.local")
    #expect(current.error == "Missing required secret")
    let legacy = try JSONDecoder().decode(PipelineDeployment.self, from: Data(#"{"application":"home-gym","status":"publishing","releaseId":"release"}"#.utf8))
    #expect(legacy.buildLogId == nil)
    #expect(legacy.url == nil)
}
