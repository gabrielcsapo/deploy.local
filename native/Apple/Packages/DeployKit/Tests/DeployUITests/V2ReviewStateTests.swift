#if os(iOS)
import Testing
import Foundation
import DeployCore
@testable import DeployUI

private final class ReviewTransport: URLProtocol, @unchecked Sendable {
    static let state = State()
    final class State: @unchecked Sendable {
        let lock = NSLock()
        var status = 200
        var posts = 0
        func reset(status: Int) { lock.lock(); defer { lock.unlock() }; self.status = status; posts = 0 }
        func response(post: Bool) -> (Int, String) {
            lock.lock(); defer { lock.unlock() }
            if post { posts += 1 }
            return post ? (status, status == 200 ? "{\"item\":\(answered)}" : #"{"error":"Try again later"}"#) : (200, reviewJSON)
        }
        func count() -> Int { lock.lock(); defer { lock.unlock() }; return posts }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.state.response(post: request.httpMethod == "POST")
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
