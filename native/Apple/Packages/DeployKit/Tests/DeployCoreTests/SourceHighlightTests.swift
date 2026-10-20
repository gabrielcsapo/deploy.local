import Testing
@testable import DeployCore

@Test func sourceHighlightKeepsTextAndLineNumbersAcrossMultilineCommentsAndUnicode() {
    let content = "const café = 12; /* comment\n still comment */\nlet emoji = \"🐱\"; // true 42\n"
    let lines = SourceHighlight.lines(content, path: "example.ts")
    #expect(lines.map { $0.map(\.text).joined() }.joined(separator: "\n") == content)
    #expect(lines.count == 4)
    #expect(lines[0].contains { $0.role == .keyword && $0.text == "const" })
    #expect(lines[0].contains { $0.role == .number && $0.text == "12" })
    #expect(lines[1].first?.role == .comment)
    #expect(lines[2].contains { $0.role == .string && $0.text == "\"🐱\"" })
    #expect(lines[2].last?.role == .comment)
}

@Test func sourceHighlightSupportsFileTypesAndKeepsStringsOutOfComments() {
    for path in ["a.js", "a.ts", "a.swift", "a.json", "a.yml", "a.yaml", "a.md"] {
        let lines = SourceHighlight.lines("\"https://example.test/#value\" 42", path: path)
        #expect(lines[0].first?.role == .string)
        #expect(lines[0].last?.role == .number)
    }
    #expect(SourceHighlight.lines("key: true # note", path: "a.yaml")[0].last?.role == .comment)
    #expect(SourceHighlight.lines("# Title", path: "README.md")[0].first?.role == .comment)
    #expect(SourceHighlight.lines("let x = 1", path: "a.txt")[0].allSatisfy { $0.role == .plain })
}
