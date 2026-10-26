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

@Test func changeTitlesReadAsAnImperativeSummaryOfTheRequest() {
    #expect(changeTitle("Make pull requests published from deploy.local tasks read well.")
        == "Make pull requests published from deploy.local tasks read well")
    // Chat openers and politeness describe the conversation, not the change.
    #expect(changeTitle("Can you please fix the publish title?") == "Fix the publish title?")
    #expect(changeTitle("Also, let's group the checks.") == "Group the checks")
    #expect(changeTitle("**Rename the checks column**") == "Rename the checks column")
    #expect(changeTitle("- add a settings page") == "Add a settings page")
    // A long request keeps its first whole sentence rather than being cut mid-thought.
    #expect(changeTitle("Group the published checks by name. Early failures that were later fixed must not read as the result.")
        == "Group the published checks by name")
    #expect(changeTitle("Group every published check run by its name and computer so that a retried check reads as one result")
        == "Group every published check run by its name and computer so that a…")
    #expect(changeTitle("Please.") == "Please")
    #expect(changeTitle("") == "")
    // The opening request wins over a title cut from it; an editorial title is kept.
    #expect(changeTitle("Fix the limit…", firstMessage: "Fix the limit on checkpoints") == "Fix the limit on checkpoints")
    #expect(changeTitle("Checkpoint limits", firstMessage: "Fix the limit on checkpoints") == "Checkpoint limits")
}
