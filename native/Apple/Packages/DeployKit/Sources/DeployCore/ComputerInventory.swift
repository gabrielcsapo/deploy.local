import Foundation

public struct ComputerInventory: Decodable, Sendable {
    public let computers: [Computer]
}

public struct Computer: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let online: Bool
    public let workerIds: [String]
    public let nodeId: String?
    public let roles: [String: ComputerRole]
    public var update: WorkerUpdate? = nil
    public var roleSummary: String { computerRoleSummary(online: online, roles: roles) + (update?.needsUpdate == true ? " · Update available" : "") }
}

public let computerRoleOrder = ["deploy", "tasks", "computer", "browser"]
public let computerRoleLabels = ["deploy": "Deploy apps", "tasks": "Coding tasks", "computer": "Screen access", "browser": "Task browser"]

public func computerRoleSummary(online: Bool, roles: [String: ComputerRole]?) -> String {
    guard online else { return "Offline" }
    guard let roles, !roles.filter({ $0.key != "coordinator" }).isEmpty else { return "Roles unavailable" }
    let available = computerRoleOrder.compactMap { roles[$0] }
    let ready = available.filter { $0.state == "ready" }.count
    if ready == computerRoleOrder.count { return "All roles ready" }
    let attention = computerRoleOrder.compactMap { id -> String? in
        guard let role = roles[id], ["paused", "needs-setup"].contains(role.state) else { return nil }
        return "\(computerRoleLabels[id] ?? id) \(role.state == "paused" ? "paused" : "needs setup")"
    }
    return (["\(ready) \(ready == 1 ? "role" : "roles") ready"] + attention).joined(separator: " · ")
}
