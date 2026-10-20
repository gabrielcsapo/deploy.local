import Foundation

/// First-line titles retain whole words and reserve a character for the ellipsis.
public func taskTitle(_ prompt: String, limit: Int = 72) -> String {
    let line = (prompt.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines).first ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard line.count > limit else { return line }
    let characters = Array(line)
    var prefix = String(characters.prefix(max(0, limit - 1)))
    if limit > 0, !characters[limit - 1].isWhitespace {
        prefix = prefix.replacingOccurrences(of: #"\s*\S*$"#, with: "", options: .regularExpression)
    }
    var words = prefix.split(whereSeparator: \.isWhitespace).map(String.init)
    while let last = words.last, last.range(of: #"^\d+[\p{P}\p{S}]*$"#, options: .regularExpression) != nil { words.removeLast() }
    return words.joined(separator: " ") + "…"
}

public struct TaskPublishResult: Decodable, Sendable {
    public let pull: ProjectWorkItem
    public let branch: String
    public let commit: String
}
