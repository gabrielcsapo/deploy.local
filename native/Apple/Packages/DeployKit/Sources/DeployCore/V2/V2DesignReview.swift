import Foundation

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
        public var widths: [Int]?
        public var pageId: String?
        public var status: String?
        public var before: String?
        public var after: String?
        public var changes: [V2ReviewChange]?
        public var seen: Bool?
        public var changedSinceReview: Bool?
        public var conflict: Bool?
        public var previewWidths: [Int] { widths ?? [isPhone ? w : 1440] }
        public var defaultWidth: Int { previewWidths.contains(w) ? w : (previewWidths.first ?? w) }
        public var changeKind: String { status ?? (added ? "new" : isRemoved ? "removed" : "changed") }
        public var id: String { file }
        public var name: String { title }
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
    public var item: InboxItem
    public let task: String?
    public let branch: String
    public let before: String
    public let after: String
    public var boards: [Board]
    public var id: String?
    public var title: String?
    public var summary: String?
    public var projectId: String?
    public var project: String?
    public var proposer: V2ReviewProposer?
    public var counts: V2ReviewCounts?
    public var createdAt: String?
    public var main: String?
    public var updatedWithMainAt: String?
    public var round: Int?
    public var previousItemId: String?
    public var stale: Bool?
    public var conflicts: [String]?
    public var groups: [V2ReviewGroup]?
    public var pins: [V2ReviewPin]?
    let notes: [Note]?
    /// Older coordinators send no notes.
    public var changedNotes: [Note] { notes ?? [] }
    /// A design review's inbox ID names its project: design:<project>:<branch>:<commit>.
    public static func project(of itemId: String) -> String? {
        let parts = itemId.split(separator: ":", omittingEmptySubsequences: false)
        return parts.count >= 4 && parts[0] == "design" ? String(parts[1]) : nil
    }
}

public struct V2ReviewRect: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
}
public struct V2ReviewChange: Decodable, Sendable {
    public var layer: String
    public var words: String
}
public struct V2ReviewPreview: Decodable, Sendable {
    public struct Area: Decodable, Sendable {
        public var layer: String
        public var words: String
        public var before: V2ReviewRect?
        public var after: V2ReviewRect?
    }
    public var width: Int
    public var height: Int
    public var before: String?
    public var after: String?
    public var areas: [Area]
    public var crop: V2ReviewRect
}
public struct V2ReviewPin: Decodable, Identifiable, Sendable {
    public var id: String
    public var number: Int
    public var board: String
    public var noteId: String?
    public var width: Int
    public var revision: String
    public var x: Double
    public var y: Double
    public var text: String
    public var author: String
    public var resolved: Bool
    public var reply: String?
    public var createdAt: String
}
public struct V2ReviewPinDraft: Encodable, Sendable {
    public var item: String
    public var board: String
    public var width: Int
    public var revision: String
    public var x: Double
    public var y: Double
    public var text: String
    public var noteId: String?
    public init(item: String, board: String, width: Int, revision: String, x: Double, y: Double, text: String = "", noteId: String? = nil) {
        self.item = item; self.board = board; self.width = width; self.revision = revision
        self.x = x; self.y = y; self.text = text; self.noteId = noteId
    }
}
public struct V2ReviewProposer: Decodable, Sendable {
    public var id: String?
    public var name: String
    public var avatar: V2AgentAvatar?
    /// The server names a proposer with no agent or task "You".
    public var isYou: Bool { id == nil && name == "You" }
    public var missingSummary: String { isYou ? "No summary. Add one when you propose again." : "No summary. Ask \(name) to add one" }
}
public struct V2ReviewCounts: Decodable, Sendable {
    public var screens: Int
    public var changed: Int
    public var new: Int
    public var removed: Int
    public func label(includeRemoved: Bool = true) -> String {
        var parts = [V2ReviewModel.count(screens, "screen"), "\(changed) changed", "\(new) new"]
        if includeRemoved { parts.append("\(removed) removed") }
        return parts.joined(separator: " · ")
    }
}
public struct V2ReviewGroup: Decodable, Sendable {
    public var id: String?
    public var title: String?
    public var boards: [String]
}
public struct V2ReviewSummary: Decodable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var summary: String?
    public var projectId: String
    public var project: String
    public var branch: String
    public var proposer: V2ReviewProposer
    public var createdAt: String
    public var counts: V2ReviewCounts
    public var stale: Bool
    public var conflicts: [String]
    public var inboxSubtitle: String {
        stale ? V2ReviewModel.conflictCount(conflicts) : "Design · \(V2ReviewModel.count(counts.screens, "screen")) · \(proposer.name)"
    }
}
public struct V2DesignProject: Decodable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var description: String?
    public var boards: Int
}

/// Pure navigation and decision rules shared by the pager and its tests.
public enum V2ReviewModel {
    public enum Page: Hashable, Sendable {
        case cover, screen(String), note(String), decide
    }
    public enum PrimaryAction: Equatable, Sendable {
        case approve, changes(Int), update
        public var title: String {
            switch self {
            case .approve: "Approve design"
            case .changes(let count): "Ask for \(V2ReviewModel.count(count, "change"))"
            case .update: "Ask to update"
            }
        }
    }
    public static func age(_ value: String, now: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "Time unavailable" }
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes == 0 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        if minutes < 1440 { return "\(minutes / 60) h ago" }
        return "\(minutes / 1440) d ago"
    }
    public static func count(_ value: Int, _ noun: String) -> String { "\(value) \(noun)\(value == 1 ? "" : "s")" }
    /// "22 screens and 4 notes conflict with main": conflicts list notes as `note:<id>`.
    public static func conflictCount(_ conflicts: [String]) -> String {
        let notes = conflicts.filter { $0.hasPrefix("note:") }.count, screens = conflicts.count - notes
        let parts = [screens > 0 ? count(screens, "screen") : nil, notes > 0 ? count(notes, "note") : nil].compactMap { $0 }
        return "\(parts.joined(separator: " and ")) conflict\(conflicts.count == 1 ? "s" : "") with main"
    }
    public static func canvasBoards(_ review: V2DesignReview) -> [V2DesignReview.Board] {
        var remaining = review.boards
        var ordered: [V2DesignReview.Board] = []
        for file in (review.groups ?? []).flatMap(\.boards) {
            if let index = remaining.firstIndex(where: { $0.file == file }) { ordered.append(remaining.remove(at: index)) }
        }
        return ordered + remaining
    }
    public static func screens(_ review: V2DesignReview) -> [V2DesignReview.Board] {
        let boards = canvasBoards(review)
        if (review.round ?? 1) > 1 { return boards.filter { $0.changedSinceReview == true } }
        return ["changed", "new", "removed"].flatMap { kind in boards.filter { $0.changeKind == kind } }
    }
    public static func pages(_ review: V2DesignReview) -> [Page] {
        [.cover] + screens(review).map { .screen($0.file) } + review.changedNotes.map { .note($0.id) } + [.decide]
    }
    public static func primaryAction(_ review: V2DesignReview) -> PrimaryAction {
        if review.stale == true { return .update }
        let count = (review.pins ?? []).filter { !$0.resolved }.count
        return count == 0 ? .approve : .changes(count)
    }
    public static func nextUnseen(_ review: V2DesignReview, after file: String?) -> String? {
        let boards = screens(review)
        guard !boards.isEmpty else { return nil }
        let start = file.flatMap { file in boards.firstIndex { $0.file == file } }.map { $0 + 1 } ?? 0
        return (0..<boards.count).map { boards[(start + $0) % boards.count] }.first { $0.seen != true }?.file
    }
    public static func stepChange(_ index: Int, by delta: Int, count: Int) -> Int {
        min(max(0, count - 1), max(0, index + delta))
    }
}

extension V2Client {
    public func designReviews(project: String? = nil) async throws -> [V2ReviewSummary] {
        struct Response: Decodable, Sendable { var proposals: [V2ReviewSummary] }
        let query = project.map { "?project=\(Self.segment($0))" } ?? ""
        let response: Response = try await client.request("/api/v2/design/reviews\(query)")
        return response.proposals
    }
    public func designProjects() async throws -> [V2DesignProject] {
        struct Response: Decodable, Sendable { var projects: [V2DesignProject] }
        let response: Response = try await client.request("/api/v2/design/projects")
        return response.projects.filter { $0.boards > 0 }
    }
    public func reviewPreview(project: String, item: String, board: String, width: Int, scale: Double = 1) async throws -> V2ReviewPreview {
        try await client.request("/api/v2/projects/\(Self.segment(project))/design/review/preview?item=\(Self.segment(item))&board=\(Self.segment(board))&width=\(width)&scale=\(min(3, max(1, scale)))", timeout: 120)
    }
    /// Reuses the authenticated, origin-checked and certificate-pinned request session.
    public func reviewImage(_ url: String) async throws -> Data { try await client.data(url, timeout: 120) }
    public func reviewSeen(project: String, item: String, board: String, revision: String) async throws {
        let _: JSONValue = try await client.request("/api/v2/projects/\(Self.segment(project))/design/review/seen", method: "POST", body: JSONEncoder().encode(["item": item, "board": board, "revision": revision]))
    }
    public func addReviewPin(project: String, draft: V2ReviewPinDraft) async throws -> [V2ReviewPin] {
        try await reviewPins(project: project, method: "POST", body: JSONEncoder().encode(draft))
    }
    public func editReviewPin(project: String, item: String, id: String, text: String? = nil, resolved: Bool? = nil) async throws -> [V2ReviewPin] {
        struct Body: Encodable { var item: String; var id: String; var text: String?; var resolved: Bool? }
        return try await reviewPins(project: project, method: "PATCH", body: JSONEncoder().encode(Body(item: item, id: id, text: text, resolved: resolved)))
    }
    public func deleteReviewPin(project: String, item: String, id: String) async throws -> [V2ReviewPin] {
        try await reviewPins(project: project, method: "DELETE", body: JSONEncoder().encode(["item": item, "id": id]))
    }
    private func reviewPins(project: String, method: String, body: Data) async throws -> [V2ReviewPin] {
        struct Response: Decodable, Sendable { var pins: [V2ReviewPin] }
        let response: Response = try await client.request("/api/v2/projects/\(Self.segment(project))/design/review/pins", method: method, body: body)
        return response.pins
    }
}
