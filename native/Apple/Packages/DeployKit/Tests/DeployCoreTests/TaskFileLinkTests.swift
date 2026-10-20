import Testing
import Foundation
@testable import DeployCore

private let roots = ["/srv/deploy/workspace/tasks/9f1c2e",
                     "/home/gabrielcsapo/.local/share/deploy.local/task-workers/managed-77be/tasks/9f1c2e"]

@Test func workerPathsInsideTheWorkspaceBecomeRepositoryPaths() {
    #expect(taskFileReference("/home/gabrielcsapo/.local/share/deploy.local/task-workers/managed-77be/tasks/9f1c2e/web/format-time.mjs:1",
                              taskId: "9f1c2e", workspacePaths: roots) == TaskFileReference(path: "web/format-time.mjs", line: 1))
    #expect(taskFileReference("/srv/deploy/workspace/tasks/9f1c2e/src/app.ts:12:5", taskId: "9f1c2e", workspacePaths: roots)
            == TaskFileReference(path: "src/app.ts", line: 12))
    #expect(taskFileReference("file:///srv/deploy/workspace/tasks/9f1c2e/README.md#L40-L44", taskId: "9f1c2e", workspacePaths: roots)
            == TaskFileReference(path: "README.md", line: 40))
    // MarkdownUI hands over a URL, so spaces arrive percent-encoded.
    #expect(taskFileReference("/srv/deploy/workspace/tasks/9f1c2e/My%20File.md", taskId: "9f1c2e", workspacePaths: roots)
            == TaskFileReference(path: "My File.md"))
}

@Test func unknownWorkerRootsStillMapThroughTheTaskId() {
    #expect(taskFileReference("/Users/me/.local/share/deploy.local/task-workers/mac/tasks/9f1c2e/a/b.swift:7", taskId: "9f1c2e")
            == TaskFileReference(path: "a/b.swift", line: 7))
    #expect(taskFileReference("./server/api.ts:3", taskId: "9f1c2e") == TaskFileReference(path: "server/api.ts", line: 3))
}

@Test func externalLinksAndPathsOutsideTheWorkspaceAreLeftAlone() {
    for href in ["https://example.com/tasks/9f1c2e/a.ts", "mailto:me@example.com", "#section", "//cdn.example.com/a.js",
                 "/srv/deploy/workspace/tasks/other/a.ts", "/etc/hosts", "/srv/deploy/workspace/tasks/9f1c2e/../secret",
                 "/srv/deploy/workspace/tasks/9f1c2e/", ""] {
        #expect(taskFileReference(href, taskId: "9f1c2e", workspacePaths: roots) == nil, "\(href)")
    }
}

@Test func fileLinksLandOnTheDiffOrSayWhyNot() {
    let files = [ChangedFile(path: "web/format-time.mjs", status: "A"), ChangedFile(path: "logo.png", status: "M")]
    let patch = """
    diff --git a/web/format-time.mjs b/web/format-time.mjs
    new file mode 100644
    --- /dev/null
    +++ b/web/format-time.mjs
    @@ -0,0 +1,2 @@
    +export const one = 1;
    +export const two = 2;
    diff --git a/logo.png b/logo.png
    Binary files a/logo.png and b/logo.png differ
    """
    let patches = reviewFilePatches(patch, files: files).filter { $0.lines.contains { $0.kind == .addition } }
    #expect(taskFileFocus(TaskFileReference(path: "web/format-time.mjs", line: 2), files: files, patches: patches)
            == .diff(path: "web/format-time.mjs", line: 2))
    // A line outside the diff still opens the file, without pretending the line is shown.
    #expect(taskFileFocus(TaskFileReference(path: "web/format-time.mjs", line: 90), files: files, patches: patches)
            == .diff(path: "web/format-time.mjs", line: nil))
    #expect(taskFileFocus(TaskFileReference(path: "logo.png"), files: files, patches: patches) == .listedWithoutDiff)
    #expect(taskFileFocus(TaskFileReference(path: "README.md"), files: files, patches: patches) == .unchanged)
}

@Test func heldFollowUpsReturnToTheDraftOnce() {
    #expect(draftRestoring("Add tests", into: "") == "Add tests")
    #expect(draftRestoring("Add tests", into: "Also docs") == "Add tests\n\nAlso docs")
    #expect(draftRestoring("Add tests", into: "Add tests\n\nAlso docs") == "Add tests\n\nAlso docs")
}

@Test func turnDiffAndQueuedMessageDecodeAlongsideOlderCoordinators() throws {
    let turn = try JSONDecoder().decode(TaskDiff.self, from: Data("""
    {"baseRevision":"a","headRevision":"b","patch":"","status":"","files":[],"checks":[],"scope":"all","note":"This is the first turn, so this shows all changes."}
    """.utf8))
    #expect(turn.scope == "all")
    #expect(turn.note?.hasPrefix("This is the first turn") == true)
    let older = try JSONDecoder().decode(TaskDiff.self, from: Data("""
    {"baseRevision":"a","headRevision":"b","patch":"","status":"","files":[],"checks":[]}
    """.utf8))
    #expect(older.scope == nil && older.note == nil)
    let held = try JSONDecoder().decode(QueuedMessage.self, from: Data("""
    {"id":"t","taskId":"t","content":"next","status":"held","reason":"Not sent because the turn failed.","createdAt":"2026-10-19T00:00:00Z"}
    """.utf8))
    #expect(held.isHeld && held.reason == "Not sent because the turn failed.")
}
