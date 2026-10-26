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

/// An attachment matched to a path an agent wrote; only media has a viewer to open.
public struct MessageAttachmentRef: Equatable, Sendable {
    public let id: String
    public let name: String
    public let kind: String
    public init(id: String, name: String, kind: String) { self.id = id; self.name = name; self.kind = kind }
    public var viewable: Bool { ["image", "video"].contains(kind) }
}

/// Where the dashboard serves an attachment the agent produced.
public func attachmentURLPath(_ id: String) -> String { "/api/workspace/attachments/\(id)" }

/// A file the agent attached to this task, matched by name. Artifacts and attachments are copied
/// off their computer, so the agent names them by a path only that computer has; the app can
/// still open the copy the coordinator holds.
public func attachmentForPath(_ path: String, attachments: [MessageAttachmentRef]) -> MessageAttachmentRef? {
    var value = path
    if value.lowercased().hasPrefix("file://") { value = String(value.dropFirst("file://".count)) }
    if let query = value.firstIndex(where: { $0 == "?" || $0 == "#" }) { value = String(value[..<query]) }
    value = value.removingPercentEncoding ?? value
    if let location = value.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) { value = String(value[..<location.lowerBound]) }
    guard let name = value.split(separator: "/").last.map(String.init), !name.isEmpty else { return nil }
    return attachments.first { $0.name == name }
}

/// Agents name report files by their absolute path on the task computer, e.g.
/// `[verification.md](</var/home/me/.config/deploy.local Node/worker/tasks/<id>/docs/verification.md>)`,
/// and just as often as bare text. Paths inside the task workspace become `deploy-task-file:`
/// links the app opens in the task, a path naming media the agent attached shows that attachment,
/// and other disk paths, which nothing here can open, become inline code instead of dead links.
/// Code spans and fenced code blocks are left exactly as written.
public func rewriteLocalFileLinks(_ markdown: String, taskId: String?, workspacePaths: [String?] = [],
                                  attachments: [MessageAttachmentRef] = []) -> String {
    guard markdown.contains("/") else { return markdown }
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
        output.append(Substring(rewriteLinks(in: line, taskId: taskId, workspacePaths: workspacePaths, attachments: attachments)))
    }
    return output.joined(separator: "\n")
}

/// Code spans, Markdown links/images and autolinks keep their text exactly as written.
private let inlineLink = try! NSRegularExpression(pattern: #"(`+)[\s\S]*?\1|(!?)\[([^\]\n]*)\]\((?:<([^>\n]*)>|([^\s()<>]+))(\s+"[^"\n]*")?\)|<[^\s<>]*>"#)
/// A bare absolute path with an optional `:12` or `#L12` location. The lookbehind keeps the path
/// inside a URL (`https://host/a/b`) from matching on its own.
private let barePath = try! NSRegularExpression(pattern: #"(?<![\w:/@.~%+-])(?:file://(?:localhost)?)?/(?:[\w.@~%+-]+/)+[\w.@~%+-]*(?:[:#]L?\d+(?:[-:]L?\d+)?)?"#)

private func rewriteLinks(in line: Substring, taskId: String?, workspacePaths: [String?],
                          attachments: [MessageAttachmentRef]) -> String {
    let text = String(line)
    let source = text as NSString
    var result = ""
    var cursor = 0
    let bare = { (range: NSRange) in
        rewriteBarePaths(source.substring(with: range), taskId: taskId, workspacePaths: workspacePaths, attachments: attachments)
    }
    for match in inlineLink.matches(in: text, range: NSRange(location: 0, length: source.length)) {
        let gap = NSRange(location: cursor, length: match.range.location - cursor)
        cursor = match.range.location + match.range.length
        // Code spans (group 1), autolinks (no group 2) and images keep their text.
        guard match.range(at: 1).location == NSNotFound, match.range(at: 2).location != NSNotFound,
              source.substring(with: match.range(at: 2)).isEmpty else {
            result += bare(gap) + source.substring(with: match.range); continue
        }
        let label = source.substring(with: match.range(at: 3))
        let destination = match.range(at: 4).location != NSNotFound ? source.substring(with: match.range(at: 4)) : source.substring(with: match.range(at: 5))
        guard isLocalFilePath(destination) else {
            result += bare(gap) + source.substring(with: match.range); continue
        }
        let replacement: String
        if let taskId, let reference = taskFileReference(destination, taskId: taskId, workspacePaths: workspacePaths), let url = reference.linkURL {
            replacement = "[\(label)](<\(url.absoluteString)>)"
        } else if let attachment = attachmentForPath(destination, attachments: attachments), attachment.viewable {
            replacement = "![\(attachment.name)](\(attachmentURLPath(attachment.id)))"
        } else {
            let shown = label.isEmpty ? destination : label
            replacement = shown.contains("`") ? shown : "`\(shown)`"
        }
        result += bare(gap) + replacement
    }
    return result + bare(NSRange(location: cursor, length: source.length - cursor))
}

private func rewriteBarePaths(_ text: String, taskId: String?, workspacePaths: [String?],
                              attachments: [MessageAttachmentRef]) -> String {
    guard text.contains("/") else { return text }
    let source = text as NSString
    var result = ""
    var cursor = 0
    for match in barePath.matches(in: text, range: NSRange(location: 0, length: source.length)) {
        let matched = source.substring(with: match.range)
        // Sentence punctuation that happens to end a path stays outside the rewrite.
        let trailing = matched.range(of: #"[.,;:]+$"#, options: .regularExpression)
        let path = trailing.map { String(matched[..<$0.lowerBound]) } ?? matched
        result += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
        cursor = match.range.location + match.range.length
        if !isLocalFilePath(path) {
            result += matched; continue
        }
        if let taskId, let reference = taskFileReference(path, taskId: taskId, workspacePaths: workspacePaths), let url = reference.linkURL {
            result += "[\(path)](<\(url.absoluteString)>)"
        } else if let attachment = attachmentForPath(path, attachments: attachments), attachment.viewable {
            result += "![\(attachment.name)](\(attachmentURLPath(attachment.id)))"
        } else {
            result += "`\(path)`"
        }
        result += trailing.map { String(matched[$0.lowerBound...]) } ?? ""
    }
    return result + source.substring(from: cursor)
}
