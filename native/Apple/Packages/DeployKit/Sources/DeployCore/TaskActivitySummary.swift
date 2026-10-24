import Foundation

public struct LatestTaskCheck: Identifiable, Equatable, Sendable {
    public var id: String { latest.checkIdentity }
    public let latest: WorkspaceJob
    public let earlier: [WorkspaceJob]
    public var failures: Int { earlier.filter(\.isFailed).count }
}
public struct ActivityTurn: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let number: Int?
    public let jobs: [WorkspaceJob]
    public let jobCount: Int
    public var allPassed: Bool { TaskActivitySummary.latestChecks(jobs).allSatisfy { $0.latest.status == "succeeded" } }
}
public extension WorkspaceJob {
    var checkIdentity: String {
        let label = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // Length prefixes avoid collisions in worker IDs, labels and shell strings.
        let worker = workerId ?? ""
        // Command summaries ignore shell plumbing, so a tweaked retry folds into the same check.
        let value = label.isEmpty ? TaskActivitySummary.commandTitle(command) : label
        return "\(worker.count):\(worker)\(label.isEmpty ? "command" : "label"):\(value)"
    }
    var title: String { name?.trimmingCharacters(in: .whitespacesAndNewlines).nonempty ?? TaskActivitySummary.commandTitle(command) }
    var isFailed: Bool { ["failed", "timed_out"].contains(status) }
    var statusLabel: String {
        switch status {
        case "succeeded": "Passed"
        case "failed", "timed_out": "Failed"
        case "running": "Running"
        case "queued": "Queued"
        case "cancelled", "canceled": "Cancelled"
        default: "Unavailable"
        }
    }
    func duration(now: Date = Date()) -> String {
        guard let start = TaskActivitySummary.date(status == "queued" ? createdAt : startedAt),
              let end = TaskActivitySummary.date(finishedAt) ?? (isActive ? now : nil) else { return "" }
        let seconds = max(0, Int(end.timeIntervalSince(start)))
        return (status == "queued" ? "Queued " : "") + (seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s")
    }
    var detailLine: String {
        if isFailed {
            let firstError = error?.nonempty ?? output.components(separatedBy: .newlines).first { $0.range(of: "error|fatal|fail|exception", options: [.regularExpression, .caseInsensitive]) != nil }
            return [exitCode.flatMap { $0 != 0 ? "Exit \($0)" : nil }, firstError].compactMap { $0 }.joined(separator: " · ")
        }
        if status == "queued", let waitingReason { return "Waiting: \(waitingReason)" }
        if status == "running" { return output.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines).last ?? "" }
        return ""
    }
}
public struct JobArtifactRows: Equatable, Sendable {
    public let media: [MediaAttachment]
    public let files: [MediaAttachment]
    public let skipped: [JobArtifact]
    public var isEmpty: Bool { media.isEmpty && files.isEmpty && skipped.isEmpty }
}
public extension WorkspaceJob {
    /// True while files the agent asked for have not been collected yet.
    var awaitsArtifacts: Bool { isActive && !(artifactPaths ?? []).isEmpty && (artifacts ?? []).isEmpty }
    /// Stored artifacts reuse the task's attachment rows; a row not yet refreshed falls back to the job's reference.
    func artifactRows(attachments: [MediaAttachment], taskId: String = "") -> JobArtifactRows {
        let entries = artifacts ?? []
        let stored = entries.compactMap { entry -> MediaAttachment? in
            guard let attachmentId = entry.attachmentId else { return nil }
            return attachments.first { $0.id == attachmentId } ?? MediaAttachment(
                id: attachmentId, taskId: taskId, runId: runId, messageId: nil, kind: entry.kind ?? "file",
                mimeType: "", size: entry.bytes ?? 0, width: nil, height: nil, duration: nil, name: entry.name,
                caption: entry.caption, source: "job-artifact", createdAt: finishedAt ?? createdAt ?? "")
        }
        return JobArtifactRows(media: stored.filter { ["image", "video"].contains($0.kind) },
                               files: stored.filter { !["image", "video"].contains($0.kind) },
                               skipped: entries.filter { $0.skipped != nil })
    }
}
public enum ArtifactSize {
    public static func label(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
    }
}
private extension String { var nonempty: String? { isEmpty ? nil : self } }

public struct TaskActivitySummary: Equatable, Sendable {
    public let processCount: Int
    public let runningCount: Int
    public let failingCount: Int
    public let checkCount: Int
    public let passedCount: Int
    public let computerCount: Int
    public let sources: [String]
    public var isVisible: Bool { processCount > 0 || !sources.isEmpty }
    private var parts: [String] {
        [failingCount > 0 ? "\(failingCount) failing" : nil,
         runningCount > 0 ? "\(runningCount) running" : nil,
         processCount > 0 ? "\(processCount) job\(processCount == 1 ? "" : "s")" + (computerCount > 0 ? " on \(computerCount) computer\(computerCount == 1 ? "" : "s")" : "") : nil,
         processCount == 0 && !sources.isEmpty ? "Read \(sources.count) file\(sources.count == 1 ? "" : "s")" : nil].compactMap { $0 }
    }
    public var label: String { "Activity: " + parts.joined(separator: ", ") }
    public var text: String { parts.joined(separator: " · ") }
    public init(jobs: [WorkspaceJob], activity: [TaskActivity]) {
        let checks = Self.latestChecks(jobs)
        processCount = jobs.count
        checkCount = checks.count
        runningCount = checks.filter { $0.latest.isActive }.count
        failingCount = checks.filter { $0.latest.isFailed }.count
        passedCount = checks.filter { $0.latest.status == "succeeded" }.count
        computerCount = Set(jobs.compactMap(\.workerId)).count
        sources = Array(Set(activity.flatMap(\.items).filter { item in
            guard let source = item.source, !source.isEmpty, source != ".", !source.hasSuffix("/"), !["directory", "list", "list_directory"].contains(item.kind) else { return false }
            return source.contains(".") || ["read", "file"].contains(item.kind)
        }.compactMap(\.source).map { $0.hasPrefix("./") ? String($0.dropFirst(2)) : $0 })).sorted()
    }
    public static func normaliseCommand(_ command: String) -> String {
        command.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }
    public static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
    private static func newest(_ a: WorkspaceJob, _ b: WorkspaceJob) -> Bool {
        if a.createdAt != b.createdAt { return (a.createdAt ?? "") > (b.createdAt ?? "") }
        return a.id > b.id
    }
    public static func latestChecks(_ jobs: [WorkspaceJob]) -> [LatestTaskCheck] {
        var groups: [String: [WorkspaceJob]] = [:]
        var keys: [String] = []
        for job in jobs.sorted(by: newest) {
            if groups[job.checkIdentity] == nil { keys.append(job.checkIdentity) }
            groups[job.checkIdentity, default: []].append(job)
        }
        return keys.compactMap { key in
            guard let attempts = groups[key], let latest = attempts.first else { return nil }
            return LatestTaskCheck(latest: latest, earlier: Array(attempts.dropFirst()))
        }
    }
    public static func orderedJobs(_ jobs: [WorkspaceJob]) -> [WorkspaceJob] {
        jobs.sorted { if $0.isActive != $1.isActive { return $0.isActive }; return newest($0, $1) }
    }
    public static func turns(_ jobs: [WorkspaceJob], runs: [Run], messages: [Message], attempts: [WorkspaceJob]? = nil) -> [ActivityTurn] {
        let orderedRuns = runs.sorted { $0.createdAt < $1.createdAt }
        let allAttempts = attempts ?? jobs
        let groups = Dictionary(grouping: jobs, by: { $0.runId ?? "" })
        return groups.map { id, attempts in
            let run = runs.first { $0.id == id }
            let number = orderedRuns.firstIndex { $0.id == id }.map { $0 + 1 }
            let message = messages.first { $0.role == "user" && $0.runId == id } ?? messages.last { $0.role == "user" && $0.createdAt <= (run?.createdAt ?? "") }
            let title = id.isEmpty ? "Other" : "Turn" + (number.map { " \($0)" } ?? "") + (message.map { " · " + String($0.content.components(separatedBy: .newlines).first!.prefix(80)) } ?? "")
            return ActivityTurn(id: id, title: title, number: number, jobs: attempts.sorted { newest($1, $0) }, jobCount: allAttempts.filter { ($0.runId ?? "") == id }.count)
        }.sorted { a, b in
            if a.id.isEmpty { return false }; if b.id.isEmpty { return true }
            return (runs.first { $0.id == a.id }?.createdAt ?? a.jobs.last?.createdAt ?? "") > (runs.first { $0.id == b.id }?.createdAt ?? b.jobs.last?.createdAt ?? "")
        }
    }
    private static let shellKeywords: Set<String> = ["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "!", "{", "}", "(", ")"]
    private static let wrappers: Set<String> = ["timeout", "env", "nohup", "dbus-run-session", "xvfb-run", "exec", "command", "time"]
    /// Helpers that shape output or the environment rather than being the thing checked.
    private static let plumbing: Set<String> = ["cd", "set", "echo", "printf", "grep", "head", "tail", "test", "[", "[[", "true", "false", ":", "sleep", "break", "continue", "tee", "cat", "ls", "exit", "return", "base64", "wc", "sort", "uniq", "cut", "tr", "sed", "awk", "xargs", "rm", "mkdir", "touch", "mktemp", "export", "unset", "wait", "kill", "trap", "read", "jq", "pwd", "date", "which", "type", "stat", "file"]
    /// Summaries are pure and run several regular expressions, and views ask for them on every
    /// render (check identity, row titles, counts), so cache them by command.
    private static let titleCache = CommandTitleCache()
    public static func commandTitle(_ command: String) -> String {
        titleCache.value(for: command) { computeCommandTitle(command) }
    }
    private static func computeCommandTitle(_ command: String) -> String {
        let clean = command.replacingOccurrences(of: #"\b[A-Za-z_]\w*=\$\([^)]*\)\s*;?"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?:^|[;&])\s*(?:cd\s+[^;&]+|set\s+-[eu]+|(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^;\s]+))\s*(?:&&|;)?"#, with: "", options: .regularExpression)
        var programs: [String] = []
        for part in clean.components(separatedBy: CharacterSet(charactersIn: "&;|\n")) {
            var tokens = part.split(whereSeparator: \.isWhitespace).map(String.init)
            // Loops and case arms say nothing about what ran; their bodies are separate parts.
            if ["for", "case", "select"].contains(tokens.first ?? "") { continue }
            while let first = tokens.first, shellKeywords.contains(first) { tokens.removeFirst() }
            // Wrappers run another program: summarise that one instead.
            while let first = tokens.first?.components(separatedBy: "/").last, wrappers.contains(first) {
                tokens.removeFirst()
                while let next = tokens.first, next.hasPrefix("-") || next.contains("=") || next.range(of: #"^\d+[smhd]?$"#, options: .regularExpression) != nil { tokens.removeFirst() }
            }
            // Variables (`"$b" --flag`) hide which program ran; skip rather than show shell syntax.
            guard let program = tokens.first?.components(separatedBy: "/").last, !plumbing.contains(program), !program.contains("="),
                  program.range(of: #"^["']?\$"#, options: .regularExpression) == nil else { continue }
            // Version probes (`node --version`) only record the toolchain.
            if tokens.count == 2, tokens[1].range(of: #"^-{1,2}(version|v)$"#, options: .regularExpression) != nil { continue }
            var title = program
            if ["curl", "firefox", "chromium"].contains(program), let range = part.range(of: #"https?://[^/\s'";]+"#, options: .regularExpression), let host = URL(string: String(part[range]))?.host { title += " → " + host }
            else if ["git", "swift", "npm", "pnpm", "yarn", "cargo", "go"].contains(program), let action = tokens.dropFirst().first(where: { !$0.hasPrefix("-") && !$0.contains("=") && !$0.hasPrefix("'") }) {
                if program == "git", ["status", "add"].contains(action), clean.range(of: #"\bgit\b.*\b(commit|push)\b"#, options: .regularExpression) != nil { continue }
                title += " " + action
            } else if program == "xcodebuild", part.contains("-version"), clean.contains("swift ") { continue }
            if !programs.contains(title) { programs.append(title) }
        }
        let result = (programs.isEmpty ? normaliseCommand(command) : programs.joined(separator: " + ")).replacingOccurrences(of: "git commit + git push", with: "git commit + push")
        return result.count <= 64 ? result : String(result.prefix(31)) + "…" + String(result.suffix(32))
    }
}

public extension Run {
    func workedDuration(now: Date = Date()) -> String {
        guard let start = TaskActivitySummary.date(createdAt),
              let end = isActive ? now : TaskActivitySummary.date(updatedAt), end >= start else { return "" }
        let seconds = Int(end.timeIntervalSince(start))
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }
}

/// A small thread-safe memo for command summaries; cleared when it grows past its bound.
final class CommandTitleCache: @unchecked Sendable {
    private let lock = NSLock()
    private var titles: [String: String] = [:]
    func value(for command: String, compute: () -> String) -> String {
        lock.lock(); if let cached = titles[command] { lock.unlock(); return cached }; lock.unlock()
        let title = compute()
        lock.lock(); if titles.count > 4000 { titles.removeAll() }; titles[command] = title; lock.unlock()
        return title
    }
}
