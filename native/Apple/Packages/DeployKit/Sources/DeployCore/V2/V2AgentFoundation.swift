import Foundation

public struct V2AgentAvatar: Codable, Equatable, Sendable {
    public var glyph: String
    public var color: String
    public init(glyph: String, color: String) { self.glyph = glyph; self.color = color }
    public static let colors = ["#af61f2", "#76a7ff", "#75c675", "#e8b130", "#ff4d6f", "#525fa3", "#2fb5a3", "#ffaa64", "#e66bb8", "#8c8c8c"]
    public static let glyphs = (1...35).map { String(format: "variant%02d", $0) }
    public static func random() -> Self { Self(glyph: glyphs.randomElement()!, color: colors.randomElement()!) }
    public static func from(id: String) -> Self {
        var hash: UInt32 = 2166136261
        for unit in id.utf16 { hash = (hash ^ UInt32(unit)) &* 16777619 }
        return Self(glyph: glyphs[Int(hash % 35)], color: colors[Int(hash / 35 % 10)])
    }
}
public struct V2LooksAfterItem: Codable, Identifiable, Equatable, Sendable {
    public enum Scope: Codable, Equatable, Sendable {
        case allActive, activeAndMaintained, projects([String])
        private struct Projects: Codable { var projects: [String] }
        public init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let value = try? c.decode(String.self) {
                switch value { case "all-active": self = .allActive; case "active-and-maintained": self = .activeAndMaintained; default: throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid project scope") }
            } else { self = .projects(try c.decode(Projects.self).projects) }
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self { case .allActive: try c.encode("all-active"); case .activeAndMaintained: try c.encode("active-and-maintained"); case .projects(let ids): try c.encode(Projects(projects: ids)) }
        }
        public var label: String { switch self { case .allActive: "All Active"; case .activeAndMaintained: "All Active and Maintained"; case .projects: "Chosen projects" } }
    }
    public struct When: Codable, Equatable, Sendable {
        public var every: String
        public var day: Int?
        public var time: String
        public var timezone: String
        public init(every: String = "week", day: Int? = 1, time: String = "08:40", timezone: String = TimeZone.current.identifier) { self.every = every; self.day = day; self.time = time; self.timezone = timezone }
    }
    public var id: String
    public var what: String
    public var `where`: Scope
    public var when: When
    public var brings: String
    public var confirmedAt: String?
    public var nextAt: String?
    public init(id: String = UUID().uuidString, what: String = "", where scope: Scope = .allActive, when: When = .init(), brings: String = "message") { self.id = id; self.what = what; self.where = scope; self.when = when; self.brings = brings }
    public var whenLabel: String {
        if when.every == "change" { return "On each change" }
        let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return "\(when.every == "week" ? days[min(6, max(0, when.day ?? 1))] : "Every day") \(when.time)"
    }
    public func summary(projects: [V2Project]) -> String {
        let scope: String
        if case .projects(let ids) = self.where { scope = ids.map { id in projects.first { $0.id == id }?.name ?? id }.joined(separator: ", ") }
        else { scope = self.where.label }
        return "\(scope) · \(whenLabel) · brings a \(brings.replacingOccurrences(of: "-", with: " "))"
    }
}
public struct V2AgentConversation: Decodable, Sendable { public var events: [ConversationEvent] }
public struct V2AgentRun: Decodable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var at: String
    public var status: String
    public var itemId: String?
}
public struct V2AgentEdit: Encodable, Sendable {
    public var name: String?
    public var job: String?
    public var avatar: V2AgentAvatar?
    public var projectId: String?
    public var computers: [String]?
    public var looksAfter: [V2LooksAfterItem]?
    public init(name: String? = nil, job: String? = nil, avatar: V2AgentAvatar? = nil, projectId: String? = nil, computers: [String]? = nil, looksAfter: [V2LooksAfterItem]? = nil) { self.name = name; self.job = job; self.avatar = avatar; self.projectId = projectId; self.computers = computers; self.looksAfter = looksAfter }
}
extension V2Client {
    public func agentTimezone() async throws -> String {
        struct Response: Decodable, Sendable { var timezone: String? }
        let value: Response = try await client.request("/api/v2/agents")
        return value.timezone ?? TimeZone.current.identifier
    }
    public func agentConversation(_ id: String) async throws -> V2AgentConversation { try await client.request("/api/v2/agents/\(Self.segment(id))/conversation") }
    public func sendAgent(_ id: String, text: String, operationId: String, model: String? = nil) async throws -> V2AgentConversation {
        struct Body: Encodable { var text: String; var operationId: String; var model: String? }
        return try await client.request("/api/v2/composer/agents/\(Self.segment(id))/messages", method: "POST", body: JSONEncoder().encode(Body(text: text, operationId: operationId, model: model)))
    }
    public func editAgent(_ id: String, values: V2AgentEdit) async throws -> V2Agent {
        struct Response: Decodable, Sendable { var agent: V2Agent }
        let r: Response = try await client.request("/api/v2/agents/\(Self.segment(id))", method: "PATCH", body: JSONEncoder().encode(values))
        return r.agent
    }
    public func confirmAgentItem(_ id: String, item: String) async throws -> V2Agent {
        struct Response: Decodable, Sendable { var agent: V2Agent }
        let r: Response = try await client.request("/api/v2/agents/\(Self.segment(id))/items/\(Self.segment(item))/confirm", method: "POST", body: Data("{}".utf8))
        return r.agent
    }
    public func runAgentItem(_ id: String, item: String) async throws -> String {
        struct Response: Decodable, Sendable { struct Task: Decodable, Sendable { var id: String }; var task: Task }
        let value: Response = try await client.request("/api/v2/agents/\(Self.segment(id))/items/\(Self.segment(item))/run", method: "POST", body: Data("{}".utf8))
        return value.task.id
    }
    public func agentItemRuns(_ id: String, item: String) async throws -> [V2AgentRun] {
        struct Response: Decodable, Sendable { var runs: [V2AgentRun] }
        let r: Response = try await client.request("/api/v2/agents/\(Self.segment(id))/items/\(Self.segment(item))/runs")
        return r.runs
    }
    public func deleteAgent(_ id: String) async throws {
        struct Response: Decodable, Sendable { var deleted: String }
        let _: Response = try await client.request("/api/v2/agents/\(Self.segment(id))", method: "DELETE")
    }
}
