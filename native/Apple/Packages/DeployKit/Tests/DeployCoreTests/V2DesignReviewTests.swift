import Foundation
import Testing
@testable import DeployCore

struct V2DesignReviewTests {
    private func review(round: Int = 1) throws -> V2DesignReview {
        let item = #"{"id":"design:p:branch:b","kind":"other","title":"A review","text":"","from":"designer","createdAt":"2026-11-04T12:00:00Z","actions":[],"state":"waiting"}"#
        // Intentionally shuffled transport order, interleaved statuses and two real canvas pages.
        let boards = [board("removed", kind: "removed"), board("new", kind: "new"), board("changed2", changed: false), board("changed1")].joined(separator: ",")
        let json = #"{"item":\#(item),"branch":"branch","before":"a","after":"b","boards":[\#(boards)],"notes":[{"id":"note","title":"How agents work","before":[{"text":"Before"}],"after":[{"text":"After","added":true}],"changed":1,"total":1}],"round":\#(round),"stale":false,"pins":[],"groups":[{"id":"one","title":"One","boards":["new","changed1"]},{"id":"two","title":"Two","boards":["removed","changed2"]}]}"#
        return try JSONDecoder().decode(V2DesignReview.self, from: Data(json.utf8))
    }
    private func board(_ file: String, kind: String = "changed", changed: Bool = true) -> String {
        #"{"file":"\#(file)","title":"Human \#(file)","w":390,"h":844,"widths":[390],"added":\#(kind == "new"),"removed":\#(kind == "removed"),"status":"\#(kind)","before":"screen-before","after":"screen-after","lines":[],"seen":false,"changedSinceReview":\#(changed)}"#
    }
    private func pin(_ number: Int, resolved: Bool) throws -> V2ReviewPin {
        try JSONDecoder().decode(V2ReviewPin.self, from: Data(#"{"id":"p\#(number)","number":\#(number),"board":"changed1","noteId":null,"width":390,"revision":"b","x":12,"y":25,"text":"Keep the name visible","author":"owner","resolved":\#(resolved),"reply":"Kept the name","createdAt":"2026-11-04T12:00:00Z"}"#.utf8))
    }
    @Test func pagerUsesStatusThenCanvasOrderAndCountsOnlyScreens() throws {
        let review = try review()
        #expect(V2ReviewModel.canvasBoards(review).map(\.file) == ["new", "changed1", "removed", "changed2"])
        #expect(V2ReviewModel.screens(review).map(\.file) == ["changed1", "changed2", "new", "removed"])
        #expect(V2ReviewModel.pages(review) == [.cover, .screen("changed1"), .screen("changed2"), .screen("new"), .screen("removed"), .note("note"), .decide])
        #expect(review.boards.first?.name == "Human removed")
    }
    @Test func orderingToleratesMissingAndDuplicateGroupReferences() throws {
        var review = try review()
        review.groups = [V2ReviewGroup(id: nil, title: nil, boards: ["changed1", "missing", "changed1"])]
        #expect(V2ReviewModel.canvasBoards(review).map(\.file) == ["changed1", "removed", "new", "changed2"])
    }
    @Test func pinsAcrossScreensAndNotesControlPrimaryAction() throws {
        var review = try review()
        #expect(V2ReviewModel.primaryAction(review) == .approve)
        var note = try pin(8, resolved: false); note.board = "canvas.json"; note.noteId = "note"
        review.pins = [try pin(1, resolved: true), try pin(2, resolved: false), note]
        #expect(V2ReviewModel.primaryAction(review) == .changes(2))
        #expect(V2ReviewModel.primaryAction(review).title == "Ask for 2 changes")
        review.pins = [try pin(1, resolved: true), note]
        #expect(V2ReviewModel.primaryAction(review).title == "Ask for 1 change")
        review.stale = true
        #expect(V2ReviewModel.primaryAction(review) == .update)
    }
    @Test func nextUnseenWrapsOnceAndNeverMutatesSeen() throws {
        var review = try review()
        #expect(V2ReviewModel.nextUnseen(review, after: nil) == "changed1")
        #expect(V2ReviewModel.nextUnseen(review, after: "removed") == "changed1")
        for index in review.boards.indices { review.boards[index].seen = review.boards[index].file != "changed2" }
        #expect(V2ReviewModel.nextUnseen(review, after: "new") == "changed2")
        #expect(V2ReviewModel.nextUnseen(review, after: "changed2") == "changed2")
        #expect(review.boards.first { $0.file == "changed2" }?.seen == false)
        for index in review.boards.indices { review.boards[index].seen = true }
        #expect(V2ReviewModel.nextUnseen(review, after: "new") == nil)
        review.boards = []
        #expect(V2ReviewModel.nextUnseen(review, after: nil) == nil)
    }
    @Test func secondRoundUsesOnlyRevisedScreensInCanvasOrder() throws {
        var review = try review(round: 2)
        let unchanged = review.boards.firstIndex { $0.file == "changed2" }!
        review.boards[unchanged].seen = true
        review.pins = [try pin(1, resolved: false), try pin(2, resolved: true)]
        #expect(V2ReviewModel.screens(review).map(\.file) == ["new", "changed1", "removed"])
        #expect(V2ReviewModel.canvasBoards(review).count == 4)
        #expect(review.boards[unchanged].seen == true)
        #expect(V2ReviewModel.nextUnseen(review, after: "removed") == "new")
        #expect(V2ReviewModel.primaryAction(review) == .changes(1))
        #expect(review.boards[unchanged].before == "screen-before")
    }
    @Test func changeBarClampsAtBothEndsIncludingNoRegions() {
        #expect(V2ReviewModel.stepChange(0, by: -1, count: 2) == 0)
        #expect(V2ReviewModel.stepChange(0, by: 1, count: 2) == 1)
        #expect(V2ReviewModel.stepChange(1, by: 1, count: 2) == 1)
        #expect(V2ReviewModel.stepChange(1, by: -1, count: 2) == 0)
        #expect(V2ReviewModel.stepChange(9, by: 1, count: 0) == 0)
    }
    @Test func reviewTimesUsePlainUnitsAndDoNotInventUnknownDates() {
        let now = Date(timeIntervalSince1970: 7200)
        #expect(V2ReviewModel.age("1970-01-01T00:00:00Z", now: now) == "2 h ago")
        #expect(V2ReviewModel.age("1970-01-01T01:50:00Z", now: now) == "10 min ago")
        #expect(V2ReviewModel.age("1970-01-01T03:00:00Z", now: now) == "just now")
        #expect(V2ReviewModel.age("missing", now: now) == "Time unavailable")
    }
    @Test func previewPreservesNativeGeometryWordsAndPerScreenWidths() throws {
        let preview = try JSONDecoder().decode(V2ReviewPreview.self, from: Data(#"{"width":1440,"height":900,"before":"/before.png","after":"/after.png","areas":[{"layer":"input","words":"Input above the quick actions","before":{"x":600,"y":200,"w":400,"h":80},"after":{"x":620,"y":240,"w":420,"h":90}}],"crop":{"x":572,"y":192,"w":516,"h":186}}"#.utf8))
        #expect(preview.areas[0].words == "Input above the quick actions")
        #expect(preview.areas[0].after?.x == 620)
        #expect(preview.crop.w == 516)
        let board = try review().boards[0]
        #expect(board.defaultWidth == 390)
        #expect(board.previewWidths == [390])
    }
    @Test func conflictCountSeparatesScreensAndNotes() {
        #expect(V2ReviewModel.conflictCount(["Agent.html"]) == "1 screen conflicts with main")
        #expect(V2ReviewModel.conflictCount(["A.html", "B.html", "note:x"]) == "2 screens and 1 note conflict with main")
        #expect(V2ReviewModel.conflictCount(["note:x", "note:y"]) == "2 notes conflict with main")
    }
    @Test func missingSummaryAsksTheProposerOrTellsYou() {
        #expect(V2ReviewProposer(id: "a1", name: "Release notes writer").missingSummary == "No summary. Ask Release notes writer to add one")
        #expect(V2ReviewProposer(id: nil, name: "You").missingSummary == "No summary. Add one when you propose again.")
    }
}
