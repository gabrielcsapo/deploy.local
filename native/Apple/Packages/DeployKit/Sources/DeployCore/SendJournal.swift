import Foundation

struct SendBody: Codable, Equatable {
    let operationId: String
    let revision: Int
    let content: String
    let model: String?
    let effort: String?
    let adapter: String
    var attachmentIds: [String]? = nil
}

/// Write before dispatch, retain on ambiguous transport failures, remove after acknowledgment.
/// Reopening a client never turns a retry into a second message. No tokens are stored here.
@MainActor final class SendJournal {
    private struct Entry: Codable {
        let origin: String
        let username: String
        let taskId: String
        let body: SendBody
    }
    private let url: URL
    init(url: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("deploy.local/pending-sends.json")) { self.url = url }

    private func origin(_ connection: Connection) throws -> String {
        var parts = URLComponents(url: try connection.baseURL(), resolvingAgainstBaseURL: true)!
        parts.host = parts.host?.lowercased()
        parts.path = ""
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) { parts.port = nil }
        return parts.string!
    }
    private func read() throws -> [Entry] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        // Corruption must not silently discard a potentially accepted operation ID.
        return try JSONDecoder().decode([Entry].self, from: Data(contentsOf: url))
    }
    private func write(_ entries: [Entry]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(entries).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func prepare(connection: Connection, taskId: String, proposed: SendBody) throws -> SendBody {
        let scope = try origin(connection)
        var entries = try read()
        if let prior = entries.first(where: {
            $0.origin == scope && $0.username == connection.username && $0.taskId == taskId &&
            $0.body.content == proposed.content && $0.body.model == proposed.model &&
            $0.body.effort == proposed.effort && $0.body.adapter == proposed.adapter &&
            ($0.body.attachmentIds ?? []) == (proposed.attachmentIds ?? [])
        }) { return prior.body }
        entries.append(Entry(origin: scope, username: connection.username, taskId: taskId, body: proposed))
        try write(entries)
        return proposed
    }
    func acknowledge(connection: Connection, operationId: String) throws {
        let scope = try origin(connection)
        let entries = try read().filter { !($0.origin == scope && $0.username == connection.username && $0.body.operationId == operationId) }
        try write(entries)
    }
}
