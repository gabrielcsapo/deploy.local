import Foundation

/// Pull request review derives its presentation from recorded server state only.
/// Nothing here invents a check result, a merge outcome or a deployment.

public extension ReviewFilePatch {
    var additions: Int { lines.filter { $0.kind == .addition }.count }
    var deletions: Int { lines.filter { $0.kind == .deletion }.count }
}

/// Pull request comparisons carry only a patch; recover the changed-file list from its headers.
/// Status uses the same porcelain letters as task diffs: A added, D deleted, R renamed, M modified.
public func changedFiles(fromPatch patch: String) -> [ChangedFile] {
    var files: [ChangedFile] = []
    var path: String?
    var status = "M"
    func flush() {
        if let path, !files.contains(where: { $0.path == path }) { files.append(ChangedFile(path: path, status: status)) }
        path = nil; status = "M"
    }
    func unquote(_ raw: Substring) -> String {
        let text = String(raw)
        guard text.hasPrefix("\"") else { return text }
        return (try? JSONDecoder().decode(String.self, from: Data(text.utf8))) ?? text
    }
    func strip(_ name: String) -> String {
        name.hasPrefix("a/") || name.hasPrefix("b/") ? String(name.dropFirst(2)) : name
    }
    var inHunk = false
    for line in patch.components(separatedBy: "\n") {
        if line.hasPrefix("diff --git ") {
            flush(); inHunk = false
            // Fall back to the b/ side of the header until --- / +++ lines give the exact names.
            if let range = line.range(of: " b/", options: .backwards) { path = String(line[range.upperBound...]) }
            else if let range = line.range(of: " \"b/", options: .backwards) { path = strip(unquote(line[line.index(after: range.lowerBound)...])) }
            continue
        }
        if inHunk { continue }
        if line.hasPrefix("@@ ") { inHunk = true }
        else if line.hasPrefix("new file mode") { status = "A" }
        else if line.hasPrefix("deleted file mode") { status = "D" }
        else if line.hasPrefix("rename to ") { status = "R"; path = String(line.dropFirst(10)) }
        else if line.hasPrefix("+++ "), !line.hasSuffix("/dev/null") { path = strip(unquote(line.dropFirst(4))) }
        else if line.hasPrefix("--- "), status == "D", !line.hasSuffix("/dev/null") { path = strip(unquote(line.dropFirst(4))) }
    }
    flush()
    return files
}

public func changedFileLabel(_ status: String) -> String {
    if status.contains("?") || status.contains("A") { return "Added" }
    if status.contains("D") { return "Deleted" }
    if status.contains("R") { return "Renamed" }
    return "Modified"
}

/// Repeated runs on the same commit are attempts at one check, not separate results: a retry
/// after a fix replaces what the earlier run said. Grouping keeps the latest attempt and
/// collapses the earlier ones, so a pull request reads as the state of the work.
public struct ReviewCheckAttempts: Equatable, Sendable, Identifiable {
    public let latest: ProjectWorkItem
    /// Earlier attempts on the same commit, newest first.
    public let earlier: [ProjectWorkItem]
    public var id: String { latest.id }
    public var earlierLabel: String? { earlierAttemptsLabel(earlier.count) }
}

/// How a collapsed group of earlier attempts reads next to its latest result.
public func earlierAttemptsLabel(_ count: Int) -> String? {
    count > 0 ? "\(count) earlier attempt\(count == 1 ? "" : "s")" : nil
}

/// Pipeline runs grouped by the commit they checked, newest commit first.
public func checkAttempts(runs: [ProjectWorkItem]) -> [ReviewCheckAttempts] {
    let ordered = runs.enumerated().sorted {
        $0.element.createdAt == $1.element.createdAt
            ? $0.offset < $1.offset : $0.element.createdAt < $1.element.createdAt
    }.map(\.element)
    var order: [String] = []
    var groups: [String: [ProjectWorkItem]] = [:]
    for run in ordered {
        let key = run.commit ?? ""
        if groups[key] == nil { order.append(key) }
        groups[key, default: []].append(run)
    }
    return order.reversed().compactMap { key in
        guard let attempts = groups[key], let latest = attempts.last else { return nil }
        return ReviewCheckAttempts(latest: latest, earlier: attempts.dropLast().reversed())
    }
}

/// The aggregate check result for one commit. Only recorded successful runs produce `.passed`,
/// and the payload counts the earlier attempts collapsed under that result.
public enum ReviewCheckSummary: Equatable, Sendable {
    case none
    case running(earlier: Int)
    case passed(earlier: Int)
    case failed(earlier: Int)
    /// Checks exist, but only for earlier commits of the branch.
    case outdated

    public var label: String {
        switch self {
        case .none: "No checks"
        case .running: "Checks running"
        case .passed: "Checks passed"
        case .failed: "Checks failed"
        case .outdated: "Checks are for an earlier commit"
        }
    }
    /// Earlier attempts on the same commit, for a line under the result.
    public var earlierAttempts: String? {
        switch self {
        case .running(let earlier), .passed(let earlier), .failed(let earlier): earlierAttemptsLabel(earlier)
        case .none, .outdated: nil
        }
    }
    public var tone: String {
        switch self {
        case .none, .outdated: "inactive"
        case .running: "active"
        case .passed: "healthy"
        case .failed: "failed"
        }
    }
}

private let pipelineActive: Set<String> = ["queued", "waiting", "running", "cancelling", "starting"]

/// Summarize pipeline runs for a head commit. Only the newest run for that commit decides the
/// result; earlier attempts at it are counted, never added to the verdict.
public func checkSummary(runs: [ProjectWorkItem], headCommit: String?) -> ReviewCheckSummary {
    guard !runs.isEmpty else { return .none }
    let current = headCommit.map { head in runs.filter { $0.commit == head } } ?? runs
    guard let group = checkAttempts(runs: current).first else { return .outdated }
    let earlier = group.earlier.count
    if pipelineActive.contains(group.latest.status) { return .running(earlier: earlier) }
    if group.latest.status == "succeeded" { return .passed(earlier: earlier) }
    return .failed(earlier: earlier)
}

/// Where a pull request stands, combining its record with the asynchronous merge operation.
public enum PullPhase: Equatable, Sendable {
    case open
    case merging
    case merged
    case closed
    case mergeFailed(String)
    /// The merge outcome is unknown and needs owner recovery.
    case needsRecovery(String)

    public var label: String {
        switch self {
        case .open: "Open"
        case .merging: "Merging"
        case .merged: "Merged"
        case .closed: "Closed"
        case .mergeFailed: "Merge failed"
        case .needsRecovery: "Needs recovery"
        }
    }
    public var tone: String {
        switch self {
        case .open: "attention"
        case .merging: "active"
        case .merged: "healthy"
        case .closed: "inactive"
        case .mergeFailed, .needsRecovery: "failed"
        }
    }
}

/// `requestedMerge` is true between pressing Merge and the coordinator acknowledging the operation,
/// so the state never shows Open again while the merge is in flight.
public func pullPhase(record: ProjectWorkItem, operation: MergeOperation?, requestedMerge: Bool = false) -> PullPhase {
    if record.status == "merged" { return .merged }
    if record.status == "closed" { return .closed }
    if let operation {
        switch operation.status {
        case "queued", "running": return .merging
        case "unknown": return .needsRecovery(operation.error ?? "The merge outcome is unknown.")
        case "failed": if !requestedMerge { return .mergeFailed(operation.error ?? "The merge failed.") }
        case "succeeded": return .merging
        default: break
        }
    }
    return requestedMerge ? .merging : .open
}

public enum PullMergeability: Equatable, Sendable {
    /// The target can fast-forward to the source head.
    case ready
    /// The target moved on, but the merge is clean: it lands as a merge commit.
    case mergeCommit
    /// The merge would conflict in these paths.
    case conflicted([String])
    /// The coordinator refuses the merge for another reason, such as required checks.
    case blocked(String)
    /// The target moved on and this coordinator does not report whether the merge is clean.
    case diverged
    case noChanges
    case unknown

    public var label: String {
        switch self {
        case .ready: "Fast-forward merge"
        case .mergeCommit: "Clean merge commit"
        case .conflicted: "Conflicting changes"
        case .blocked: "Not ready to merge"
        case .diverged: "Branches have diverged"
        case .noChanges: "No new commits"
        case .unknown: "Checking mergeability"
        }
    }

    /// Whether pressing Merge can succeed. A clean divergence merges as well as a fast-forward.
    public var canMerge: Bool { self == .ready || self == .mergeCommit }
}

public func pullMergeability(_ comparison: PullComparison?) -> PullMergeability {
    guard let comparison else { return .unknown }
    if comparison.baseCommit == comparison.headCommit || comparison.mergeBase == comparison.headCommit { return .noChanges }
    if let conflicts = comparison.conflicts, !conflicts.isEmpty { return .conflicted(conflicts) }
    if comparison.mergeable == false {
        return .blocked(comparison.mergeBlock ?? "The coordinator will not merge this pull request yet.")
    }
    if comparison.fastForward { return .ready }
    // Without a mergeability verdict, a coordinator that only fast-forwards cannot merge this.
    return comparison.mergeable == true ? .mergeCommit : .diverged
}

/// The push pipeline the coordinator queues for the merged commit on the target branch.
public func resultingPipeline(runs: [ProjectWorkItem], mergedCommit: String?) -> ProjectWorkItem? {
    guard let mergedCommit else { return nil }
    return runs.filter { $0.commit == mergedCommit && $0.trigger == "push" && $0.pullId == nil }
        .max { $0.createdAt < $1.createdAt }
}

/// A compare preview built from two bounded histories (newest first).
public struct BranchComparison: Equatable, Sendable {
    /// Commits on the source that the target does not have, newest first.
    public let ahead: [RepositoryCommit]
    /// Commits on the target that the source does not have; a non-empty list means the merge cannot fast-forward.
    public let behind: [RepositoryCommit]
    /// The newest common commit, when it falls inside both histories.
    public let mergeBase: String?
    public var fastForward: Bool { mergeBase != nil && behind.isEmpty && !ahead.isEmpty }
}

public func compareBranches(source: [RepositoryCommit], target: [RepositoryCommit]) -> BranchComparison {
    let targetIds = Set(target.map(\.oid))
    let sourceIds = Set(source.map(\.oid))
    let base = source.first { targetIds.contains($0.oid) }?.oid
    let ahead = Array(source.prefix { !targetIds.contains($0.oid) })
    let behind = base == nil ? [] : Array(target.prefix { $0.oid != base && !sourceIds.contains($0.oid) })
    return BranchComparison(ahead: ahead, behind: behind, mergeBase: base)
}

/// Parse the coordinator's ISO 8601 timestamps, with or without fractional seconds.
public func workspaceDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
        ?? (try? Date.ISO8601FormatStyle().parse(value))
}

/// A pull request or issue mentioned in conversation text. Issue and pull request numbers share one
/// sequence per project, so a bare `#3` names exactly one record when it exists.
public struct ReviewMention: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case any, pull, issue }
    public let number: Int
    public let kind: Kind
    public init(number: Int, kind: Kind) { self.number = number; self.kind = kind }
}

/// Find `#3`, `PR #3`, `pull request #3` and `issue #2` outside code, in order of first appearance.
public func reviewMentions(in text: String) -> [ReviewMention] {
    var prose = text
    // Code blocks and inline code are quoted material, never references.
    while let start = prose.range(of: "```"), let end = prose.range(of: "```", range: start.upperBound..<prose.endIndex) {
        prose.replaceSubrange(start.lowerBound..<end.upperBound, with: " ")
    }
    prose = prose.replacingOccurrences(of: "`[^`\n]*`", with: " ", options: .regularExpression)
    let pattern = #"(?i)(pull request|pr|issue)?\s?#(\d{1,6})\b"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let source = prose as NSString
    var result: [ReviewMention] = []
    for match in regex.matches(in: prose, range: NSRange(location: 0, length: source.length)) {
        let hash = match.range(at: 2).location - 1
        // Require a boundary before '#', so anchors like "page#3" or "C#3" are not mentions.
        if hash > 0, let scalar = Unicode.Scalar(source.character(at: hash - 1)),
           CharacterSet.alphanumerics.contains(scalar) || scalar == "&" || scalar == "/" { continue }
        guard let number = Int(source.substring(with: match.range(at: 2))), number > 0 else { continue }
        let label = match.range(at: 1).location == NSNotFound ? "" : source.substring(with: match.range(at: 1)).lowercased()
        let kind: ReviewMention.Kind = label == "issue" ? .issue : label.isEmpty ? .any : .pull
        if let index = result.firstIndex(where: { $0.number == number }) {
            if result[index].kind == .any && kind != .any { result[index] = ReviewMention(number: number, kind: kind) }
        } else { result.append(ReviewMention(number: number, kind: kind)) }
    }
    return result
}

/// Resolve mentions against a project's records. A labelled mention must match the record's kind.
public func resolveMentions(_ mentions: [ReviewMention], pulls: [ProjectWorkItem], issues: [ProjectWorkItem]) -> [ProjectWorkItem] {
    mentions.compactMap { mention in
        let pull = mention.kind == .issue ? nil : pulls.first { $0.number == mention.number }
        let issue = mention.kind == .pull ? nil : issues.first { $0.number == mention.number }
        return pull ?? issue
    }
}

/// A single transcript event survives after the live review surface closes.
public extension ProjectWorkItem {
    var showsConversationReviewBar: Bool { !["merged", "closed"].contains(status) }
    var conversationEventLabel: String {
        let verb = status == "merged" ? "Merged" : status == "closed" ? "Closed" : "Opened"
        let target = status == "merged" ? (targetBranch.map { " into \($0)" } ?? "") + (mergedCommit.map { " · \($0.prefix(7))" } ?? "") : ""
        return "\(verb) #\(number.map(String.init) ?? "") \(displayTitle)\(target)"
    }
}

public extension MessageDeployment {
    var conversationEventLabel: String {
        "Deployed \(application ?? "application")" + (status == "running" ? "" : " · \(status)")
    }
}
