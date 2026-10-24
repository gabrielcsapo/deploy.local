import Foundation
import Testing
@testable import DeployCore

private func decodeJob(_ json: String) throws -> WorkspaceJob {
    try JSONDecoder().decode(WorkspaceJob.self, from: Data(json.utf8))
}

@Test func jobsWithoutArtifactsStillDecode() throws {
    let job = try decodeJob(#"{"id":"j","command":"true","status":"succeeded","digest":"d","output":"","truncated":false}"#)
    #expect(job.artifacts == nil)
    #expect(!job.awaitsArtifacts)
    #expect(job.artifactRows(attachments: []).isEmpty)
}

@Test func jobArtifactsSplitIntoMediaFilesAndSkippedReferences() throws {
    let job = try decodeJob(#"""
    {"id":"j","taskId":"t","runId":"r","command":"true","status":"failed","digest":"d","output":"","truncated":false,
     "artifactPaths":[{"path":"shots/*.png"},{"path":"build.log","caption":"Build log"},{"path":"hosts.txt"}],
     "artifacts":[
       {"path":"shots/home.png","name":"home.png","caption":"Home","attachmentId":"img","kind":"image","bytes":2048},
       {"path":"shots/run.mp4","name":"run.mp4","caption":"","attachmentId":"vid","kind":"video","bytes":4096},
       {"path":"build.log","name":"build.log","caption":"Build log","attachmentId":"log","kind":"file","bytes":1536},
       {"path":"hosts.txt","name":"hosts.txt","caption":"","skipped":"Refused: the path resolves outside the job directory"}
     ]}
    """#)
    let stored = try JSONDecoder().decode(MediaAttachment.self, from: Data(#"""
    {"id":"img","taskId":"t","runId":"r","kind":"image","mimeType":"image/png","size":2048,"width":10,"height":20,
     "name":"home.png","caption":"Home","source":"job-artifact","jobId":"j","createdAt":"2026-10-23T00:00:00Z"}
    """#.utf8))
    #expect(stored.jobId == "j")
    let rows = job.artifactRows(attachments: [stored], taskId: "t")
    #expect(rows.media.map(\.id) == ["img", "vid"])
    // The stored row wins; a reference not yet in the task's attachments falls back to the job entry.
    #expect(rows.media.first?.width == 10)
    #expect(rows.media.last?.kind == "video" && rows.media.last?.source == "job-artifact")
    #expect(rows.files.map(\.id) == ["log"])
    #expect(rows.files.first?.displayCaption == "Build log")
    #expect(rows.skipped.map(\.path) == ["hosts.txt"])
    #expect(rows.skipped.first?.id == "skipped:hosts.txt")
    #expect(!job.awaitsArtifacts)
}

@Test func runningJobsAwaitRequestedArtifacts() throws {
    let job = try decodeJob(#"""
    {"id":"j","command":"true","status":"running","digest":"d","output":"","truncated":false,
     "artifactPaths":[{"path":"out/*"}],"artifacts":[]}
    """#)
    #expect(job.awaitsArtifacts)
}

@Test func artifactSizesReadAsShortLabels() {
    #expect(ArtifactSize.label(512) == "512 B")
    #expect(ArtifactSize.label(4096) == "4 KB")
    #expect(ArtifactSize.label(3 * 1024 * 1024 + 200_000) == "3.2 MB")
}
