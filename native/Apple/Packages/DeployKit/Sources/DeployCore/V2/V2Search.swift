import Foundation

/// One search across deploy.local: names and messages answer at once, code a moment later.
/// The shapes follow `server/v2/search.ts`.
public struct V2SearchName: Codable, Identifiable, Equatable, Sendable {
    public var kind: String
    public var id: String
    public var title: String
    public var projectId: String?
    public var project: String?
    public var status: String?
    public var agent: String?
    public var at: String?
}
public struct V2SearchMessage: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var taskId: String?
    public var agentId: String?
    public var title: String
    public var who: String
    public var fromYou: Bool
    public var at: String
    public var snippet: String
}
public struct V2SearchResults: Codable, Equatable, Sendable {
    public struct Messages: Codable, Equatable, Sendable {
        public var total: Int
        public var items: [V2SearchMessage]
    }
    public var query: String
    public var names: [V2SearchName]
    public var messages: Messages
    public var tasks: [V2SearchName] { names.filter { $0.kind == "task" } }
}
public struct V2SearchCode: Codable, Equatable, Sendable {
    public struct Line: Codable, Identifiable, Equatable, Sendable {
        public var projectId: String
        public var project: String
        public var ref: String
        public var path: String
        public var line: Int
        public var text: String
        public var id: String { "\(projectId):\(path):\(line)" }
    }
    public var query: String
    public var lines: Int
    public var files: Int
    public var truncated: Bool
    public var items: [Line]
    /// What a search that could not be read shows: nothing found.
    public static func none(_ query: String) -> V2SearchCode { V2SearchCode(query: query, lines: 0, files: 0, truncated: false, items: []) }
    /// "12 lines in 5 files", with a plus when the search stopped early.
    public var count: String {
        let more = truncated ? "+" : ""
        return "\(lines)\(more) \(lines == 1 ? "line" : "lines") in \(files)\(more) \(files == 1 ? "file" : "files")"
    }
}

public enum V2SearchText {
    /// Code and messages are searched from this many characters.
    public static let textMinimum = 3
    /// `text` cut at every match of `query`, ignoring case; odd entries are the matches.
    public static func parts(_ text: String, matching query: String) -> [String] {
        guard !query.isEmpty else { return [text] }
        var parts: [String] = []
        var rest = text[...]
        while let range = rest.range(of: query, options: .caseInsensitive) {
            parts.append(String(rest[..<range.lowerBound]))
            parts.append(String(rest[range]))
            rest = rest[range.upperBound...]
        }
        parts.append(String(rest))
        return parts
    }
    /// The web page that shows a code result at its line; iPhone has no file viewer of its own.
    public static func codePath(_ line: V2SearchCode.Line, query: String) -> String {
        var components = URLComponents()
        // The segment is already escaped (dots included), so it must not be escaped again.
        components.percentEncodedPath = "/dashboard/projects/\(V2Client.segment(line.projectId))/code"
        components.queryItems = [
            URLQueryItem(name: "ref", value: line.ref), URLQueryItem(name: "file", value: line.path),
            URLQueryItem(name: "line", value: String(line.line)), URLQueryItem(name: "find", value: query),
        ]
        return components.string ?? components.percentEncodedPath
    }
}

extension V2Client {
    private static func searchQuery(_ text: String, _ extra: [URLQueryItem] = []) -> String {
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "q", value: text)] + extra
        return components.percentEncodedQuery ?? ""
    }
    public func search(_ text: String) async throws -> V2SearchResults {
        try await client.request("/api/search?\(Self.searchQuery(text))")
    }
    public func searchCode(_ text: String, limit: Int = 2) async throws -> V2SearchCode {
        try await client.request("/api/search/code?\(Self.searchQuery(text, [URLQueryItem(name: "limit", value: String(limit))]))", timeout: 40)
    }
}
