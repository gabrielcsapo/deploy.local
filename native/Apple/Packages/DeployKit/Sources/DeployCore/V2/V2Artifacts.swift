import Foundation

/// Artifacts: the designs and documents kept in a project's repository, as /api/artifacts lists
/// them (shared/v2/artifacts.ts). A design is one kind of artifact; a document is the second.
public struct V2Artifact: Decodable, Sendable, Identifiable, Hashable {
    public enum Kind: String, Decodable, Sendable { case design, document }
    public enum State: String, Decodable, Sendable { case review, unproposed }
    public var projectId: String
    public var project: String
    /// The folder under artifacts/; nil for the App design in design/.
    public var artifact: String?
    public var kind: Kind
    public var name: String
    public var boards: Int?
    public var updatedAt: String?
    /// Set while it exists only on its own branch.
    public var branch: String?
    public var state: State?
    public var id: String { "\(projectId):\(artifact ?? "")" }

    public init(projectId: String, project: String, artifact: String?, kind: Kind, name: String,
                boards: Int? = nil, updatedAt: String? = nil, branch: String? = nil, state: State? = nil) {
        self.projectId = projectId; self.project = project; self.artifact = artifact; self.kind = kind
        self.name = name; self.boards = boards; self.updatedAt = updatedAt; self.branch = branch; self.state = state
    }

    /// "171 boards · in review", "Document · 3 days ago", "6 boards · not proposed".
    public func subtitle(now: Date = Date(), calendar: Calendar = .current) -> String {
        var parts: [String] = []
        if kind == .design, let boards { parts.append("\(boards) board\(boards == 1 ? "" : "s")") }
        if kind == .document { parts.append("Document") }
        switch state {
        case .review: parts.append("in review")
        case .unproposed: parts.append("not proposed")
        case nil:
            let when = V2Artifacts.changedWhen(updatedAt, now: now, calendar: calendar)
            if !when.isEmpty { parts.append(when) }
        }
        return parts.joined(separator: " · ")
    }
}

public struct V2ArtifactGallery: Decodable, Sendable {
    public struct Project: Decodable, Sendable, Identifiable, Equatable {
        public var id: String
        public var name: String
    }
    public var artifacts: [V2Artifact]
    public var projects: [Project]

    /// Each project's artifacts, in the order the projects are listed; projects with none are left out.
    public var byProject: [(project: Project, artifacts: [V2Artifact])] {
        projects.compactMap { project in
            let mine = artifacts.filter { $0.projectId == project.id }
            return mine.isEmpty ? nil : (project, mine)
        }
    }
    /// What the Settings row says: "6 artifacts", "6 artifacts · 1 in review", "None yet".
    public var summary: String {
        guard !artifacts.isEmpty else { return "None yet" }
        let count = "\(artifacts.count) artifact\(artifacts.count == 1 ? "" : "s")"
        let review = artifacts.filter { $0.state == .review }.count
        return review > 0 ? "\(count) · \(review) in review" : count
    }
}

/// A document as the server reads it: its markdown on the branch shown, or on main.
public struct V2ArtifactDocument: Decodable, Sendable, Equatable {
    public var projectId: String
    public var project: String
    public var artifact: String
    public var title: String
    public var text: String
    public var main: String?
    public var branch: String?
    public var changedAt: String?
    public var review: Review?
    public struct Review: Decodable, Sendable, Equatable {
        public var id: String
        public var branch: String
        public var state: String?
    }

    /// "deploy.local · on main · changed 3 days ago"; "deploy.local · not on main yet · changed
    /// today" while it is only on its branch; its branch while one is edited.
    public func meta(now: Date = Date(), calendar: Calendar = .current) -> String {
        let when = V2Artifacts.changedWhen(changedAt, now: now, calendar: calendar)
        return [project, main == nil ? "not on main yet" : branch ?? "on main", when.isEmpty ? nil : "changed \(when)"]
            .compactMap { $0 }.joined(separator: " · ")
    }
    public var blocks: [V2Artifacts.Block] { V2Artifacts.blocks(V2Artifacts.body(text)) }
}

/// A proposed document, as its review shows it: After is the proposal with a dot on each block
/// main lacks; Before is main with a dot on each block the proposal changes or removes. A document
/// not on main has no Before and no dots, since every block is new.
public struct V2DocumentReview: Equatable, Sendable {
    public enum Side: String, CaseIterable, Sendable { case before, after }
    public var isNew: Bool
    public var blocks: [V2Artifacts.Block]
    public var marked: [Bool]
    /// Blocks in After that main lacks.
    public var count: Int

    public init(document: V2ArtifactDocument, side: Side) {
        let after = V2Artifacts.blocks(V2Artifacts.body(document.text))
        guard let main = document.main else {
            isNew = true; blocks = after; marked = after.map { _ in false }; count = after.count
            return
        }
        let before = V2Artifacts.blocks(V2Artifacts.body(main))
        isNew = false
        count = V2Artifacts.changed(before: before, after: after).filter { $0 }.count
        blocks = side == .after ? after : before
        marked = side == .after ? V2Artifacts.changed(before: before, after: after) : V2Artifacts.changed(before: after, after: before)
    }
    /// "2 blocks changed" or "new document", after who it is from.
    public var progress: String { isNew ? "new document" : "\(count) block\(count == 1 ? "" : "s") changed" }
    /// The line under the title on each side.
    public static func meta(_ document: V2ArtifactDocument, side: Side, review: V2DocumentReview, now: Date = Date(), calendar: Calendar = .current) -> String {
        if review.isNew { return "\(document.project) · not on main yet" }
        if side == .before {
            let when = V2Artifacts.changedWhen(document.changedAt, now: now, calendar: calendar)
            return [document.project, "on main", when.isEmpty ? nil : "changed \(when)"].compactMap { $0 }.joined(separator: " · ")
        }
        return review.count == 0 ? document.project : "\(document.project) · \(review.count) block\(review.count == 1 ? "" : "s") changed on this branch"
    }
}

public enum V2Artifacts {
    /// Who proposed a review, as the review says it: "You" for your own, else the agent's name.
    public static func proposer(_ item: InboxItem, username: String) -> String {
        item.from == username ? "You" : V2Labels.agentName(item)
    }

    /// Which of `after`'s blocks are not in `before`, matched regardless of position; a numbered
    /// item is matched by its text, so renumbering a list changes nothing.
    public static func changed(before: [Block], after: [Block]) -> [Bool] {
        func key(_ block: Block) -> String {
            switch block {
            case .paragraph(let text): "p\u{0}\(text)"
            case .heading(let text): "h\u{0}\(text)"
            case .bullet(let text): "b\u{0}\(text)"
            case .number(_, let text): "n\u{0}\(text)"
            case .code(let text): "c\u{0}\(text)"
            }
        }
        var pool: [String: Int] = [:]
        for block in before { pool[key(block), default: 0] += 1 }
        return after.map { block in
            let left = pool[key(block)] ?? 0
            if left > 0 { pool[key(block)] = left - 1; return false }
            return true
        }
    }

    /// A document's blocks, as the web page shows them.
    public enum Block: Equatable, Sendable {
        case paragraph(String)
        case heading(String)
        case bullet(String)
        case number(Int, String)
        case code(String)
    }

    /// "Onboarding flow" is artifacts/onboarding-flow.
    public static func slug(_ name: String) -> String {
        let folded = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        var out = ""
        var dash = false
        for scalar in folded.unicodeScalars {
            if ("a"..."z").contains(Character(scalar)) || ("0"..."9").contains(Character(scalar)) {
                if dash && !out.isEmpty { out.append("-") }
                out.unicodeScalars.append(scalar)
                dash = false
            } else { dash = true }
        }
        var cut = String(out.prefix(48))
        while cut.hasSuffix("-") { cut.removeLast() }
        return cut
    }

    /// What the New sheet says will happen, once the name gives a folder.
    public static func createNote(name: String, project: String?) -> String {
        let folder = slug(name)
        guard !folder.isEmpty, let project else { return "" }
        return "deploy.local adds artifacts/\(folder) to \(project) on a new branch, artifact/\(folder). It reaches main when you approve it."
    }

    /// The document's text after its title line.
    public static func body(_ markdown: String) -> String {
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        guard let title = lines.firstIndex(where: { $0.hasPrefix("# ") }) else { return lines.joined(separator: "\n") }
        return lines[(title + 1)...].joined(separator: "\n")
    }

    public static func blocks(_ body: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var number = 0
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))) }
            paragraph = []
        }
        let lines = body.components(separatedBy: "\n")
        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                var code: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[index]); index += 1
                }
                blocks.append(.code(code.joined(separator: "\n")))
                number = 0
            } else if trimmed.hasPrefix("## ") || trimmed.hasPrefix("### ") {
                flush(); number = 0
                blocks.append(.heading(String(trimmed.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                flush(); number = 0
                blocks.append(.bullet(String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)))
            } else if let dot = trimmed.firstIndex(where: { $0 == "." || $0 == ")" }),
                      !trimmed[..<dot].isEmpty, trimmed[..<dot].allSatisfy(\.isNumber),
                      trimmed[trimmed.index(after: dot)...].hasPrefix(" ") {
                flush(); number += 1
                blocks.append(.number(number, String(trimmed[trimmed.index(after: dot)...]).trimmingCharacters(in: .whitespaces)))
            } else if trimmed.isEmpty {
                flush()
            } else {
                paragraph.append(trimmed); number = 0
            }
            index += 1
        }
        flush()
        return blocks
    }

    /// "today", "yesterday", "3 days ago", "Monday", "12 October": as the web says it.
    public static func changedWhen(_ value: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let value, let date = parse(value) else { return "" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return "today" }
        if days == 1 { return "yesterday" }
        if days <= 3 { return "\(days) days ago" }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_GB")
        format.calendar = calendar
        format.timeZone = calendar.timeZone
        if days <= 6 { format.dateFormat = "EEEE"; return format.string(from: date) }
        format.dateFormat = calendar.component(.year, from: date) == calendar.component(.year, from: now) ? "d MMMM" : "d MMMM yyyy"
        return format.string(from: date)
    }
    static func parse(_ value: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: value) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value)
    }
}

extension V2Client {
    public func artifacts() async throws -> V2ArtifactGallery { try await client.request("/api/artifacts") }

    public struct CreatedArtifact: Decodable, Sendable, Equatable {
        public var projectId: String
        public var artifact: String
        public var kind: V2Artifact.Kind
        public var branch: String
    }
    public func createArtifact(kind: V2Artifact.Kind, name: String, project: String) async throws -> CreatedArtifact {
        struct Body: Encodable { var kind: String; var name: String; var project: String }
        return try await client.request("/api/artifacts", method: "POST", body: JSONEncoder().encode(Body(kind: kind.rawValue, name: name, project: project)))
    }
    public func artifactDocument(project: String, artifact: String) async throws -> V2ArtifactDocument {
        try await client.request("/api/projects/\(Self.segment(project))/artifacts/\(Self.segment(artifact))/document")
    }
    /// A document as one review proposed it, beside the document on main.
    public func artifactDocument(project: String, artifact: String, review: String) async throws -> V2ArtifactDocument {
        try await client.request("/api/projects/\(Self.segment(project))/artifacts/\(Self.segment(artifact))/document?review=\(Self.segment(review))")
    }
}
