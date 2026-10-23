import Testing
import Foundation
@testable import DeployCore

@Test func computerSummaryExcludesCoordinatorAndOffRoles() throws {
    let source = #"{"computers":[{"id":"server","name":"Server","platform":"linux","online":true,"workerIds":["local"],"roles":{"coordinator":{"state":"ready","reason":""},"deploy":{"state":"ready","reason":""},"tasks":{"state":"ready","reason":""},"computer":{"state":"needs-setup","reason":""},"browser":{"state":"ready","reason":""}}}]}"#
    let inventory = try JSONDecoder().decode(ComputerInventory.self, from: Data(source.utf8))
    let computer = try #require(inventory.computers.first)
    #expect(computer.roleSummary == "3 roles ready · Screen access needs setup")
    #expect(computerRoleSummary(online: false, roles: computer.roles) == "Offline")
    var roles = computer.roles
    roles["computer"] = try JSONDecoder().decode(ComputerRole.self, from: Data(#"{"state":"ready","reason":""}"#.utf8))
    #expect(computerRoleSummary(online: true, roles: roles) == "All roles ready")
    roles["computer"] = try JSONDecoder().decode(ComputerRole.self, from: Data(#"{"state":"paused","reason":""}"#.utf8))
    roles["deploy"] = try JSONDecoder().decode(ComputerRole.self, from: Data(#"{"state":"off","reason":""}"#.utf8))
    #expect(computerRoleSummary(online: true, roles: roles) == "2 roles ready · Screen access paused")
    #expect(computerRoleSummary(online: true, roles: nil) == "Roles unavailable")
}

@Test func workerUpdatesDecodeWithoutBreakingLegacyInventories() throws {
    for state in ["outdated", "unknown", "current"] {
        let source = """
        {"id":"remote","name":"Computer","platform":"linux","architecture":"x64","status":"online","capabilities":["codex"],"build":{"version":"1.0.0","commit":"abcdef1"},"agentTools":["deploy_checkpoint"],"update":{"state":"\(state)","reason":"Worker report","missingTools":["deploy_commit"]}}
        """
        let worker = try JSONDecoder().decode(Worker.self, from: Data(source.utf8))
        #expect(worker.update?.needsUpdate == (state != "current"))
        #expect(worker.update?.missingTools == ["deploy_commit"])
        #expect(worker.build?.version == "1.0.0")
        #expect(worker.agentTools == ["deploy_checkpoint"])
        #expect(worker.isProviderAvailable("codex"))
        #expect(worker.update?.instruction(platform: "linux").contains("AppImage") == true)
        let computerJSON = """
        {"id":"remote","name":"Computer","platform":"linux","online":true,"workerIds":["remote"],"roles":{},"update":{"state":"\(state)","reason":"Worker report","missingTools":[]}}
        """
        let computer = try JSONDecoder().decode(Computer.self, from: Data(computerJSON.utf8))
        #expect(computer.roleSummary.contains("Update available") == (state != "current"))
    }
    let legacy = #"{"id":"remote","name":"Computer","platform":"linux","architecture":"x64","status":"online","capabilities":[]}"#
    let worker = try JSONDecoder().decode(Worker.self, from: Data(legacy.utf8))
    #expect(worker.update == nil)
    #expect(worker.build == nil)
    #expect(worker.agentTools == nil)
}
