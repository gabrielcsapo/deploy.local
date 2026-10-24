import Foundation

/// A file inside a task's workspace, named by its repository-relative path.
public struct TaskFileReference: Equatable, Hashable, Identifiable, Sendable {
    public var id: String { path + ":" + (line.map(String.init) ?? "") }
    public let path: String
    public let line: Int?
    public init(path: String, line: Int? = nil) { self.path = path; self.line = line }
}

/// Agents link files as absolute worker paths, often with a line (`/…/tasks/<id>/web/a.mjs:12`).
/// Map any link inside the task workspace to its repository-relative path; external links,
/// anchors and paths outside the workspace return nil and keep their normal behaviour.
public func taskFileReference(_ href: String, taskId: String, workspacePaths: [String?] = []) -> TaskFileReference? {
    var value = href.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty || value.hasPrefix("#") || value.hasPrefix("?") || value.hasPrefix("//") { return nil }
    if value.lowercased().hasPrefix("file://") {
        value = String(value.dropFirst("file://".count))
        if value.lowercased().hasPrefix("localhost/") { value = String(value.dropFirst("localhost".count)) }
    } else if value.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) != nil {
        return nil
    }
    value = value.removingPercentEncoding ?? value
    var line: Int?
    if let anchor = value.range(of: #"#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$"#, options: .regularExpression) {
        line = Int(value[anchor].dropFirst(2).prefix { $0.isNumber })
        value = String(value[..<anchor.lowerBound])
    } else if let suffix = value.range(of: #":(\d+)(?::\d+)?(?:-\d+)?$"#, options: .regularExpression) {
        line = Int(value[suffix].dropFirst().prefix { $0.isNumber })
        value = String(value[..<suffix.lowerBound])
    }
    if let query = value.firstIndex(where: { $0 == "?" || $0 == "#" }) { value = String(value[..<query]) }
    var relative: String?
    if value.hasPrefix("/") {
        for root in workspacePaths.compactMap({ $0 }) where !root.isEmpty {
            var prefix = root
            while prefix.hasSuffix("/") { prefix.removeLast() }
            prefix += "/"
            if value.hasPrefix(prefix) { relative = String(value.dropFirst(prefix.count)); break }
        }
        // Workers keep each task in `<worker root>/tasks/<taskId>`; the task id is unique.
        let marker = "/tasks/\(taskId)/"
        if relative == nil, let range = value.range(of: marker) { relative = String(value[range.upperBound...]) }
    } else { relative = value }
    guard var path = relative else { return nil }
    while path.hasPrefix("./") { path.removeFirst(2) }
    while path.hasSuffix("/") { path.removeLast() }
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.isEmpty, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
    return TaskFileReference(path: path, line: line.flatMap { $0 > 0 ? $0 : nil })
}

/// Where a file link lands in the Changes view.
public enum TaskFileFocus: Equatable, Sendable {
    /// The diff shows the file; scroll to it (and the line when the diff has it).
    case diff(path: String, line: Int?)
    /// The diff lists the file but has no text for it (binary, too large or excluded).
    case listedWithoutDiff
    /// The file has no changes in what the diff covers.
    case unchanged
}

public func taskFileFocus(_ reference: TaskFileReference, files: [ChangedFile], patches: [ReviewFilePatch]) -> TaskFileFocus {
    if let patch = patches.first(where: { $0.path == reference.path }) {
        let hasLine = reference.line.map { line in patch.lines.contains { $0.newNumber == line } } ?? false
        return .diff(path: patch.path, line: hasLine ? reference.line : nil)
    }
    return files.contains { $0.path == reference.path } ? .listedWithoutDiff : .unchanged
}

/// One resolved file link; `request` distinguishes repeated taps on the same link.
public struct FileLinkFocus: Equatable, Sendable {
    public let reference: TaskFileReference
    public let focus: TaskFileFocus
    public let request: Int
}

/// Paths the dashboard itself serves; any other absolute path is on some computer's disk.
private let appRoutePattern = #"^/(?:dashboard|api|docs|discover|changelog)(?:[/?#]|$)"#

/// A link to a file on a computer's disk (`file://…` or an absolute path that is not a dashboard route).
public func isLocalFilePath(_ href: String) -> Bool {
    let value = href.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.lowercased().hasPrefix("file://") { return true }
    return value.hasPrefix("/") && !value.hasPrefix("//") && value.range(of: appRoutePattern, options: .regularExpression) == nil
}

/// The scheme of links rewritten by `rewriteLocalFileLinks`; the message view opens them in the task.
public let taskFileLinkScheme = "deploy-task-file"

public extension TaskFileReference {
    /// `deploy-task-file:///docs/a.md#L12`, which survives Markdown parsing whatever the path contains.
    var linkURL: URL? {
        var parts = URLComponents()
        parts.scheme = taskFileLinkScheme
        parts.host = ""
        parts.path = "/" + path
        parts.fragment = line.map { "L\($0)" }
        return parts.url
    }
    init?(linkURL url: URL) {
        guard url.scheme == taskFileLinkScheme, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let path = String(parts.path.drop { $0 == "/" })
        guard !path.isEmpty else { return nil }
        self.init(path: path, line: parts.fragment.flatMap { $0.hasPrefix("L") ? Int($0.dropFirst()) : nil })
    }
}

/// Agents link report files by their absolute path on the task computer, e.g.
/// `[verification.md](</var/home/me/.config/deploy.local Node/worker/tasks/<id>/docs/verification.md>)`.
/// Links inside the task workspace become `deploy-task-file:` links the app opens in the task;
/// other disk paths, which nothing here can open, become inline code instead of dead links.
/// Code spans and fenced code blocks are left exactly as written.
public func rewriteLocalFileLinks(_ markdown: String, taskId: String?, workspacePaths: [String?] = []) -> String {
    guard markdown.contains("](") else { return markdown }
    var output: [Substring] = []
    var fence: Substring?
    for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = line.drop { $0 == " " }
        if let open = fence {
            if trimmed.hasPrefix(open) { fence = nil }
            output.append(line); continue
        }
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            fence = trimmed.prefix(3); output.append(line); continue
        }
        output.append(Substring(rewriteLinks(in: line, taskId: taskId, workspacePaths: workspacePaths)))
    }
    return output.joined(separator: "\n")
}

private let inlineLink = try! NSRegularExpression(pattern: #"(`+)[\s\S]*?\1|(!?)\[([^\]\n]*)\]\((?:<([^>\n]*)>|([^\s()<>]+))(\s+"[^"\n]*")?\)"#)

private func rewriteLinks(in line: Substring, taskId: String?, workspacePaths: [String?]) -> String {
    let text = String(line)
    let source = text as NSString
    var result = ""
    var cursor = 0
    for match in inlineLink.matches(in: text, range: NSRange(location: 0, length: source.length)) {
        // Code spans (group 1) and images keep their text.
        guard match.range(at: 1).location == NSNotFound, source.substring(with: match.range(at: 2)).isEmpty else { continue }
        let label = source.substring(with: match.range(at: 3))
        let destination = match.range(at: 4).location != NSNotFound ? source.substring(with: match.range(at: 4)) : source.substring(with: match.range(at: 5))
        guard isLocalFilePath(destination) else { continue }
        let replacement: String
        if let taskId, let reference = taskFileReference(destination, taskId: taskId, workspacePaths: workspacePaths), let url = reference.linkURL {
            replacement = "[\(label)](<\(url.absoluteString)>)"
        } else {
            let shown = label.isEmpty ? destination : label
            replacement = shown.contains("`") ? shown : "`\(shown)`"
        }
        result += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)) + replacement
        cursor = match.range.location + match.range.length
    }
    return result + source.substring(from: cursor)
}
