import XCTest
@testable import DeployCore

final class AgentContextTests: XCTestCase {
    func testRunPreservesExactContextAndTimestamp() throws {
        let data = Data(#"{"id":"run","taskId":"task","adapter":"codex","status":"succeeded","createdAt":"2026-10-21T10:00:00Z","updatedAt":"2026-10-21T10:01:00Z","agentContext":"Manual\nSituation","agentContextAt":"2026-10-21T10:00:01Z"}"#.utf8)
        let run = try JSONDecoder().decode(Run.self, from: data)
        XCTAssertEqual(run.agentContext, "Manual\nSituation")
        XCTAssertEqual(run.agentContextAt, "2026-10-21T10:00:01Z")
    }
    func testHistoricalRunHasNoInventedContext() throws {
        let data = Data(#"{"id":"run","taskId":"task","adapter":"claude","status":"failed","createdAt":"2026-10-21T10:00:00Z","updatedAt":"2026-10-21T10:01:00Z"}"#.utf8)
        let run = try JSONDecoder().decode(Run.self, from: data)
        XCTAssertNil(run.agentContext)
        XCTAssertNil(run.agentContextAt)
    }
}
