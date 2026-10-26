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

@Test func reportLinksToTheTaskWorkspaceOpenInTheApp() {
    let markdown = "See [verification.md](</var/home/bazzite/.config/deploy.local Node/worker/tasks/8a0e/docs/verification.md>) and [log](/home/w/tasks/8a0e/out/run.log:12)."
    let rewritten = rewriteLocalFileLinks(markdown, taskId: "8a0e", workspacePaths: ["/home/bazzite/.config/deploy.local Node/worker/tasks/8a0e"])
    #expect(rewritten == "See [verification.md](<deploy-task-file:///docs/verification.md>) and [log](<deploy-task-file:///out/run.log#L12>).")
    #expect(TaskFileReference(linkURL: URL(string: "deploy-task-file:///docs/My%20File.md#L3")!) == TaskFileReference(path: "docs/My File.md", line: 3))
    #expect(TaskFileReference(path: "a b/c.md", line: nil).linkURL.flatMap(TaskFileReference.init(linkURL:)) == TaskFileReference(path: "a b/c.md"))
}

@Test func otherDiskPathsBecomeCodeAndEverythingElseIsUntouched() {
    let markdown = """
    [hosts](/etc/hosts), [other](/home/w/tasks/zzz/a.md), [`cfg`](file:///Users/me/cfg), [site](https://example.com), [task](/dashboard?task=1), ![shot](/tmp/a.png)
    `[kept](/etc/hosts)`
    ```
    [kept](/etc/hosts)
    ```
    """
    let rewritten = rewriteLocalFileLinks(markdown, taskId: "8a0e")
    #expect(rewritten == """
    `hosts`, `other`, `cfg`, [site](https://example.com), [task](/dashboard?task=1), ![shot](/tmp/a.png)
    `[kept](/etc/hosts)`
    ```
    [kept](/etc/hosts)
    ```
    """)
    // Without a task (activity notes), every disk path is shown as code.
    #expect(rewriteLocalFileLinks("[a](/home/w/tasks/8a0e/a.md)", taskId: nil) == "`a`")
    #expect(isLocalFilePath("/api/workspace/attachments/1") == false)
}

@Test func barePathsInAMessageAreRewrittenLikeLinks() {
    let roots = ["/srv/deploy/workspace/tasks/9f1c2e"]
    // Inside the workspace: a link the app opens, with the path kept as the label.
    #expect(rewriteLocalFileLinks("Edited /srv/deploy/workspace/tasks/9f1c2e/app/main.ts:12 today.",
                                  taskId: "9f1c2e", workspacePaths: roots)
            == "Edited [/srv/deploy/workspace/tasks/9f1c2e/app/main.ts:12](<deploy-task-file:///app/main.ts#L12>) today.")
    // Sentence punctuation stays prose, outside the link.
    #expect(rewriteLocalFileLinks("See /srv/deploy/workspace/tasks/9f1c2e/README.md.",
                                  taskId: "9f1c2e", workspacePaths: roots)
            == "See [/srv/deploy/workspace/tasks/9f1c2e/README.md](<deploy-task-file:///README.md>).")
    // Outside the workspace: code, never a dead link.
    #expect(rewriteLocalFileLinks("Wrote /var/home/bazzite/.config/deploy.local/out.txt there.", taskId: "9f1c2e")
            == "Wrote `/var/home/bazzite/.config/deploy.local/out.txt` there.")
    // Code spans, fences, dashboard routes and web URLs are left exactly as written.
    for content in ["`/var/home/me/a.txt`", "```\n/var/home/me/a.txt\n```", "Open /dashboard?task=9f1c2e to review",
                    "See https://deploy.local/docs/guide/intro for more", "Fetched https://example.com/a/b/c.json"] {
        #expect(rewriteLocalFileLinks(content, taskId: "9f1c2e", workspacePaths: roots) == content, "\(content)")
    }
}

@Test func pathsNamingAttachedMediaOpenTheAttachment() {
    let media = [MessageAttachmentRef(id: "att-1", name: "phone-task.png", kind: "image"),
                 MessageAttachmentRef(id: "att-2", name: "build.log", kind: "text")]
    #expect(rewriteLocalFileLinks("Screenshot: /var/home/bazzite/.config/deploy.local/phone-task.png",
                                  taskId: "9f1c2e", attachments: media)
            == "Screenshot: ![phone-task.png](/api/workspace/attachments/att-1)")
    #expect(rewriteLocalFileLinks("[shot](/var/home/bazzite/out/phone-task.png)", taskId: "9f1c2e", attachments: media)
            == "![phone-task.png](/api/workspace/attachments/att-1)")
    // An attachment with no viewer still must not look openable.
    #expect(rewriteLocalFileLinks("Log at /var/home/bazzite/jobs/build.log", taskId: "9f1c2e", attachments: media)
            == "Log at `/var/home/bazzite/jobs/build.log`")
    #expect(attachmentForPath("/a/b/phone-task.png:3", attachments: media) == media[0])
    #expect(attachmentForPath("/a/b/other.png", attachments: media) == nil)
}
