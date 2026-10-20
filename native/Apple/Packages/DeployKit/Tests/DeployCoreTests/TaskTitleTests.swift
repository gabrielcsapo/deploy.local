import Testing
@testable import DeployCore

@Test func taskTitlesKeepWholeWordsAndAvoidDanglingNumbers() {
    #expect(taskTitle("  A short title\nDetails") == "A short title")
    #expect(taskTitle("Show elapsed time as HH:MM:SS in 24 hours", limit: 35) == "Show elapsed time as HH:MM:SS in…")
    #expect(taskTitle("A task with 24 more things", limit: 16) == "A task with…")
    #expect(taskTitle("Supercalifragilistic", limit: 8) == "…")
    #expect(taskTitle("hello world", limit: 11) == "hello world")
    #expect(taskTitle("hello world again", limit: 12) == "hello world…")
}
