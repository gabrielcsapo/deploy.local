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
