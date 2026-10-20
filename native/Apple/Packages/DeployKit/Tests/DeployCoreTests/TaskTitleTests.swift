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

@Test func publishTitlesRepairLegacyTruncationAndPreserveEditorialTitles() {
    let prompt = "Show elapsed time as HH:MM:SS in 24 hour format with a clear label for every task"
    #expect(publishTitle(String(prompt.prefix(72)), firstMessage: prompt) == taskTitle(prompt))
    #expect(publishTitle("Show elapsed time as HH:MM:SS in 24", firstMessage: prompt) == taskTitle(prompt))
    #expect(publishTitle(taskTitle(prompt), firstMessage: prompt) == taskTitle(prompt))
    #expect(publishTitle("Improve elapsed time labels", firstMessage: prompt) == "Improve elapsed time labels")
    #expect(publishTitle("", firstMessage: prompt) == taskTitle(prompt))
    #expect(publishTitle("A title") == "A title")
}
