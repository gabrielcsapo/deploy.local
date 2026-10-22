import Foundation

public struct TaskRisk: Equatable, Sendable {
    public let label: String
    public let icon: String
    public let explanation: String
    public static func forComputer(_ computer: Computer?, permissions: [NodePermission]) -> [TaskRisk] {
        guard let computer, computer.online else { return [] }
        var risks: [TaskRisk] = []
        if computer.roles["deploy"]?.state == "ready" {
            risks.append(TaskRisk(label: "Can deploy", icon: "shippingbox", explanation: "The agent can deploy applications on this computer."))
        }
        if computer.roles["computer"]?.state == "ready", permissions.contains(where: { $0.id == "input" && $0.state == "on" }) {
            risks.append(TaskRisk(label: "Screen access", icon: "desktopcomputer", explanation: "With your approval, the agent can view the screen and click or type on this computer."))
        }
        return risks
    }
}
