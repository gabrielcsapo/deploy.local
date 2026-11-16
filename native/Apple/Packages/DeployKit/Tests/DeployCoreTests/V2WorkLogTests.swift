import Testing
import Foundation
@testable import DeployCore

@Suite struct V2WorkLogTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func decodesTheNewStepFields() throws {
        let step = try decode(WorkStep.self, #"""
        {"icon":"terminal","text":"Deployed tally","glyph":"deploy","outcome":"Failed: health check","outcomeHref":"https://tally.local",
         "tone":"fail","live":false,"seconds":42,"links":[{"label":"View logs","href":"/dashboard/tally/build"}],
         "reason":"The app did not answer on /health.","tail":["GET /health 502","giving up"]}
        """#)
        #expect(step.icon == .terminal)
        #expect(step.glyph == "deploy")
        #expect(step.outcome == "Failed: health check")
        #expect(step.outcomeHref == "https://tally.local")
        #expect(step.tone == "fail")
        #expect(step.live == false)
        #expect(step.seconds == 42)
        #expect(step.links == [WorkLink(label: "View logs", href: "/dashboard/tally/build")])
        #expect(step.reason == "The app did not answer on /health.")
        #expect(step.tail == ["GET /health 502", "giving up"])
        #expect(V2WorkLog.opens(step))
        #expect(V2WorkLog.stepStartsOpen(step))
    }

    @Test func decodesAnOldStepAndAnUnknownGlyphOrTone() throws {
        let old = try decode(WorkStep.self, #"{"icon":"edit","text":"main.ts","added":2,"removed":1}"#)
        #expect(old == WorkStep(icon: .edit, text: "main.ts", added: 2, removed: 1))
        #expect(!V2WorkLog.opens(old))
        let future = try decode(WorkStep.self, #"{"icon":"pulse","text":"Rolled back","glyph":"rollback","tone":"info"}"#)
        #expect(future.glyph == "rollback")
        #expect(future.tone == "info")
        #expect(!V2WorkLog.stepStartsOpen(future))
    }

    @Test func encodesOnlyTheFieldsItHas() throws {
        let data = try JSONEncoder().encode(WorkStep(icon: .edit, text: "main.ts"))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(Set(object?.keys.map { $0 } ?? []) == ["icon", "text"])
    }

    private func log(_ id: String, _ at: String, live: Bool = false, _ steps: [WorkStep]) -> ConversationEvent {
        .worklog(WorkLogEvent(id: id, at: at, summary: "Step \(id)", steps: steps, live: live))
    }
    private func reply(_ id: String, _ at: String) -> ConversationEvent {
        .reply(ReplyEvent(id: id, at: at, agent: "scout", paragraphs: ["Done"]))
    }

    @Test func joinsConsecutiveWorkLogsBetweenMessages() {
        let events = [
            log("a", "2026-11-16T10:00:00.000Z", [WorkStep(icon: .edit, text: "Edited 3 files", added: 48, removed: 2)]),
            log("b", "2026-11-16T10:05:00.000Z", [WorkStep(icon: .terminal, text: "Ran tests on SER", outcome: "13 passed")]),
            log("c", "2026-11-16T10:14:00.000Z", [WorkStep(icon: .terminal, text: "Deployed tally", glyph: "deploy", outcome: "Live at tally.local")]),
            reply("r", "2026-11-16T10:15:00.000Z"),
            log("d", "2026-11-16T10:16:00.000Z", [WorkStep(icon: .file, text: "Read README")]),
        ]
        let grouped = V2WorkLog.group(events)
        #expect(grouped.count == 3)
        guard case .worklog(let first) = grouped[0] else { Issue.record("expected a work log"); return }
        #expect(first.id == "a")
        #expect(first.summary == "Worked for 14m")
        #expect(!first.live)
        #expect(first.steps.map(\.text) == ["Edited 3 files", "Ran tests on SER", "Deployed tally"])
        #expect(!V2WorkLog.startsOpen(first))
        guard case .reply = grouped[1] else { Issue.record("expected the reply"); return }
        // A log on its own keeps the summary it came with.
        guard case .worklog(let last) = grouped[2] else { Issue.record("expected a work log"); return }
        #expect(last.summary == "Step d")
    }

    @Test func aRunningLogSaysWorkingAndStartsOpen() {
        let grouped = V2WorkLog.group([
            log("a", "2026-11-16T10:00:00Z", [WorkStep(icon: .edit, text: "Edited 3 files")]),
            log("b", "2026-11-16T10:09:00Z", live: true, [WorkStep(icon: .terminal, text: "Deploying tally", glyph: "deploy", outcome: "Checking health")]),
        ])
        guard case .worklog(let value) = grouped.first, grouped.count == 1 else { Issue.record("expected one work log"); return }
        #expect(value.summary == "Working for 9m")
        #expect(value.live)
        #expect(value.steps.map(\.live) == [false, true])
        #expect(V2WorkLog.startsOpen(value))
    }

    @Test func aFailedStepOpensTheLog() {
        let failed = WorkLogEvent(id: "a", at: "now", summary: "Worked for 2m", steps: [
            WorkStep(icon: .terminal, text: "Deployed tally", glyph: "deploy", outcome: "Failed: health check", tone: "fail", reason: "No answer"),
        ], live: false)
        #expect(V2WorkLog.startsOpen(failed))
        let warned = WorkStep(icon: .terminal, text: "Deployed tally", outcome: "Interrupted", tone: "warn", reason: "bazzite restarted")
        #expect(V2WorkLog.opens(warned))
        #expect(!V2WorkLog.stepStartsOpen(warned))
    }

    @Test func formatsHowLongItTook() {
        #expect(V2WorkLog.took(from: "2026-11-16T10:00:00Z", to: "2026-11-16T10:00:45Z") == "45s")
        #expect(V2WorkLog.took(from: "2026-11-16T10:00:00Z", to: "2026-11-16T11:05:00Z") == "1h 5m")
        #expect(V2WorkLog.took(from: "bad", to: "2026-11-16T11:05:00Z") == "0s")
    }

    @Test func skipsStoredDeploySummaries() {
        let summary = Message(id: "deployment:abc", taskId: "t", role: "assistant", content: "> **drop** · failed\n>\n> [https://drop.local](https://drop.local)", createdAt: "", runId: nil, isProgress: nil)
        var tagged = Message(id: "m2", taskId: "t", role: "assistant", content: "Deployed", createdAt: "", runId: nil, isProgress: nil)
        tagged.deployment = MessageDeployment(status: "failed", url: nil)
        let plain = Message(id: "m3", taskId: "t", role: "assistant", content: "Done", createdAt: "", runId: nil, isProgress: nil)
        #expect(V2WorkLog.isDeploySummary(summary))
        #expect(V2WorkLog.isDeploySummary(tagged))
        #expect(!V2WorkLog.isDeploySummary(plain))
    }

    @Test func resolvesLinksAgainstTheCoordinator() {
        #expect(V2WorkLog.url("/dashboard/tally/build", origin: "https://deploy.local")?.absoluteString == "https://deploy.local/dashboard/tally/build")
        #expect(V2WorkLog.url("https://tally.local", origin: "https://deploy.local")?.absoluteString == "https://tally.local")
        #expect(V2WorkLog.url("javascript:alert(1)", origin: "https://deploy.local") == nil)
    }
}
