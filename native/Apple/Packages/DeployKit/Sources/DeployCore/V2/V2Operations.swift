import Foundation

public struct V2ProjectApp: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var kind: AppKind
}
public struct V2Backup: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var projectId: String?
    public var apps: [String]
    public var kind: String
    public var createdAt: String
    public var sizeBytes: Double?
    public var contents: [String]
    public var destination: String
    public var computer: String
    public var releaseId: String?
    public var verified: Bool
    public var testedAt: String?
    public var testStatus: String
    public var restoreAvailable: Bool
    public var unavailableReason: String?
}
public struct V2Restore: Codable, Identifiable, Equatable, Sendable {
    public struct Address: Codable, Equatable, Sendable {
        public var app: String
        public var url: String
        public var isCoordinatorOnly: Bool {
            guard let host = URL(string: url)?.host?.lowercased() else { return true }
            return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        }
    }
    public var id: String
    public var backupId: String
    public var projectId: String
    public var state: String
    public var createdAt: String
    public var addresses: [Address]
    public var releaseId: String?
    public var retainedBackupId: String?
    public var error: String?
    public var canCancel: Bool { ["ready", "failed"].contains(state) && releaseId == nil }
}
public struct V2Backups: Codable, Sendable {
    public var backups: [V2Backup]
    public var restores: [V2Restore]
}

extension V2Client {
    public func releases(project: String) async throws -> [Release] {
        struct Response: Decodable, Sendable { var releases: [Release] }
        let response: Response = try await client.request("/api/v2/projects/\(Self.segment(project))/releases")
        return response.releases
    }
    public func release(_ id: String) async throws -> Release {
        struct Response: Decodable, Sendable { var release: Release }
        let response: Response = try await client.request("/api/v2/releases/\(Self.segment(id))")
        return response.release
    }
    public func ship(project: String, task: String, ref: String) async throws -> Release {
        struct Body: Encodable { var source: ReleaseSource; var ref: String }
        struct Response: Decodable, Sendable { var release: Release }
        let response: Response = try await client.request("/api/v2/projects/\(Self.segment(project))/releases", method: "POST", body: JSONEncoder().encode(Body(source: ReleaseSource(kind: .ship, ref: task), ref: ref)))
        return response.release
    }
    public func rollbacks(project: String) async throws -> [Rollback] {
        struct Response: Decodable, Sendable { var rollbacks: [Rollback] }
        let response: Response = try await client.request("/api/v2/projects/\(Self.segment(project))/rollbacks")
        return response.rollbacks
    }
    public func rollback(project: String, from: String, to: String) async throws -> Rollback {
        struct Response: Decodable, Sendable { var rollback: Rollback }
        // Data-loss confirmation is intentionally never inferred from a normal code rollback.
        let response: Response = try await client.request("/api/v2/projects/\(Self.segment(project))/rollback", method: "POST", body: JSONEncoder().encode(["from": from, "to": to, "reason": "Requested on iPhone"]))
        return response.rollback
    }
    public func backups() async throws -> V2Backups { try await client.request("/api/v2/backups") }
    public func restore(backup: String) async throws -> V2Restore {
        struct Response: Decodable, Sendable { var restore: V2Restore }
        let response: Response = try await client.request("/api/v2/backups/\(Self.segment(backup))/restore", method: "POST", body: Data("{}".utf8), timeout: 120)
        return response.restore
    }
    public func switchRestore(_ restore: V2Restore, checked: Bool) async throws -> V2Restore {
        guard restore.state == "ready", checked else { throw ClientError.response(409, "Check the copy before switching.") }
        return try await restoreAction(restore, action: "switch", body: Data("{\"confirm\":true}".utf8))
    }
    public func cancelRestore(_ restore: V2Restore) async throws -> V2Restore {
        guard restore.canCancel else { throw ClientError.response(409, "This restore cannot be cancelled after Switch starts.") }
        return try await restoreAction(restore, action: "cancel", body: Data("{}".utf8))
    }
    private func restoreAction(_ restore: V2Restore, action: String, body: Data) async throws -> V2Restore {
        struct Response: Decodable, Sendable { var restore: V2Restore }
        let response: Response = try await client.request("/api/v2/backups/\(Self.segment(restore.backupId))/restore/\(Self.segment(restore.id))/\(action)", method: "POST", body: body, timeout: 120)
        return response.restore
    }
    public func projectWork(_ project: String, kind: String) async throws -> [ProjectWorkItem] {
        guard ["pulls", "issues"].contains(kind) else { throw ClientError.invalidResponse }
        let response: ProjectWorkResponse = try await client.request("/api/workspace/projects/\(Self.segment(project))/\(kind)")
        return response.items ?? []
    }
    /// A project's design in design/: how many boards it has and how many designs wait on you. Nil without one.
    public func designSummary(project: String) async throws -> V2DesignSummary? {
        struct Design: Decodable, Sendable { struct Canvas: Decodable, Sendable { let boards: [String: JSONValue] }; let canvas: Canvas? }
        struct Proposals: Decodable, Sendable { struct Proposal: Decodable, Sendable { let state: String }; let proposals: [Proposal] }
        let base = "/api/v2/projects/\(Self.segment(project))/design"
        let design: Design
        do { design = try await client.request(base) }
        catch ClientError.response(let status, _) where [404, 409, 422].contains(status) { return nil }
        guard let canvas = design.canvas, !canvas.boards.isEmpty else { return nil }
        let proposals: Proposals? = try? await client.request("\(base)/proposals")
        return V2DesignSummary(boards: canvas.boards.count, waiting: proposals?.proposals.filter { $0.state == "waiting" }.count ?? 0)
    }
    /// One design review: the request, Before and After, and each changed board.
    public func designReview(project: String, item: String) async throws -> V2DesignReview {
        try await client.request("/api/v2/projects/\(Self.segment(project))/design/review?item=\(Self.segment(item))")
    }
    /// A board rendered at a commit and width, as PNG.
    public func designImage(project: String, board: String, commit: String, width: Int) async throws -> Data {
        try await client.data("/api/v2/projects/\(Self.segment(project))/design/render?ref=\(Self.segment(commit))&board=\(Self.segment(board))&width=\(width)", timeout: 60)
    }
    public func repository(_ project: String) async throws -> RepositoryInfo {
        try await client.request("/api/workspace/projects/\(Self.segment(project))/repository")
    }
}

public struct V2DesignReview: Decodable, Sendable {
    public struct Board: Decodable, Sendable, Identifiable {
        public let file: String
        public let title: String
        public let w: Int
        public let h: Int
        public let page: String?
        public let index: Int?
        public let count: Int?
        public let added: Bool
        public let removed: Bool?
        public var isRemoved: Bool { removed ?? false }
        public let notes: String?
        public let lines: [String]
        public var id: String { file }
        public var name: String { file.replacingOccurrences(of: ".html", with: "") }
        public var isPhone: Bool { w <= 500 }
    }
    /// A canvas note the branch rewrote, line by line: what went in Before, what is new in After.
    public struct Note: Decodable, Sendable, Identifiable {
        public struct Line: Decodable, Sendable, Hashable {
            public let text: String
            public let gone: Bool?
            public let added: Bool?
            public var marked: Bool { (gone ?? false) || (added ?? false) }
        }
        public let id: String
        public let title: String
        public let page: String?
        public let before: [Line]?
        public let after: [Line]?
        public let changed: Int
        public let total: Int
    }
    public let item: InboxItem
    public let task: String?
    public let branch: String
    public let before: String
    public let after: String
    public let boards: [Board]
    let notes: [Note]?
    /// Older coordinators send no notes.
    public var changedNotes: [Note] { notes ?? [] }
    /// A design review's inbox ID names its project: design:<project>:<branch>:<commit>.
    public static func project(of itemId: String) -> String? {
        let parts = itemId.split(separator: ":", omittingEmptySubsequences: false)
        return parts.count >= 4 && parts[0] == "design" ? String(parts[1]) : nil
    }
}

public struct V2DesignSummary: Equatable, Sendable {
    public let boards: Int
    public let waiting: Int
    public init(boards: Int, waiting: Int) { self.boards = boards; self.waiting = waiting }
    /// "1 to review · 168 boards", as the project screen says it.
    public var subtitle: String {
        let boards = "\(self.boards) board\(self.boards == 1 ? "" : "s")"
        return waiting > 0 ? "\(waiting) to review · \(boards)" : boards
    }
}

public enum V2Labels {
    public static func agentName(_ item: InboxItem) -> String {
        if let name = item.fromName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return item.from == "scout" ? "Scout" : item.from == "warden" ? "Warden" : "An agent"
    }
    public static func questionOptions(_ item: InboxItem) -> [InboxAction] {
        let options = item.actions.filter { !["answer", "dismiss"].contains($0.id) }
        return options.filter { $0.primary == true } + options.filter { $0.primary != true }
    }
    public static func askedTime(_ value: String, now: Date = Date()) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = iso.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "Asked · time unavailable" }
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return "Asked just now" }
        let amount = minutes < 60 ? "\(minutes)m" : minutes < 1440 ? "\(minutes / 60)h" : "\(minutes / 1440)d"
        return "Asked \(amount) ago"
    }

    public static func outcome(_ item: InboxItem) -> String {
        guard let answer = item.answer else { return item.state.rawValue.capitalized }
        if ["dismiss", "skip", "deny", "not-now"].contains(answer.actionId) { return "Not now" }
        if answer.actionId == "answer" { return "Answered" }
        if item.actions.first(where: { $0.id == answer.actionId })?.primary == true { return "Approved" }
        return "Answered"
    }
    public static func shortDate(_ value: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = iso.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "Unavailable" }
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now) { formatter.dateFormat = "h:mm" }
        else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        else { formatter.setLocalizedDateFormatFromTemplate("MMMd") }
        return formatter.string(from: date)
    }
}
