import Foundation
import Testing
@testable import DeployCore

private func activityJob(_ id: String, _ status: String, command: String = "swift test", worker: String? = "mac", name: String? = nil, run: String? = nil, extra: [String: Any] = [:]) throws -> WorkspaceJob {
    var object: [String: Any] = ["id": id, "status": status, "createdAt": "2026-10-21T10:00:0\(id)Z", "command": command, "digest": "abc", "output": "", "truncated": false]
    object["workerId"] = worker; object["name"] = name; object["runId"] = run
    object.merge(extra) { _, new in new }
    return try JSONDecoder().decode(WorkspaceJob.self, from: JSONSerialization.data(withJSONObject: object))
}
@Test func activitySummaryRequiresJobsOrFiles() throws {
    #expect(!TaskActivitySummary(jobs: [], activity: []).isVisible)
    let activity = try JSONDecoder().decode([TaskActivity].self, from: Data(#"""
    [{"id":"turn","status":"completed","summary":"Read sources","items":[
      {"id":"a","kind":"read","title":"Read","status":"completed","source":"/app.swift","detail":"","output":"","background":false},
      {"id":"b","kind":"read","title":"Read again","status":"completed","source":"/app.swift","detail":"","output":"","background":false},
      {"id":"c","kind":"directory","title":"List","status":"completed","source":".","detail":"","output":"","background":false}
    ]}]
    """#.utf8))
    let summary = TaskActivitySummary(jobs: [], activity: activity)
    #expect(summary.sources == ["/app.swift"])
    #expect(summary.label == "Activity: Read 1 file")
}
@Test func activityIdentityAndLatestResult() throws {
    let fail = try activityJob("1", "failed", command: "  swift   test\n")
    let pass = try activityJob("2", "succeeded")
    #expect(fail.checkIdentity == pass.checkIdentity)
    #expect(try activityJob("1", "failed", command: "a", name: "Smoke").checkIdentity == activityJob("2", "succeeded", command: "b", name: "Smoke").checkIdentity)
    #expect(try activityJob("3", "failed", worker: "linux").checkIdentity != pass.checkIdentity)
    #expect(try activityJob("4", "failed", name: "swift test").checkIdentity != pass.checkIdentity)
    let checks = TaskActivitySummary.latestChecks([pass, fail])
    #expect(checks.count == 1); #expect(checks.first?.latest.id == "2"); #expect(checks.first?.earlier.map(\.id) == ["1"]); #expect(checks.first?.failures == 1)
    #expect(TaskActivitySummary(jobs: [fail, pass], activity: []).failingCount == 0)
}
@Test func activityOrderingAndSummary() throws {
    let jobs = try [activityJob("1", "failed"), activityJob("2", "queued", command: "lint"), activityJob("3", "running", command: "build", worker: "linux")]
    #expect(TaskActivitySummary.orderedJobs(jobs).map(\.id) == ["3", "2", "1"])
    let summary = TaskActivitySummary(jobs: jobs, activity: [])
    #expect(summary.runningCount == 2)
    #expect(summary.text == "1 failing · 2 running · 3 jobs on 2 computers")
    #expect(TaskActivitySummary(jobs: [jobs[0]], activity: []).text == "1 failing · 1 job on 1 computer")
    let turns = TaskActivitySummary.turns(jobs, runs: [], messages: [])
    #expect(turns.first?.title == "Other"); #expect(turns.first?.jobs.map(\.id) == ["1", "2", "3"])
}
@Test func activityCommandTitlesUseSignificantPrograms() {
    let cases = [
        (#"curl --fail --show-error --silent https://habit-harbor.local/api/habits | grep streak"#, "curl → habit-harbor.local"),
        (#"profile=$(mktemp -d /tmp/firefox.XXXXXX); firefox --headless --profile "$profile" --screenshot /tmp/shot.png https://tally.local"#, "firefox → tally.local"),
        (#"git status --short --branch && git add . && git -c user.name='deploy.local' -c user.email='deploy@local' commit -m 'Build cross-platform Habit Harbor tracker' && git push origin HEAD:task/123"#, "git commit + push"),
        ("xcodebuild -version && swift test && swift build --product HabitHarborApp", "swift test + swift build"),
        ("cd /tmp/app && set -e; set -u; VAR=value; npm test", "npm test")
    ]
    for (command, expected) in cases { #expect(TaskActivitySummary.commandTitle(command) == expected) }
}
@Test func activityTimingIsBackwardCompatible() throws {
    let old = try activityJob("1", "succeeded")
    #expect(old.startedAt == nil); #expect(old.finishedAt == nil); #expect(old.runId == nil); #expect(old.duration() == "")
    let timed = try activityJob("2", "succeeded", name: "Smoke", run: "run", extra: ["startedAt": "2026-10-21T10:00:00Z", "finishedAt": "2026-10-21T10:00:04Z"])
    #expect(timed.duration() == "4s"); #expect(timed.title == "Smoke"); #expect(timed.runId == "run")
    let queued = try activityJob("1", "queued")
    #expect(queued.duration(now: TaskActivitySummary.date("2026-10-21T10:02:01Z")!) == "Queued 2m 0s")
}
@Test func activityRetriesWithShellPlumbingFoldIntoOneCheck() throws {
    let failed = try activityJob("1", "failed", command: #"curl --fail https://habit-harbor.local/ | grep -q 'class="streak"' && curl --fail https://habit-harbor.local/api/habits | tee /tmp/a.json && cat /tmp/a.json"#, worker: "bazzite")
    let passed = try activityJob("2", "succeeded", command: "curl --fail https://habit-harbor.local/ | grep 'streak'", worker: "bazzite")
    #expect(failed.checkIdentity == passed.checkIdentity)
    #expect(TaskActivitySummary(jobs: [failed, passed], activity: []).failingCount == 0)
    #expect(TaskActivitySummary.commandTitle(#"profile=$(mktemp -d .ff.XXXX); dbus-run-session -- firefox --headless --screenshot "$PWD/x.png" https://tally.local; if ! [ -f x.png ]; then exit 1; fi; base64 x.png"#) == "firefox → tally.local")
    #expect(TaskActivitySummary.commandTitle("node --version && npm test") == "npm test")
    #expect(TaskActivitySummary.commandTitle("for i in 1 2 3; do curl -s https://tally.local && break; sleep 2; done") == "curl → tally.local")
    #expect(TaskActivitySummary.commandTitle("timeout 60 swift test && swift build --product App") == "swift test + swift build")
}

@Test func workedDurationUsesCompletionAndRejectsInvalidTimes() throws {
    func run(status: String, start: String = "2026-10-21T10:00:00Z", end: String = "2026-10-21T10:02:08Z") throws -> Run {
        try JSONDecoder().decode(Run.self, from: JSONSerialization.data(withJSONObject: ["id": "r", "taskId": "t", "adapter": "codex", "status": status, "createdAt": start, "updatedAt": end]))
    }
    let now = TaskActivitySummary.date("2026-10-21T10:03:01Z")!
    #expect(try run(status: "succeeded").workedDuration(now: now) == "2m 8s")
    #expect(try run(status: "running").workedDuration(now: now) == "3m 1s")
    #expect(try run(status: "failed", start: "").workedDuration(now: now) == "")
    #expect(try run(status: "succeeded", end: "2026-10-21T09:00:00Z").workedDuration(now: now) == "")
}
