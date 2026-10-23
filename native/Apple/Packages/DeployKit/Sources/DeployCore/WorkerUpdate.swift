import Foundation

/// Coordinator-projected information. Capability reports never grant access.
public struct WorkerBuild: Decodable, Equatable, Sendable {
    public let version: String
    public let commit: String?
}

public struct WorkerUpdate: Decodable, Equatable, Sendable {
    public let state: String
    public let reason: String
    public let missingTools: [String]
    public var needsUpdate: Bool { state == "outdated" || state == "unknown" }

    public func instruction(platform: String) -> String {
        switch platform {
        case "darwin": "Install the latest deploy.local worker on this Mac, then restart its worker service."
        case "linux": "Install the latest deploy.local worker on this computer. For deploy.local Node, install the latest .deb or replace the AppImage in its existing location, then quit and reopen Node."
        default: "Install the latest deploy.local worker on this computer."
        }
    }
}
