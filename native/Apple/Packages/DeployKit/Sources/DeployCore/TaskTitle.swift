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

/// Words that carry nothing on their own, so a shortened title never ends on one.
private let danglingWord = #"^(?:a|an|the|and|or|but|so|that|which|who|whom|whose|with|without|for|to|in|into|on|onto|at|by|of|from|as|if|when|while|than|then|also|its|their|our|your|this|these|those|it|is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|should|would|will|may|might|must|not|every|each|any|some|more|most|other|another|per|via|about|after|before|between|across|over|under|plus)$"#

/// A title that stops mid-thought: trailing punctuation, bare numbers and words that only led
/// into text the title no longer carries.
private func settle(_ text: String) -> String {
    var words = text.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isWhitespace).map(String.init)
    while words.count > 1 {
        let last = words[words.count - 1]
        let bare = last.replacingOccurrences(of: #"[\p{P}\p{S}]+$"#, with: "", options: .regularExpression)
        guard last.range(of: #"^\d+[\p{P}\p{S}]*$"#, options: .regularExpression) != nil
            || bare.range(of: danglingWord, options: [.regularExpression, .caseInsensitive]) != nil
        else { break }
        words.removeLast()
    }
    return words.joined(separator: " ")
        .replacingOccurrences(of: #"[\s,;:]+$"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\.$"#, with: "", options: .regularExpression)
}

/// Punctuation that ends a clause, and the words that start a trailing one. Cutting here leaves
/// a title that still reads as a sentence about the change, where a word cut does not.
private let clauseEndPattern = #"[,;:]|\s+[—–]\s+|\s+-\s+|\s+\("#
private let clauseStartPattern = #"\s+(?:and|or|but|so|then|plus|also|for|with|without|in|into|on|onto|of|to|from|about|under|over|within|across|by|using|via|when|while|after|before|against|though|although|because|that|which|who|where)\s+\S"#

private func clauseBoundaries(_ line: String) -> [Int] {
    let source = line as NSString
    var points: [Int] = []
    for pattern in [clauseEndPattern, clauseStartPattern] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { continue }
        points += regex.matches(in: line, range: NSRange(location: 0, length: source.length)).map(\.range.location)
    }
    return points.sorted()
}

/// Shorten a title that names a change. A trailing "…" names nothing, so this drops what a
/// reader does not need instead: an "in <subject>" suffix that repeats the project the change
/// already belongs to, then the longest trailing clause it can spare, and only then whole
/// words. The result never ends in an ellipsis.
public func shortenTitle(_ line: String, limit: Int = 72, subject: String = "") -> String {
    var text = (line.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines).first ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.count > limit else { return text }
    let name = subject.trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty {
        let escaped = NSRegularExpression.escapedPattern(for: name)
        let dropped = settle(text.replacingOccurrences(
            of: "[,;]?\\s+(?:in|for|of|on|within|across|to)\\s+\(escaped)\\.?$",
            with: "",
            options: [.regularExpression, .caseInsensitive]))
        if !dropped.isEmpty { text = dropped }
        if text.count <= limit { return text }
    }
    // The longest clause that still fits keeps the most of what the request said. Two words is
    // not a title, so a boundary that leaves only those is no better than a word cut.
    let source = text as NSString
    for point in clauseBoundaries(text).reversed() {
        let candidate = settle(source.substring(to: point))
        if candidate.split(whereSeparator: \.isWhitespace).count >= 3 && candidate.count <= limit { return candidate }
    }
    let characters = Array(text)
    let prefix = String(characters.prefix(limit))
    let whole = characters[limit].isWhitespace
        ? prefix
        : prefix.replacingOccurrences(of: #"\s*\S*$"#, with: "", options: .regularExpression)
    let settled = settle(whole)
    return settled.isEmpty ? prefix : settled
}

/// Chat openers and politeness that say nothing about the change.
private let titleFiller = #"^(?:(?:ok(?:ay)?|hi|hey|thanks|so|now|next|also|and|then|please|pls|can you|could you|would you|will you|i'?d like(?: you)? to|i would like(?: you)? to|i want(?: you)? to|i need(?: you)? to|we (?:should|need to|must|want to)|let'?s|you should|go ahead and|help me|try to)\b[,:]?\s+)+"#

/// The title of the change a task was asked to make: its own request, stripped of chat filler
/// and sentence punctuation and shortened at a clause boundary. Follow-up messages never title a
/// change — they report on the conversation ("The limit is fixed…"), not on the work. `subject`
/// is the project the change belongs to, whose name a title does not need to repeat.
public func changeTitle(_ stored: String, firstMessage: String = "", limit: Int = 72, subject: String = "") -> String {
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
    guard let first = clean.first else { return shortenTitle(source, limit: limit, subject: subject) }
    return shortenTitle(first.uppercased() + clean.dropFirst(), limit: limit, subject: subject)
}
