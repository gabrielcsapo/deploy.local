import Foundation

/// Device-local preferences partitioned by coordinator and account, never sent to the server.
public struct SidebarPreferences {
    private let defaults: UserDefaults
    private let key: String
    public init(origin: String, account: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        key = "deploy.workspace.pinned.\(origin)|\(account)"
    }
    public var pins: Set<String> { Set(defaults.stringArray(forKey: key) ?? []) }
    @discardableResult public func toggle(_ id: String) -> Set<String> {
        var next = pins
        if !next.insert(id).inserted { next.remove(id) }
        defaults.set(next.sorted(), forKey: key)
        return next
    }
}

public struct TranscriptTurn: Identifiable, Equatable, Sendable {
    public let id: String
    public let excerpt: String
    public init(_ message: Message) {
        id = message.id
        excerpt = String((message.content.components(separatedBy: "\n").first ?? "").prefix(60))
    }
    public static func extract(_ messages: [Message]) -> [Self] {
        messages.filter { $0.role == "user" && $0.isProgress != true }.map(Self.init)
    }
}
