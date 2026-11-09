#if os(iOS)
import Testing
import Foundation
import UIKit
import DeployCore
@testable import DeployUI

private final class ReviewTransport: URLProtocol, @unchecked Sendable {
    static let state = State()
    final class State: @unchecked Sendable {
        let lock = NSLock()
        var status = 200
        var posts = 0
        func reset(status: Int) { lock.lock(); defer { lock.unlock() }; self.status = status; posts = 0 }
        func response(post: Bool, pin: Bool) -> (Int, String) {
            lock.lock(); defer { lock.unlock() }
            if post { posts += 1 }
            if post && pin && status == 200 { return (200, #"{"pins":[{"id":"saved","number":1,"board":"Screen.html","width":390,"revision":"c","x":195,"y":211,"text":"Keep the name visible.","author":"owner","resolved":false,"createdAt":"now","drawing":{"side":"after","nativeWidth":390,"nativeHeight":844,"anchor":{"x":0.5,"y":0.25},"weight":3,"strokes":[[{"x":0.5,"y":0.25}]]}}]}"#) }
            return post ? (status, status == 200 ? "{\"item\":\(answered)}" : #"{"error":"Try again later"}"#) : (200, reviewJSON)
        }
        func count() -> Int { lock.lock(); defer { lock.unlock() }; return posts }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.state.response(post: request.httpMethod == "POST", pin: request.url?.path.hasSuffix("/review/pins") == true)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private let waiting = #"{"id":"design:p:b:c","kind":"other","title":"Review","text":"","from":"designer","createdAt":"2026-11-04T12:00:00Z","actions":[],"state":"waiting"}"#
private let answered = #"{"id":"design:p:b:c","kind":"other","title":"Review","text":"","from":"designer","createdAt":"2026-11-04T12:00:00Z","actions":[],"state":"answered","answer":{"actionId":"changes","by":"owner","on":"iphone","at":"2026-11-04T12:00:00Z"}}"#
private let reviewJSON = "{\"item\":\(waiting),\"branch\":\"b\",\"before\":\"a\",\"after\":\"c\",\"boards\":[],\"pins\":[],\"stale\":false}"

@Suite(.serialized) @MainActor struct V2ReviewStateTests {
    private func setup(status: Int) throws -> (V2ReviewState, V2Client) {
        ReviewTransport.state.reset(status: status)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReviewTransport.self]
        let client = V2Client(connection: Connection(origin: "https://fixture.invalid", username: "owner", token: "test"), session: URLSession(configuration: config))
        let model = V2ReviewState()
        model.review = try JSONDecoder().decode(V2DesignReview.self, from: Data(reviewJSON.utf8))
        model.loading = false
        return (model, client)
    }
    private func screen(_ model: V2ReviewState, removed: Bool = false, added: Bool = false) throws -> V2DesignReview.Board {
        let board = try JSONDecoder().decode(V2DesignReview.Board.self, from: Data("{\"file\":\"Screen.html\",\"title\":\"Screen\",\"w\":390,\"h\":844,\"widths\":[390,700],\"added\":\(added),\"removed\":\(removed),\"before\":\"a\",\"after\":\"c\",\"lines\":[]}".utf8))
        model.review?.boards = [board]; model.page = .screen(board.file)
        let metadata = try JSONDecoder().decode(V2ReviewPreview.self, from: Data(#"{"width":390,"height":844,"areas":[],"crop":{"x":0,"y":0,"w":390,"h":844}}"#.utf8))
        model.previews[model.key(board)] = .init(metadata: metadata, before: added ? nil : UIImage(), after: removed ? nil : UIImage())
        return board
    }
    @Test func undoRefreshesTheAuthoritativeWaitingReview() async throws {
        let (model, client) = try setup(status: 200)
        model.review?.item.state = .answered
        model.review?.item.answer = .init(actionId: "approve", by: "owner", on: .iphone, at: "now")
        model.review?.landing = try JSONDecoder().decode(V2ReviewLanding.self, from: Data(#"{"state":"pending","at":"2099-11-09T12:00:30Z"}"#.utf8))
        await model.undoApproval(client: client)
        #expect(model.review?.item.state == .waiting && model.review?.item.answer == nil)
        #expect(model.review?.landing == nil && !model.saving)
        #expect(ReviewTransport.state.count() == 1)
    }
    @Test func comparisonChoiceIsRememberedForTheNextReview() throws {
        let original = UserDefaults.standard.string(forKey: V2DesignComparison.modeKey)
        defer { UserDefaults.standard.set(original, forKey: V2DesignComparison.modeKey) }
        let (model, _) = try setup(status: 200)
        model.comparisonMode = "slider"
        #expect(V2ReviewState().comparisonMode == "slider")
        model.comparisonMode = "onion"
        #expect(V2ReviewState().comparisonMode == "onion")
    }
    @Test func approvalWithNotesWaitsForExplicitChoice() throws {
        let (model, _) = try setup(status: 200)
        #expect(model.requestApproval())
        model.sheetText = "Keep this label"
        #expect(!model.requestApproval() && model.approvalCheck)
        #expect(model.review?.item.state == .waiting && ReviewTransport.state.count() == 0)
        model.sheetText = ""; model.approvalCheck = false
        model.review?.pins = [try JSONDecoder().decode(V2ReviewPin.self, from: Data(#"{"id":"p","number":1,"board":"Screen.html","width":390,"revision":"c","x":20,"y":20,"text":"Keep it","author":"owner","resolved":false,"createdAt":"now"}"#.utf8))]
        #expect(!model.requestApproval())
        model.review?.pins?[0].resolved = true
        #expect(model.requestApproval())
    }
    @Test func groupedSeenIsSentOnceAcrossEveryScreenInTheRow() async throws {
        let (model, client) = try setup(status: 200)
        let board = try screen(model)
        model.review?.changes = [try JSONDecoder().decode(V2ReviewRow.self, from: Data(#"{"id":"header","title":"Header row","status":"changed","screens":["Screen.html","Other.html"],"added":[],"removed":[],"variations":0,"nothingElse":true,"seen":false}"#.utf8))]
        await model.markSeen(client: client, file: board.file)
        await model.markSeen(client: client, file: "Other.html")
        #expect(model.review?.changes?.first?.seen == true && model.review?.boards.first?.seen == true)
        #expect(ReviewTransport.state.count() == 1)
    }
    @Test func areaDraftUsesNativeCoordinatesAndSmallestAvailableLayer() throws {
        let (model, _) = try setup(status: 200)
        let board = try screen(model)
        let metadata = try JSONDecoder().decode(V2ReviewPreview.self, from: Data(#"{"width":390,"height":844,"areas":[],"layers":{"after":{"head":{"x":10,"y":20,"w":100,"h":40},"wrapper":{"x":0,"y":0,"w":390,"h":844}}},"crop":{"x":0,"y":0,"w":390,"h":844}}"#.utf8))
        model.previews[model.key(board)] = .init(metadata: metadata, before: UIImage(), after: UIImage())
        model.drop(board: board.file, width: 390, revision: "c", point: CGPoint(x: 60, y: 40), area: .init(x: 20, y: 25, w: 80, h: 30))
        #expect(model.draft?.layer == "head")
        #expect(model.draft?.offset == .init(x: 0.5, y: 0.5))
        #expect(model.draft?.area?.w == 80 && model.pinSheet)
        _ = try screen(model)
        model.drop(board: board.file, width: 390, revision: "c", point: CGPoint(x: 60, y: 40))
        #expect(model.draft?.layer == nil && model.draft?.offset == nil && model.draft?.x == 60)
    }
    @Test func compareRequiresBothImagesAndLeavesOnWidthChange() throws {
        let (model, _) = try setup(status: 200)
        let board = try screen(model)
        model.toggleCompare(board)
        #expect(model.comparing && model.divider == 0.4)
        model.divider = 0.7; model.peeking = true; model.peeking = false
        #expect(model.divider == 0.7)
        model.toggleCompare(board)
        #expect(!model.comparing)
        model.toggleCompare(board); model.selectWidth(700, board: board)
        #expect(!model.comparing && model.width(board) == 700)
        model.widths = [:]
        let added = try screen(model, added: true)
        model.toggleCompare(added)
        #expect(!model.comparing)
        let removed = try screen(model, removed: true)
        #expect(!model.canCompare(removed))
    }
    @Test func drawingKeepsSheetDraftFreezesWidthAndCancelRestoresCrop() throws {
        let (model, _) = try setup(status: 200)
        let board = try screen(model)
        model.crops[model.key(board)] = (1, CGPoint(x: 0, y: 300))
        model.toggleCompare(board); model.startDrawing(board)
        #expect(model.drawing && !model.comparing)
        model.commentOnDrawing(); #expect(!model.pinSheet)
        model.appendStroke([.init(x: 0.5, y: 0.25), .init(x: 0.75, y: 0.5)])
        let draft = try #require(model.draft), drawing = try #require(draft.drawing)
        #expect(draft.x == drawing.anchor.x * 390 && draft.y == drawing.anchor.y * 844)
        model.commentOnDrawing(); model.sheetText = "Keep the name visible."
        #expect(model.pinSheet && model.pins.isEmpty)
        model.pinSheet = false; model.dismissPinSheet()
        #expect(model.sheetText == "Keep the name visible." && model.draft?.drawing?.strokes.count == 1)
        model.selectWidth(700, board: board); model.toggleCompare(board)
        #expect(model.width(board) == 390 && !model.comparing)
        model.undoStroke(); #expect(model.draft?.drawing?.strokes.isEmpty == true)
        model.crops[model.key(board)] = (2, CGPoint(x: 20, y: 500))
        model.cancelDrawing()
        #expect(!model.drawing && model.draft == nil && model.sheetText.isEmpty && model.pins.isEmpty)
        #expect(model.crops[model.key(board)]?.offset == CGPoint(x: 0, y: 300))
    }
    @Test func accessiblePinActionUsesTheVisibleNativeCrop() throws {
        let (model, _) = try setup(status: 200)
        let board = try screen(model)
        model.viewports[model.key(board)] = CGRect(x: 0, y: 300, width: 390, height: 400)
        model.placePin(board)
        #expect(model.pinSheet && model.draft?.x == 195 && model.draft?.y == 500 && model.draft?.drawing == nil)
    }
    @Test func savedDrawingLeavesDrawModeAndCountsAsOnePin() async throws {
        let (model, client) = try setup(status: 200)
        let board = try screen(model)
        model.startDrawing(board); model.appendStroke([.init(x: 0.5, y: 0.25)])
        model.commentOnDrawing(); model.sheetText = "Keep the name visible."
        await model.savePin(client: client)
        #expect(!model.drawing && !model.pinSheet && model.draft == nil)
        #expect(model.pins.count == 1 && model.selectedPin?.number == 1 && model.showChanges)
        #expect(model.pins.first?.drawing?.strokes == [[.init(x: 0.5, y: 0.25)]])
        #expect(V2ReviewModel.primaryAction(try #require(model.review)) == .changes(1))
    }
    @Test func failedDrawingSaveRetainsStrokesAndTextWithoutCountingDraft() async throws {
        let (model, client) = try setup(status: 500)
        let board = try screen(model, removed: true)
        model.startDrawing(board); model.appendStroke([.init(x: 0.5, y: 0.25)])
        #expect(model.draft?.drawing?.side == "before" && model.draft?.revision == "a")
        model.commentOnDrawing(); model.sheetText = "Keep this screen."
        await model.savePin(client: client)
        #expect(model.pinSheet && model.drawing && model.pins.isEmpty)
        #expect(model.draft?.drawing?.strokes.count == 1 && model.sheetText == "Keep this screen.")
        #expect(model.error != nil && !model.saving)
    }
    @Test func menuOnlyNavigatesAndOnlyFinishCanAnswer() async throws {
        let (model, client) = try setup(status: 200)
        model.page = .screen("screen")
        #expect(await model.answer(client: client, action: "changes") == nil)
        #expect(ReviewTransport.state.count() == 0)
        model.finishReview()
        #expect(model.page == .decide)
        #expect(ReviewTransport.state.count() == 0)
        #expect(await model.answer(client: client, action: "changes") == "Changes requested.")
        #expect(ReviewTransport.state.count() == 1)
        #expect(model.review?.item.state == .answered)
    }
    @Test func failedAnswerKeepsReviewAndShowsErrorForRetry() async throws {
        let (model, client) = try setup(status: 500)
        model.finishReview()
        #expect(await model.answer(client: client, action: "changes") == nil)
        #expect(model.page == .decide)
        #expect(model.review?.item.state == .waiting)
        #expect(model.error?.contains("Try again later") == true)
        #expect(model.decisionsReady)
        #expect(ReviewTransport.state.count() == 1)
    }
    @Test func conflictDecisionsWaitOnlyForTheConflictCheck() throws {
        let board = #"{"file":"Agent.html","title":"Agent","w":1440,"h":900,"added":false,"lines":[]}"#
        for stale in [true, false] {
            let model = V2ReviewState()
            model.review = try JSONDecoder().decode(V2DesignReview.self, from: Data("{\"item\":\(waiting),\"branch\":\"b\",\"before\":\"a\",\"after\":\"c\",\"boards\":[\(board)],\"pins\":[],\"stale\":\(stale)}".utf8))
            model.loading = false
            #expect(model.decisionsReady == stale)
        }
    }
}
#endif
