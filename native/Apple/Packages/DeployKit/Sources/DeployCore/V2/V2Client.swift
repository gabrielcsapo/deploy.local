import Foundation
import CryptoKit

public struct V2Project: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var summary: String?
    public var apps: [V2ProjectApp]?
}
public struct V2Task: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var projectId: String?
    public var workerId: String?
    public var status: String
    public var revision: Int
    public var createdAt: String
    public var updatedAt: String
}
public struct V2Worker: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var status: String
    public var capabilities: [String]
    public var modelOptions: [V2ModelProvider]?
}
public struct V2ModelProvider: Codable, Equatable, Sendable {
    public var id: String
    public var models: [V2Model]
}
public struct V2Model: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
}
public struct V2Workspace: Codable, Equatable, Sendable {
    public var cursor: Int
    public var projects: [V2Project]
    public var tasks: [V2Task]
    public var workers: [V2Worker]
}
public struct V2Computer: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var online: Bool?
    public var kind: String?
    public var status: String?
    public var roles: [String]?
}
public struct V2Account: Codable, Equatable, Sendable {
    public var username: String
    public var role: String?
}
public struct V2LiveApp: Codable, Identifiable, Equatable, Sendable {
    public var id: String { appId }
    public var appId: String
    public var name: String
    public var kind: AppKind
    public var state: HealthState
    public var summary: String
    public var project: String?
    public var address: String?
    public var release: String?
    public var releasedAt: String?
    public var http: HTTPHealth?
    public var jobs: JobHealth?
    public var queue: QueueHealth?
    public var restarts: RestartHealth?
    public var heartbeatAt: String?
}
public struct V2Live: Codable, Equatable, Sendable {
    public struct Summary: Codable, Equatable, Sendable {
        public var running: Int
        public var failing: Int
        public var warning: Int
        public var checkedAt: String
    }
    public struct Computer: Codable, Identifiable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var online: Bool
        public var roles: [Role]
        public var apps: [V2LiveApp]
        public var cpu: Double?
        public var memory: Double?
        public var disk: Double?
    }
    public var summary: Summary
    public var computers: [Computer]
}
public struct V2LiveDetail: Codable, Equatable, Sendable {
    public struct Sample: Codable, Equatable, Sendable {
        public var at: String
        public var failRate: Double?
        public var p95ms: Double?
    }
    public var app: V2LiveApp
    public var history: [Sample]
}
public struct V2Event: Codable, Equatable, Sendable {
    public var cursor: Int
    /// Null for events that belong to no task, like a background job's work log.
    public var taskId: String?
    public var at: String
    public var type: String
    public var item: InboxItem?
    public var app: AppHealth?
    public var event: ConversationEvent?
    public var release: Release?
    public var rollback: Rollback?
}
public struct V2EventPage: Codable, Equatable, Sendable {
    public var events: [V2Event]
    public var cursor: Int
    public var supportsWait: Bool?
}
public struct V2AnswerResult: Sendable {
    public let item: InboxItem
    public let alreadyAnswered: Bool
}

public actor V2Client {
    public let connection: Connection
    let client: WorkspaceClient
    public init(connection: Connection, session: URLSession? = nil) {
        self.connection = connection
        if let session { client = WorkspaceClient(connection: connection, session: session) }
        else if let pinned = V2PairingVault.session(for: connection) { client = WorkspaceClient(connection: connection, session: pinned) }
        else { client = WorkspaceClient(connection: connection) }
    }
    public static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
    public func inbox(state: String = "waiting") async throws -> [InboxItem] {
        struct Response: Decodable, Sendable { var items: [InboxItem] }
        let response: Response = try await client.request("/api/v2/inbox?state=\(Self.segment(state))")
        return response.items
    }
    public func answer(_ id: String, action: String, note: String? = nil) async throws -> V2AnswerResult {
        struct Body: Encodable { let actionId: String; let on = "iphone"; let note: String? }
        struct Response: Decodable, Sendable { let item: InboxItem }
        do {
            let result: Response = try await client.request("/api/v2/inbox/\(Self.segment(id))/answer", method: "POST", body: JSONEncoder().encode(Body(actionId: action, note: note)))
            return V2AnswerResult(item: result.item, alreadyAnswered: false)
        } catch ClientError.response(409, _) {
            // The first answer wins. Read its authoritative record, never retry the command.
            guard let item = try await inbox(state: "answered").first(where: { $0.id == id }) else {
                throw ClientError.response(409, "This decision changed. Refresh Waiting on you.")
            }
            return V2AnswerResult(item: item, alreadyAnswered: true)
        }
    }
    public func events(after: Int, wait: Bool = true) async throws -> V2EventPage {
        try await client.request("/api/v2/events?after=\(after)&waitMs=\(wait ? 10000 : 0)", timeout: 20)
    }
    public func live() async throws -> V2Live { try await client.request("/api/v2/live") }
    public func liveApp(_ id: String) async throws -> V2LiveDetail { try await client.request("/api/v2/live/\(Self.segment(id))") }
    public func workspace() async throws -> V2Workspace { try await client.request("/api/workspace/state") }
    public func projects(fallback: [V2Project]) async throws -> [V2Project] {
        struct Response: Decodable, Sendable {
            let projects: [V2Project]
            private enum CodingKeys: CodingKey { case projects }
            init(from decoder: Decoder) throws {
                if let array = try? decoder.singleValueContainer().decode([V2Project].self) { projects = array }
                else { projects = try decoder.container(keyedBy: CodingKeys.self).decode([V2Project].self, forKey: .projects) }
            }
        }
        do {
            let response: Response = try await client.request("/api/v2/projects")
            return response.projects
        } catch ClientError.response(let status, _) where status == 404 || status == 501 { return fallback }
    }
    public func computers() async throws -> [V2Computer] {
        struct Response: Decodable, Sendable { let nodes: [V2Computer] }
        let response: Response = try await client.request("/api/nodes")
        return response.nodes
    }
    public func account() async throws -> V2Account { try await client.request("/api/user") }
    public func task(_ id: String) async throws -> TaskDetail { try await client.request("/api/workspace/tasks/\(Self.segment(id))") }
    public func diff(_ id: String) async throws -> TaskDiff { try await client.request("/api/workspace/tasks/\(Self.segment(id))/diff") }
    public func createTask(operationId: String, title: String, projectId: String?, workerId: String) async throws -> V2Task {
        struct Body: Encodable { let operationId: String; let title: String; let projectId: String?; let workerId: String }
        return try await client.request("/api/workspace/tasks", method: "POST", body: JSONEncoder().encode(Body(operationId: operationId, title: title, projectId: projectId, workerId: workerId)))
    }
    public func send(taskId: String, operationId: String, revision: Int, text: String, model: String?, adapter: String) async throws {
        let body = SendBody(operationId: operationId, revision: revision, content: text, model: model, effort: nil, adapter: adapter)
        let _: Run = try await client.request("/api/workspace/tasks/\(Self.segment(taskId))/messages", method: "POST", body: JSONEncoder().encode(body))
    }
    public static func notificationScope(_ connection: Connection) -> String {
        var parts = URLComponents(string: connection.origin)
        let host = parts?.host?.lowercased()
        parts?.host = host; parts?.path = ""
        if parts?.port == 443 && parts?.scheme == "https" { parts?.port = nil }
        return SHA256.hash(data: Data(((parts?.string ?? connection.origin) + "|" + connection.username).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    public func handleNotification(scope: String?, itemId: String, action: String, actionId: String) async throws -> V2AnswerResult? {
        guard scope == Self.notificationScope(connection), ["approve", "not-now"].contains(action) else { return nil }
        guard let item = try await inbox().first(where: { $0.id == itemId }),
              let offered = item.actions.first(where: { $0.id == actionId }), offered.confirm == nil else { return nil }
        if action == "approve" {
            guard offered.primary == true, offered.id != "answer" else { return nil }
        } else {
            guard ["dismiss", "skip", "deny"].contains(offered.id) else { return nil }
        }
        return try await answer(itemId, action: actionId)
    }
    public func registerDevice(token: String, environment: String) async throws {
        let _: JSONValue = try await client.request("/api/v2/devices", method: "POST", body: JSONEncoder().encode(["token": token, "environment": environment, "scope": Self.notificationScope(connection)]))
    }
    public func removeDevice(token: String) async throws {
        let _: JSONValue = try await client.request("/api/v2/devices", method: "DELETE", body: JSONEncoder().encode(["token": token]))
    }
}
