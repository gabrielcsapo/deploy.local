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
