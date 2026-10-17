import Testing
import Foundation
@testable import DeployCore

private func worker(_ id: String, status: String = "online", connections: String = "") throws -> Worker {
    let source = """
    {"id":"\(id)","name":"SER","platform":"linux","architecture":"x64","status":"\(status)","capabilities":["git","codex"]\(connections)}
    """
    return try JSONDecoder().decode(Worker.self, from: Data(source.utf8))
}

@Test func managedComputerReplacesMissingLocalDefaultButPreservesExplicitSelection() throws {
    let online = try worker("managed-ser"), offline = try worker("other", status: "offline")
    #expect(preferredTaskWorkerId(workers: [offline, online], current: "local") == online.id)
    #expect(preferredTaskWorkerId(workers: [offline, online], current: offline.id) == offline.id)
    #expect(preferredTaskWorkerId(workers: [], current: "local") == nil)
}

@Test func providerAvailabilityUsesChosenComputerAndHonorsExplicitDisconnect() throws {
    let connected = try worker("managed-ser", connections: #", "connections":[{"provider":"codex","available":true,"enabled":true},{"provider":"claude","available":false,"enabled":true}]"#)
    #expect(connected.isProviderAvailable("codex"))
    #expect(!connected.isProviderAvailable("claude"))
    let disconnected = try worker("managed-ser", connections: #", "connections":[{"provider":"codex","available":false,"enabled":true}]"#)
    #expect(!disconnected.isProviderAvailable("codex"))
    let disabled = try worker("managed-ser", connections: #", "connections":[{"provider":"codex","available":true,"enabled":false}]"#)
    #expect(!disabled.isProviderAvailable("codex"))
}

@Test func olderWorkersKeepCapabilitySupportAndOfflineComputersCannotRun() throws {
    #expect(try worker("legacy").isProviderAvailable("codex"))
    #expect(try !worker("legacy").isProviderAvailable("claude"))
    #expect(try !worker("legacy", status: "offline").isProviderAvailable("codex"))
}
