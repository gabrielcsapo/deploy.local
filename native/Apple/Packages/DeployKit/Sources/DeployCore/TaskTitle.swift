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

/// The text a title describes: an editorial title as written, otherwise the opening request.
/// A stored title cut from that request is legacy truncation, so the full request wins.
private func titleSource(_ stored: String, _ firstMessage: String) -> String {
    let prompt = firstMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    let title = stored.trimmingCharacters(in: .whitespacesAndNewlines)
    let prefix = title.replacingOccurrences(of: #"(?:…|\.{3})$"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !prompt.isEmpty && (title.isEmpty || (prompt.hasPrefix(prefix) && prompt != title)) { return prompt }
    return title.isEmpty ? prompt : title
}

/// Retain editorial titles while repairing old titles cut from the opening prompt.
public func publishTitle(_ stored: String, firstMessage: String = "") -> String {
    let source = titleSource(stored, firstMessage)
    return source == stored.trimmingCharacters(in: .whitespacesAndNewlines) ? source : taskTitle(source)
}

/// Chat openers and politeness that say nothing about the change.
private let titleFiller = #"^(?:(?:ok(?:ay)?|hi|hey|thanks|so|now|next|also|and|then|please|pls|can you|could you|would you|will you|i'?d like(?: you)? to|i would like(?: you)? to|i want(?: you)? to|i need(?: you)? to|we (?:should|need to|must|want to)|let'?s|you should|go ahead and|help me|try to)\b[,:]?\s+)+"#

/// The title of the change a task was asked to make: its own request, stripped of chat filler
/// and sentence punctuation and shortened to whole words. Follow-up messages never title a
/// change — they report on the conversation ("The limit is fixed…"), not on the work.
public func changeTitle(_ stored: String, firstMessage: String = "", limit: Int = 72) -> String {
    let source = titleSource(stored, firstMessage)
    var line = (source.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines).first ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"^[-*+]\s+"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"^\*\*(.+?)\*\*$"#, with: "$1", options: .regularExpression)
    line = line.replacingOccurrences(of: titleFiller, with: "", options: [.regularExpression, .caseInsensitive])
    // Too long to use as it stands: a whole first sentence reads better than a cut-off line.
    if line.count > limit, let match = line.range(of: #"^.*?[.!?](?=\s|$)"#, options: .regularExpression) {
        let sentence = String(line[match])
        if sentence.count > 1 && sentence.count - 1 <= limit { line = sentence }
    }
    let clean = line.replacingOccurrences(of: #"[\s,;:]+$"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\.$"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    guard let first = clean.first else { return taskTitle(source, limit: limit) }
    return taskTitle(first.uppercased() + clean.dropFirst(), limit: limit)
}
