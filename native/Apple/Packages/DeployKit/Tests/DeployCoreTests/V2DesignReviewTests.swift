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
    @Test func conflictsOpenFirstAndChoicesControlReadiness() throws {
        var value = try review()
        let json = #"[{"file":"changed1","kind":"kept-both","mainChanged":"release list","proposalChanged":"header","detail":"Different parts changed."},{"file":"changed2","kind":"same-part","mainChanged":"Main header","proposalChanged":"Proposal header","detail":"Both changed the header row."}]"#
        value.resolutions = try JSONDecoder().decode([V2ReviewResolution].self, from: Data(json.utf8))
        #expect(V2ReviewModel.resolutionProgress(value) == "1 of 2 resolved")
        #expect(!V2ReviewModel.resolutionsReady(value))
        #expect(V2ReviewModel.firstConflict(value) == .conflict("changed2"))
        #expect(Array(V2ReviewModel.pages(value).prefix(3)) == [.conflict("changed1"), .conflict("changed2"), .cover])
        value.resolutions?[1].choice = "main"
        #expect(V2ReviewModel.resolutionsReady(value))
        #expect(V2ReviewModel.resolutionProgress(value) == "2 of 2 resolved")
        value.resolutions?[1].choice = nil
        #expect(!V2ReviewModel.resolutionsReady(value))
        value.resolutions?[1].choice = "proposal"
        #expect(V2ReviewModel.resolutionsReady(value))
        value.resolutions = nil; value.stale = true
        #expect(!V2ReviewModel.resolutionsReady(value))
    }
    @Test func oldAndNewReviewResponsesDecodeAndRowsPresentTheirEvidence() throws {
        let old = try review()
        #expect(old.changes == nil && old.landing == nil)
        #expect(V2ReviewModel.rows(old).count == old.boards.count)
        let json = #"{"id":"header","title":"Header row","status":"changed","screens":["changed1","changed2"],"added":["Projects ›"],"removed":["Project"],"removedIcon":true,"variations":1,"nothingElse":true,"seen":false}"#
        let response = #"{"item":{"id":"design:p:b:c","kind":"other","title":"Review","text":"","from":"designer","createdAt":"now","actions":[],"state":"waiting"},"branch":"b","before":"a","after":"c","boards":[\#(board("changed1")),\#(board("changed2"))],"changes":[\#(json)],"landing":{"at":"2026-11-09T12:00:30Z","state":"pending"}}"#
        var value = try JSONDecoder().decode(V2DesignReview.self, from: Data(response.utf8))
        let row = try #require(value.changes?.first)
        #expect(value.landing?.state == "pending")
        #expect(row.subtitle == "2 screens · adds Projects ›")
        #expect(row.words == "Added Projects ›. Removed Project and an icon.")
        #expect(V2ReviewModel.progress(value) == "0 of 1")
        value.changes?[0].seen = true
        #expect(V2ReviewModel.progress(value) == "1 of 1")
        #expect(V2ReviewModel.nextUnseen(value, after: nil) == nil)
        var same = row; same.status = "looksSame"
        #expect(same.subtitle == "2 screens · nothing looks different")
        var new = row; new.status = "new"; new.screens = ["new"]
        #expect(new.subtitle == "New")
        new.status = "changed"; #expect(new.subtitle == "Changed")
        new.changeWords = "Authored words remain unchanged, even when they are longer than forty characters."
        #expect(new.words == new.changeWords)
    }
    @Test func approvalCheckAndCountdownUseAuthoritativeLandingState() throws {
        var value = try review()
        #expect(!V2ReviewModel.needsApprovalCheck(value))
        #expect(V2ReviewModel.needsApprovalCheck(value, draft: "Keep this"))
        value.pins = [try pin(1, resolved: false)]
        #expect(V2ReviewModel.needsApprovalCheck(value))
        value.pins?[0].resolved = true
        #expect(!V2ReviewModel.needsApprovalCheck(value))
        value.item.answer = .init(actionId: "approve", by: "owner", on: .iphone, at: "2026-11-09T12:00:00Z")
        value.item.state = .answered
        value.landing = try JSONDecoder().decode(V2ReviewLanding.self, from: Data(#"{"at":"2026-11-09T12:00:30.000Z","state":"pending"}"#.utf8))
        let now = ISO8601DateFormatter().date(from: "2026-11-09T12:00:01Z")!
        #expect(V2ReviewModel.outcome(value, now: now) == "Approved · goes to main in 29 s")
        #expect(value.landing?.secondsRemaining(now: now.addingTimeInterval(60)) == 0)
        value.landing?.state = "landed"
        #expect(V2ReviewModel.outcome(value, now: now) == "Approved · this is the design on main")
        value.item.answer = nil; value.item.state = .waiting; value.landing = nil
        #expect(V2ReviewModel.outcome(value).isEmpty)
    }
    @Test func newAnchorsRoundTripWithoutBreakingLegacyPins() throws {
        var value = try pin(1, resolved: false)
        #expect(value.layer == nil && value.offset == nil && value.area == nil)
        value.layer = "head"; value.offset = .init(x: 0.5, y: 0.25)
        value.area = .init(x: 12, y: 20, w: 90, h: 50)
        let decoded = try JSONDecoder().decode(V2ReviewPin.self, from: JSONEncoder().encode(value))
        #expect(decoded.layer == "head" && decoded.offset == value.offset && decoded.area == value.area)
        var draft = V2ReviewPinDraft(item: "item", board: value.board, width: 390, revision: "b", x: 12, y: 25)
        draft.layer = value.layer; draft.offset = value.offset; draft.area = value.area
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        #expect(body["layer"] as? String == "head")
        #expect((body["area"] as? [String: Double])?["w"] == 90)
    }
    @Test func decisionFooterAndSentNoticeKeepTheReviewRecord() throws {
        var value = try review(round: 2)
        value.item.answer = .init(actionId: "changes", by: "owner", on: .iphone, at: "2026-11-07T12:00:00Z")
        value.item.state = .answered
        value.item.fromName = "Release notes writer"
        value.pins = [try pin(1, resolved: false)]
        let now = ISO8601DateFormatter().date(from: "2026-11-07T12:00:00Z")!
        #expect(V2ReviewModel.outcome(value, now: now) == "Changes requested · just now · propose again when the screens are updated.")
        #expect(V2ReviewModel.sentNotice(value)?.title == "1 change sent to Release notes writer")
        value.item.taskId = "task-1"
        value.boards[0].seen = true
        #expect(V2ReviewModel.outcome(value, now: now) == "Changes requested · just now · you looked at 1 of 4")
        value.item.answer?.actionId = "approve"
        #expect(V2ReviewModel.outcome(value, now: now) == "Approved · this is the design on main")
        #expect(V2ReviewModel.sentNotice(value) == nil)
    }
    @Test func chatCropUsesEachSidesChangeAtTheApprovedZoom() throws {
        let preview = try JSONDecoder().decode(V2ReviewPreview.self, from: Data(#"{"width":700,"height":900,"areas":[{"layer":"composer","words":"Input","before":{"x":0,"y":600,"w":700,"h":100},"after":{"x":0,"y":200,"w":700,"h":100}}],"crop":{"x":0,"y":0,"w":700,"h":900}}"#.utf8))
        let before = V2ReviewModel.cardRegion(preview, side: "before", aspect: 1.3)
        let after = V2ReviewModel.cardRegion(preview, side: "after", aspect: 1.3)
        #expect(before.w == 700 && before.y > after.y)
        #expect(before.y + before.h <= 900 && after.y >= 0)
    }
    private func board(_ file: String, kind: String = "changed", changed: Bool = true) -> String {
        #"{"file":"\#(file)","title":"Human \#(file)","w":390,"h":844,"widths":[390],"added":\#(kind == "new"),"removed":\#(kind == "removed"),"status":"\#(kind)","before":"screen-before","after":"screen-after","lines":[],"seen":false,"changedSinceReview":\#(changed)}"#
    }
    private func pin(_ number: Int, resolved: Bool) throws -> V2ReviewPin {
        try JSONDecoder().decode(V2ReviewPin.self, from: Data(#"{"id":"p\#(number)","number":\#(number),"board":"changed1","noteId":null,"width":390,"revision":"b","x":12,"y":25,"text":"Keep the name visible","author":"owner","resolved":\#(resolved),"reply":"Kept the name","createdAt":"2026-11-04T12:00:00Z"}"#.utf8))
    }
    @Test func drawingsRoundTripAndLegacyPinsStayCompatible() throws {
        var pin = try pin(4, resolved: false)
        #expect(pin.drawing == nil)
        let drawing = V2ReviewDrawing(side: "after", nativeWidth: 390, nativeHeight: 844, anchor: .init(x: 0.5, y: 0.25),
                                      strokes: [[.init(x: 0, y: 0), .init(x: 1, y: 1)], [.init(x: 0.5, y: 0.25)]])
        pin.drawing = drawing
        let decoded = try JSONDecoder().decode(V2ReviewPin.self, from: JSONEncoder().encode(pin))
        #expect(decoded.drawing == drawing)
        #expect(decoded.revision == pin.revision)
        let draft = V2ReviewPinDraft(item: "review", board: pin.board, width: 390, revision: pin.revision, x: 195, y: 211, text: pin.text, drawing: drawing)
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        let encodedDrawing = try #require(json["drawing"] as? [String: Any])
        #expect(encodedDrawing["weight"] as? Double == 3)
        #expect(try JSONDecoder().decode(V2ReviewDrawing.self, from: JSONSerialization.data(withJSONObject: encodedDrawing)) == drawing)
        var review = try review(); review.pins = [decoded]
        #expect(V2ReviewModel.primaryAction(review) == .changes(1))
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
    private func pin(_ fields: String) throws -> V2ReviewPin {
        let json = #"{"id":"p","number":1,"board":"A.html","width":812,"revision":"b","x":100,"y":40,"text":"Note","author":"o","resolved":false,"createdAt":"now""# + fields + "}"
        return try JSONDecoder().decode(V2ReviewPin.self, from: Data(json.utf8))
    }
    private func preview(layers: String = "") throws -> V2ReviewPreview {
        let json = #"{"width":1440,"height":900,"before":"b","after":"a","areas":[],"crop":{"x":0,"y":0,"w":1440,"h":900}"# + layers + "}"
        return try JSONDecoder().decode(V2ReviewPreview.self, from: Data(json.utf8))
    }
    @Test func aNoteFollowsItsElementAtAnyWidthAndOtherwiseStaysAtItsOwnWidth() throws {
        let boxes = try preview(layers: #","layers":{"after":{"name":{"x":200,"y":10,"w":50,"h":20}}}"#)
        let anchored = try pin(#","layer":"name","offset":{"x":0.5,"y":0.5},"area":{"x":90,"y":30,"w":40,"h":20}"#)
        let placed = try #require(anchored.placement(in: boxes, side: "after"))
        #expect(placed.point == .init(x: 225, y: 20))
        #expect(placed.area == V2ReviewRect(x: 215, y: 10, w: 40, h: 20))
        // The element is gone on this side, and the note was left at another width: nowhere honest to put it.
        #expect(anchored.placement(in: boxes, side: "before") == nil)
        let plain = try pin("")
        #expect(plain.placement(in: boxes, side: "after") == nil)
    }
    @Test func missingSummaryAsksTheProposerOrTellsYou() {
        #expect(V2ReviewProposer(id: "a1", name: "Release notes writer").missingSummary == "No summary. Ask Release notes writer to add one")
        #expect(V2ReviewProposer(id: nil, name: "You").missingSummary == "No summary. Add one when you propose again.")
    }
}
