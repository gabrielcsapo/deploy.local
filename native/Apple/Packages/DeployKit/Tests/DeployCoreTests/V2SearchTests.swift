import XCTest
@testable import DeployCore

final class V2SearchTests: XCTestCase {
    func testMatchesAreCutOutIgnoringCase() {
        XCTAssertEqual(V2SearchText.parts("Clone a cloneRepository", matching: "clone"), ["", "Clone", " a ", "clone", "Repository"])
        XCTAssertEqual(V2SearchText.parts("nothing", matching: "x"), ["nothing"])
        XCTAssertEqual(V2SearchText.parts("anything", matching: ""), ["anything"])
    }

    func testResultsDecodeFromTheServerShape() throws {
        let results = try JSONDecoder().decode(V2SearchResults.self, from: Data("""
        {"query":"workouts.started","names":[
          {"kind":"task","id":"t1","title":"Rename workouts.started safely","projectId":"p1","project":"home-gym","status":"done","agent":"Code reviewer","at":"2026-11-01T00:00:00.000Z"},
          {"kind":"project","id":"p1","title":"home-gym"}],
         "messages":{"total":4,"items":[{"id":"e1","agentId":"a1","title":"Ops watcher","who":"Ops watcher","fromYou":false,"at":"2026-11-05T00:00:00.000Z","snippet":"still reads workouts.started"}]}}
        """.utf8))
        XCTAssertEqual(results.tasks.map(\.title), ["Rename workouts.started safely"])
        XCTAssertEqual(results.messages.total, 4)
        XCTAssertNil(results.messages.items[0].taskId)
        let code = try JSONDecoder().decode(V2SearchCode.self, from: Data("""
        {"query":"workouts.started","lines":12,"files":5,"projects":1,"truncated":false,"items":[
          {"projectId":"home.gym","project":"home-gym","ref":"main","path":"worker/sync.ts","line":88,"text":".where(gte(workouts.started, since))"}]}
        """.utf8))
        XCTAssertEqual(code.count, "12 lines in 5 files")
        XCTAssertEqual(V2SearchText.codePath(code.items[0], query: "workouts.started"),
                       "/dashboard/projects/home%2Egym/code?ref=main&file=worker/sync.ts&line=88&find=workouts.started")
        var one = code; one.lines = 1; one.files = 1; one.truncated = true
        XCTAssertEqual(one.count, "1+ line in 1+ file")
    }
}
