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
    /// Labels the minimap tick; `prompt` and `reply` fill its hover preview.
    public let excerpt: String
    public let prompt: String
    public internal(set) var reply = ""
    public init(_ message: Message) {
        id = message.id
        excerpt = String((message.content.components(separatedBy: "\n").first ?? "").prefix(60))
        prompt = Self.plain(message.content, length: 120)
    }
    /// Each user prompt, with the first reply that followed it.
    public static func extract(_ messages: [Message]) -> [Self] {
        var turns: [Self] = []
        for message in messages where message.isProgress != true {
            if message.role == "user" { turns.append(Self(message)) }
            else if message.role == "assistant", let last = turns.indices.last, turns[last].reply.isEmpty {
                turns[last].reply = plain(message.content, length: 220)
            }
        }
        return turns
    }
    /// Markdown reduced to one line of readable text. Only the start of a long reply is read.
    public static func plain(_ text: String, length: Int) -> String {
        var value = String(text.prefix(length * 8))
        for (pattern, template) in [("(?s)```.*?(```|$)", " "), ("!\\[[^\\]]*\\]\\([^)]*\\)", " "), ("\\[([^\\]]*)\\]\\([^)]*\\)", "$1"),
                                    ("(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+\\.)\\s+", ""), ("\\*\\*|__|~~|`", ""), ("\\s+", " ")] {
            value = value.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        value = value.trimmingCharacters(in: .whitespaces)
        return value.count > length ? String(value.prefix(length - 1)).trimmingCharacters(in: .whitespaces) + "…" : value
    }
}
