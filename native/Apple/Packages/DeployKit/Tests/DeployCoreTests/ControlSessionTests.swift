import Foundation
import Testing
@testable import DeployCore

private func controlSession(status: String, reason: String?) throws -> ControlSession {
    var value: [String: Any] = [
        "id": "session", "workerId": "worker", "targetId": "desktop",
        "targetLabel": "SER desktop", "kind": "computer", "status": status,
        "generation": "generation", "controlOwner": "user:client", "viewOnly": true
    ]
    value["reason"] = reason
    return try JSONDecoder().decode(ControlSession.self, from: JSONSerialization.data(withJSONObject: value))
}

@Test func endedControlReasonsUsePlainLanguage() throws {
    let cases: [(String, String?, String)] = [
        ("stopped", "Stopped by agent", "The agent finished with SER desktop"),
        ("stopped", "Stopped by user", "You stopped this session"),
        ("suspended", "Worker, target, or capture/input permission changed", "The connection to SER desktop timed out"),
        ("stopped", "Control connection expired. Inspect the target", "The connection to SER desktop timed out"),
        ("suspended", "Interaction outcome uncertain: lost response", "The session stopped after an uncertain action"),
        ("stopped", "Unknown technical reason", "This session ended"),
        ("stopped", nil, "This session ended")
    ]
    for (status, reason, expected) in cases {
        let session = try controlSession(status: status, reason: reason)
        #expect(session.isEnded)
        #expect(session.endedReason == expected)
    }
    let active = try controlSession(status: "active", reason: nil)
    #expect(!active.isEnded)
    #expect(active.targetId == "desktop")
    #expect(active.viewOnly == true)
    #expect(active.controlOwner == "user:client")
}
