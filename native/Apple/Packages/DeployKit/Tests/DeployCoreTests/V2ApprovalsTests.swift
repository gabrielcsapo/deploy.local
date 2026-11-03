import Testing
import Foundation
@testable import DeployCore

struct V2ApprovalsTests {
    @Test func decodesRulesAndIgnoresUnneededResponseFields() throws {
        let data = Data(#"""
        {"rules":[
          {"id":"a","agent":"custom-agent","action":"start-task","mode":"allow","limit":"Only docs","future":true},
          {"agent":"custom-agent","action":"open-pull-request","mode":"ask"},
          {"agent":"custom-agent","action":"merge","mode":"never"},
          {"agent":"custom-agent","action":"restart","mode":"allow"},
          {"agent":"custom-agent","action":"rollback","mode":"ask"}
        ],"suggestions":[{"anything":"ignored"}]}
        """#.utf8)
        let approvals = try JSONDecoder().decode(V2Approvals.self, from: data)
        #expect(approvals.rules.count == 5)
        #expect(approvals.rules.map(\.action) == V2ApprovalAction.allCases)
        #expect(approvals.rules.map(\.mode) == [.allow, .ask, .never, .allow, .ask])
        #expect(approvals.rules.allSatisfy { $0.agent == "custom-agent" })
    }

    @Test func labelsAndOrderMatchTheApprovedPhoneBoard() {
        #expect(V2ApprovalAction.allCases.map(\.label) == [
            "Start a task", "Open a pull request", "Merge a pull request", "Restart an app", "Roll back a release"
        ])
        #expect(V2ApprovalMode.allow.label == "Allowed")
        #expect(V2ApprovalMode.ask.label == "Ask")
        #expect(V2ApprovalMode.never.label == "Never")
    }

    @Test func overviewUsesTheCorrectAgentAndGeneralRuleWithAskAsTheDefault() throws {
        let data = Data(#"""
        {"rules":[
          {"agent":"one","action":"merge","mode":"allow","projectId":"docs"},
          {"agent":"two","action":"merge","mode":"allow"},
          {"agent":"one","action":"merge","mode":"never"},
          {"agent":"one","action":"restart","mode":"allow","projectId":"docs"}
        ]}
        """#.utf8)
        let approvals = try JSONDecoder().decode(V2Approvals.self, from: data)
        #expect(approvals.mode(agent: "one", action: .merge) == .never)
        #expect(approvals.mode(agent: "two", action: .merge) == .allow)
        #expect(approvals.mode(agent: "one", action: .restart) == .ask)
        #expect(approvals.mode(agent: "missing", action: .merge) == .ask)
        let empty = try JSONDecoder().decode(V2Approvals.self, from: Data(#"{"rules":[]}"#.utf8))
        #expect(empty.rules.isEmpty)
        #expect(empty.mode(agent: "one", action: .startTask) == .ask)
    }

    @Test func malformedRulesDoNotTurnIntoApparentPermissions() {
        for json in [
            #"{"rules":[{"agent":"one","action":"merge"}]}"#,
            #"{"rules":[{"agent":"one","action":"merge","mode":"unknown"}]}"#,
            #"{"rules":[{"action":"merge","mode":"allow"}]}"#,
            #"{"rules":null}"#
        ] {
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(V2Approvals.self, from: Data(json.utf8))
            }
        }
    }
}
