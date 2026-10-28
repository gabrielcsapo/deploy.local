import Foundation

public struct V2NotificationPreferences: Codable, Equatable, Sendable {
    public var decisions: Bool
    public var failingApps: Bool
    public var quietHours: Bool
    public var timeZone: String
}
public struct V2AgentControl: Codable, Equatable, Sendable {
    public var paused: Bool
    public var mutedUntil: String?
}
public struct V2PairedDeviceSummary: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: String
}
extension V2Client {
    public func notificationPreferences() async throws -> V2NotificationPreferences {
        try await client.request("/api/v2/notifications")
    }
    public func saveNotificationPreferences(_ preferences: V2NotificationPreferences) async throws -> V2NotificationPreferences {
        try await client.request("/api/v2/notifications", method: "PATCH", body: JSONEncoder().encode(preferences))
    }
    public func agentControl(_ agent: String) async throws -> V2AgentControl {
        try await client.request("/api/v2/agents/\(Self.segment(agent))/control")
    }
    public func changeAgentControl(_ agent: String, paused: Bool? = nil, muteMinutes: Int? = nil) async throws -> V2AgentControl {
        struct Body: Encodable { let paused: Bool?; let muteMinutes: Int? }
        return try await client.request("/api/v2/agents/\(Self.segment(agent))/control", method: "PATCH", body: JSONEncoder().encode(Body(paused: paused, muteMinutes: muteMinutes)))
    }
    public func pairedDevices() async throws -> [V2PairedDeviceSummary] {
        struct Response: Decodable, Sendable { let devices: [V2PairedDeviceSummary] }
        let response: Response = try await client.request("/api/v2/devices")
        return response.devices
    }
    public func revokeDevice(_ id: String) async throws {
        struct Response: Decodable, Sendable { let removed: Bool? }
        let _: Response = try await client.request("/api/v2/devices/\(Self.segment(id))", method: "DELETE")
    }
}
