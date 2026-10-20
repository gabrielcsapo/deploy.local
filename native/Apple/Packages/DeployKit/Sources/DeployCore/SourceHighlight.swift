import Foundation

/// Small, bounded preview lexer. Roles are mapped to semantic design tokens by the UI.
public enum SourceHighlight {
    public enum Role: Sendable { case plain, keyword, string, comment, number }
    public struct Span: Sendable {
        public let text: String
        public let role: Role
    }
    public static func lines(_ content: String, path: String) -> [[Span]] {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        let supported = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "swift", "json", "yaml", "yml", "md", "markdown"]
        let text = String(content.prefix(256 * 1024)) as NSString
        let hashComments = ["yaml", "yml", "md", "markdown"].contains(ext)
        let pattern = #"(/\*[\s\S]*?\*/|//[^\n]*|<!--[\s\S]*?-->)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(break|case|catch|class|const|continue|default|defer|do|else|enum|export|extension|false|for|from|func|function|guard|if|import|in|interface|let|new|nil|null|private|public|return|static|struct|switch|throw|throws|true|try|type|typeof|var|void|while|async|await)\b|\b(0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b"#
        let regex = try? NSRegularExpression(pattern: (hashComments ? "(#[^\\n]*)|" : "") + pattern)
        let matches = supported.contains(ext) ? regex?.matches(in: text as String, range: NSRange(location: 0, length: text.length)) ?? [] : []
        var offset = 0, cursor = 0
        return (text as String).components(separatedBy: "\n").map { line in
            let length = (line as NSString).length
            let range = NSRange(location: offset, length: length)
            defer { offset += length + 1 }
            while cursor < matches.count && NSMaxRange(matches[cursor].range) <= offset { cursor += 1 }
            var spans: [Span] = [], position = offset, index = cursor
            while index < matches.count && matches[index].range.location < NSMaxRange(range) {
                let match = matches[index], intersection = NSIntersectionRange(range, match.range)
                if intersection.length > 0 {
                    if intersection.location > position { spans.append(Span(text: text.substring(with: NSRange(location: position, length: intersection.location - position)), role: .plain)) }
                    let group = (1..<match.numberOfRanges).first { match.range(at: $0).location != NSNotFound } ?? 0
                    let role: Role
                    if hashComments && group == 1 { role = .comment }
                    else {
                        switch group - (hashComments ? 1 : 0) {
                        case 1: role = .comment
                        case 2: role = .string
                        case 3: role = .keyword
                        case 4: role = .number
                        default: role = .plain
                        }
                    }
                    spans.append(Span(text: text.substring(with: intersection), role: role))
                    position = NSMaxRange(intersection)
                }
                index += 1
            }
            if position < NSMaxRange(range) { spans.append(Span(text: text.substring(with: NSRange(location: position, length: NSMaxRange(range) - position)), role: .plain)) }
            return spans
        }
    }
}
