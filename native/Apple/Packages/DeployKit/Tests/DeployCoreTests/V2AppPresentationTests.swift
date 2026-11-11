import Foundation
import XCTest
@testable import DeployCore

final class V2AppPresentationTests: XCTestCase {
    private func app(_ state: String, summary: String = "Check", project: String? = "gym") throws -> V2LiveApp {
        var value: [String: Any] = ["appId": "sync", "name": "sync", "kind": "worker", "state": state, "summary": summary]
        if let project { value["project"] = project }
        return try JSONDecoder().decode(V2LiveApp.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testHealthUsesLiveStatesAndCountsFailures() throws {
        XCTAssertNil(V2AppPresentation.health([]))
        XCTAssertEqual(V2AppPresentation.health([try app("healthy")])?.label, "Healthy")
        let failing = V2AppPresentation.health([try app("failing"), try app("healthy"), try app("failing")])
        XCTAssertEqual(failing?.label, "2 failing")
        XCTAssertEqual(failing?.state, .failing)
        let warning = V2AppPresentation.health([try app("warning", summary: "92% of 4 GB for 20 min")])
        XCTAssertEqual(warning?.label, "High memory")
        XCTAssertEqual(warning?.state, .warning)
        XCTAssertEqual(V2AppPresentation.health([try app("warning", summary: "Learning baseline")])?.label, "Learning baseline")
        XCTAssertEqual(V2AppPresentation.health([try app("stopped")])?.label, "Not running")
        XCTAssertEqual(V2AppPresentation.health([try app("stopped"), try app("healthy")])?.label, "Healthy")
    }

    func testFallbackProjectMatchesWeb() throws {
        XCTAssertEqual(V2AppPresentation.projectID(for: try app("healthy")), "gym")
        XCTAssertEqual(V2AppPresentation.projectID(for: try app("healthy", project: nil)), "app:sync")
        XCTAssertEqual(V2AppPresentation.projectID(for: try app("healthy", project: "app:sync")), "app:sync")
    }
}
