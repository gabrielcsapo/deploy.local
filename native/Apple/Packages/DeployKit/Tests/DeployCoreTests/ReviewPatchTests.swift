import Testing
@testable import DeployCore

@Test func reviewDiffKeepsFileIdentityAndHunkLineNumbers() {
    let patch = """
    diff --git a/greet.js b/greet.js
    --- a/greet.js
    +++ b/greet.js
    @@ -4,2 +4,3 @@
     context
    -old
    +new
    +extra
    diff --git a/other.js b/other.js
    --- a/other.js
    +++ b/other.js
    @@ -1 +1 @@
    -before
    +after
    """
    let result = reviewFilePatches(patch, files: [.init(path: "greet.js", status: " M"), .init(path: "other.js", status: " M")])
    #expect(result.map(\.path) == ["greet.js", "other.js"])
    #expect(result[0].lines.filter { $0.kind == .addition }.map(\.newNumber) == [5, 6])
    #expect(result[0].lines.first { $0.kind == .deletion }?.oldNumber == 5)
    #expect(result[1].lines.last?.newNumber == 1)
}

@Test func reviewDiffPreservesHeaderLikeSourceAndMissingText() {
    let patch = """
    diff --git a/a.txt b/a.txt
    --- a/a.txt
    +++ b/a.txt
    @@ -1 +1 @@
    --- old text
    +++ new text
    \\ No newline at end of file
    """
    let result = reviewFilePatches(patch, files: [.init(path: "a.txt", status: " M"), .init(path: "binary.png", status: "??")])
    #expect(result[0].lines.contains { $0.text == "--- old text" && $0.kind == .deletion })
    #expect(result[0].lines.contains { $0.text == "+++ new text" && $0.kind == .addition })
    #expect(result[1].path == "binary.png" && result[1].lines.isEmpty)
}

@Test func reviewDiffSupportsQuotedPathsDeletionAndEmptyReview() {
    let patch = """
    diff --git "a/a b.txt" "b/a b.txt"
    --- "a/a b.txt"
    +++ /dev/null
    @@ -1 +0,0 @@
    -gone
    """
    let result = reviewFilePatches(patch, files: [.init(path: "a b.txt", status: " D")])
    #expect(result[0].path == "a b.txt")
    #expect(result[0].lines.last?.oldNumber == 1)
    #expect(reviewFilePatches("", files: []).isEmpty)
    #expect(reviewFilePatches("@@ - + @@", files: []).first?.lines.first?.kind == .hunk)
}

@Test func reviewDiffIdentifiesBinaryFilesAlongsideText() {
    let patch = """
    diff --git a/icon.png b/icon.png
    Binary files a/icon.png and b/icon.png differ
    diff --git "a/hero image.png" "b/hero image.png"
    Binary files differ
    """
    let result = reviewFilePatches(patch, files: [.init(path: "icon.png", status: " M"), .init(path: "hero image.png", status: " M")])
    #expect(result.map(\.path) == ["icon.png", "hero image.png"])
    #expect(result.allSatisfy { $0.lines.contains { $0.kind == .metadata } })
}
