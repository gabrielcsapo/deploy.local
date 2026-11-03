import Foundation

public enum V2ApprovalAction: String, Decodable, CaseIterable, Sendable {
    case startTask = "start-task"
    case openPullRequest = "open-pull-request"
    case merge, restart, rollback

    public var label: String {
        switch self {
        case .startTask: "Start a task"
        case .openPullRequest: "Open a pull request"
        case .merge: "Merge a pull request"
        case .restart: "Restart an app"
        case .rollback: "Roll back a release"
        }
    }
}

public enum V2ApprovalMode: String, Decodable, Sendable {
    case allow, ask, never

    public var label: String {
        switch self {
        case .allow: "Allowed"
        case .ask: "Ask"
        case .never: "Never"
        }
    }
}

public struct V2ApprovalRule: Decodable, Equatable, Sendable {
    public let agent: String
    public let action: V2ApprovalAction
    public let mode: V2ApprovalMode
    public let projectId: String?
}

public struct V2Approvals: Decodable, Sendable {
    public let rules: [V2ApprovalRule]

    /// The account-wide rule, matching the web's overview. A project override
    /// must never be displayed as permission for every project. Missing rules ask.
    public func mode(agent: String, action: V2ApprovalAction) -> V2ApprovalMode {
        rules.first { $0.agent == agent && $0.action == action && $0.projectId == nil }?.mode ?? .ask
    }
}

extension V2Client {
    public func approvals() async throws -> V2Approvals {
        try await client.request("/api/v2/approvals")
    }
}
