import Testing
import Foundation
@testable import DeployCore

private final class V2StubState: @unchecked Sendable {
    let lock = NSLock()
    var responses: [String: [(Int, String)]] = [:]
    var requests: [URLRequest] = []
    func reset(_ responses: [String: [(Int, String)]]) { lock.lock(); defer { lock.unlock() }; self.responses = responses; requests = [] }
    func response(_ request: URLRequest) -> (Int, String) {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
        let key = request.httpMethod! + " " + request.url!.path + (request.url!.query.map { "?" + $0 } ?? "")
        guard var values = responses[key], let first = values.first else { return (404, #"{"error":"Not found"}"#) }
        if values.count > 1 { values.removeFirst(); responses[key] = values }
        return first
    }
    func recorded() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}
private final class V2URLProtocol: URLProtocol, @unchecked Sendable {
    static let state = V2StubState()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.state.response(request)
        if status == -1 { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private let connection = Connection(origin: "https://fixture.invalid", username: "gabriel", token: "private-token")
private func client() -> V2Client {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [V2URLProtocol.self]
    return V2Client(connection: connection, session: URLSession(configuration: config))
}
private let answeredJSON = #"{"id":"rollback:home-gym","kind":"rollback","title":"Roll back home-gym?","text":"38% failing","from":"warden","createdAt":"2026-10-27T14:14:00Z","actions":[{"id":"rollback","label":"Roll back","primary":true}],"state":"answered","answer":{"actionId":"rollback","by":"gabriel","on":"web","at":"2026-10-27T14:15:00Z"}}"#
private let taskJSON = #"{"id":"t","title":"Fix sync","status":"ready","revision":0,"workspacePath":"/fixture","baseRevision":"abc","createdAt":"2026-10-27T14:14:00Z","updatedAt":"2026-10-27T14:14:00Z"}"#
private let runJSON = #"{"id":"r","taskId":"t","adapter":"codex","status":"queued","createdAt":"2026-10-27T14:14:00Z","updatedAt":"2026-10-27T14:14:00Z"}"#
private func routes() -> [String: [(Int, String)]] {
    ["GET /api/workspace/state": [(200, #"{"cursor":0,"projects":[],"tasks":[],"workers":[]}"#)],
     "GET /api/v2/inbox?state=waiting": [(200, #"{"items":[]}"#)],
     "GET /api/v2/inbox?state=answered": [(200, #"{"items":[]}"#)],
     "GET /api/v2/live": [(200, #"{"summary":{"running":0,"failing":0,"warning":0,"checkedAt":"2026-10-27T14:14:00Z"},"computers":[]}"#)],
     "GET /api/nodes": [(200, #"{"nodes":[]}"#)],
     "GET /api/user": [(200, #"{"username":"gabriel"}"#)],
     "POST /api/workspace/tasks": [(200, taskJSON)],
     "POST /api/workspace/tasks/t/messages": [(200, runJSON)]]
}
private func body(_ request: URLRequest) -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

@Suite(.serialized) struct V2Tests {
    @Test func answerUsesIPhoneAndReturnsWinnerAfterConflict() async throws {
        V2URLProtocol.state.reset([
            "POST /api/v2/inbox/rollback:home-gym/answer": [(409, #"{"error":"Already answered"}"#)],
            "GET /api/v2/inbox?state=answered": [(200, "{\"items\":[\(answeredJSON)]}")]
        ])
        let result = try await client().answer("rollback:home-gym", action: "rollback")
        #expect(result.alreadyAnswered)
        #expect(result.item.answer?.on == .web)
        let requests = V2URLProtocol.state.recorded()
        #expect(requests.count == 2)
        #expect(requests[0].value(forHTTPHeaderField: "X-Deploy-Username") == "gabriel")
        #expect(body(requests[0])["on"] as? String == "iphone")
    }
    @Test func notificationActionsAreScopedAndMustStillBeOffered() async throws {
        let waiting = answeredJSON.replacingOccurrences(of: "\"state\":\"answered\"", with: "\"state\":\"waiting\"")
        V2URLProtocol.state.reset([
            "GET /api/v2/inbox?state=waiting": [(200, "{\"items\":[\(waiting)]}")],
            "POST /api/v2/inbox/rollback:home-gym/answer": [(200, "{\"item\":\(answeredJSON)}")]
        ])
        let api = client()
        let scope = V2Client.notificationScope(connection)
        #expect(try await api.handleNotification(scope: "other", itemId: "rollback:home-gym", action: "approve", actionId: "rollback") == nil)
        #expect(V2URLProtocol.state.recorded().isEmpty)
        #expect(try await api.handleNotification(scope: scope, itemId: "rollback:home-gym", action: "approve", actionId: "not-offered") == nil)
        #expect(try await api.handleNotification(scope: scope, itemId: "rollback:home-gym", action: "approve", actionId: "rollback")?.item.state == .answered)
        let other = Connection(origin: "https://other.invalid", username: connection.username, token: connection.token)
        #expect(V2Client.notificationScope(other) != scope)
    }
    @Test func projectsFallbackOnlyForUnavailableEndpoint() async throws {
        let fallback = [V2Project(id: "p", name: "home-gym")]
        V2URLProtocol.state.reset([:])
        #expect(try await client().projects(fallback: fallback) == fallback)
        V2URLProtocol.state.reset(["GET /api/v2/projects": [(401, #"{"error":"Expired"}"#)]])
        await #expect(throws: ClientError.self) { try await client().projects(fallback: fallback) }
        V2URLProtocol.state.reset(["GET /api/v2/projects": [(200, #"{"projects":[{"id":"v2","name":"recipes"}]}"#)]])
        #expect(try await client().projects(fallback: fallback).first?.id == "v2")
        V2URLProtocol.state.reset(["GET /api/v2/projects": [(200, #"[{"id":"v2-array","name":"recipes"}]"#)]])
        #expect(try await client().projects(fallback: fallback).first?.id == "v2-array")
    }
    @Test func pollingEncodesCursorAndWait() async throws {
        V2URLProtocol.state.reset(["GET /api/v2/events?after=42&waitMs=10000": [(200, #"{"events":[],"cursor":43,"supportsWait":true}"#)]])
        #expect(try await client().events(after: 42).cursor == 43)
        #expect(V2Client.segment("a/b?c#d") == "a%2Fb%3Fc%23d")
    }
    @Test @MainActor func offlineDraftSurvivesRelaunchWithoutCredentialsInCache() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        V2URLProtocol.state.reset([:])
        let first = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        var draft = V2Draft(); draft.text = "Fix the sync migration"; draft.model = "this-chat-only"
        #expect(await first.enqueue(draft))
        let next = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        #expect(next.snapshot.drafts == [draft])
        #expect(V2URLProtocol.state.recorded().isEmpty)
        let file = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first!
        #expect(!String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("private-token"))
        let other = V2Store(connection: Connection(origin: connection.origin, username: "other", token: "t"), cacheDirectory: directory)
        #expect(other.snapshot.drafts.isEmpty)
    }
    @Test @MainActor func composerContextSurvivesModeChangesAndCanonicalReauthentication() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2Store(connection: connection, cacheDirectory: directory)
        var draft = V2Draft(); draft.text = "Why is Immich using so much memory?"
        store.saveComposer(draft, context: "new")
        draft.question = true
        store.saveComposer(draft, context: "new")
        var followup = V2Draft(); followup.taskId = "t"; followup.text = "Keep this separate"
        store.saveComposer(followup, context: "t")
        let rotated = Connection(origin: "https://FIXTURE.invalid:443/", username: connection.username, token: "rotated")
        let next = V2Store(connection: rotated, cacheDirectory: directory)
        #expect(next.composer(taskId: nil).question)
        #expect(next.composer(taskId: nil).text == draft.text)
        #expect(next.composer(taskId: "t").text == followup.text)
        #expect(await next.enqueue(draft))
        #expect(next.snapshot.composers["new"] == nil)
        #expect(next.composer(taskId: "t").text == followup.text)
    }
    @Test @MainActor func ambiguousSendReplaysSameOperationAndDoesNotCreateSecondTask() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var responses = routes(); responses["POST /api/workspace/tasks/t/messages"] = [(-1, ""), (200, runJSON)]
        V2URLProtocol.state.reset(responses)
        let first = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        var draft = V2Draft(); draft.text = "Fix sync"
        #expect(await first.enqueue(draft))
        await first.refresh()
        #expect(!first.online)
        #expect(first.snapshot.drafts.first?.taskId == "t")
        first.recoverDraft(draft.id)
        #expect(first.snapshot.drafts.count == 1)
        let next = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        await next.refresh()
        #expect(next.snapshot.drafts.isEmpty)
        let requests = V2URLProtocol.state.recorded()
        #expect(requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/workspace/tasks" }.count == 1)
        let messages = requests.filter { $0.url?.path.hasSuffix("/messages") == true }
        #expect(messages.count == 2)
        #expect(body(messages[0])["operationId"] as? String == draft.id)
        #expect(body(messages[1])["operationId"] as? String == draft.id)
    }
    @Test @MainActor func rejectedDraftWaitsForReviewInsteadOfAutomaticRetry() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var responses = routes(); responses["POST /api/workspace/tasks/t/messages"] = [(409, #"{"error":"Task changed"}"#)]
        V2URLProtocol.state.reset(responses)
        let store = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        var draft = V2Draft(); draft.text = "Fix sync"
        #expect(await store.enqueue(draft))
        await store.refresh(); await store.refresh()
        #expect(store.snapshot.drafts.first?.rejected == true)
        #expect(V2URLProtocol.state.recorded().filter { $0.url?.path.hasSuffix("/messages") == true }.count == 1)
        store.recoverDraft(draft.id)
        #expect(store.snapshot.composer.text == draft.text)
        #expect(store.snapshot.composer.id != draft.id)
    }
    @Test @MainActor func eventsReplaceUpdatedWorkLogsAndKeepAnsweredDecision() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2Store(connection: connection, cacheDirectory: directory)
        let item = try JSONDecoder().decode(InboxItem.self, from: Data(answeredJSON.utf8))
        let work = ConversationEvent.worklog(WorkLogEvent(id: "work", at: "now", summary: "Read files", steps: [], live: true))
        store.apply(V2EventPage(events: [V2Event(cursor: 1, taskId: "t", at: "now", type: "conversation", event: work)], cursor: 1, supportsWait: true))
        let done = ConversationEvent.worklog(WorkLogEvent(id: "work", at: "now", summary: "Read files", steps: [], live: false))
        let page = V2EventPage(events: [V2Event(cursor: 2, taskId: "t", at: "now", type: "conversation", event: done), V2Event(cursor: 3, taskId: "t", at: "now", type: "inbox", item: item)], cursor: 3, supportsWait: true)
        store.apply(page); store.apply(page)
        #expect(store.conversation("t") == [done])
        #expect(store.answered == [item])
        #expect(store.snapshot.cursor == 3)
    }
    @Test @MainActor func unauthorizedStopsRefreshAndKeepsSavedDraft() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var responses = routes(); responses["GET /api/workspace/state"] = [(401, #"{"error":"Expired"}"#)]
        V2URLProtocol.state.reset(responses)
        let store = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        var draft = V2Draft(); draft.text = "Still here"; store.saveComposer(draft)
        await store.refresh()
        #expect(store.needsAuthentication)
        #expect(!store.online)
        #expect(store.snapshot.composer.text == "Still here")
    }
    @Test func phonePreferencesAndRevocationUseTypedOwnerEndpoints() async throws {
        let preferences = #"{"decisions":true,"failingApps":false,"quietHours":true,"timeZone":"America/New_York"}"#
        V2URLProtocol.state.reset([
            "GET /api/v2/notifications": [(200, preferences)],
            "PATCH /api/v2/notifications": [(200, preferences)],
            "PATCH /api/v2/agents/warden/control": [(200, #"{"paused":true,"mutedUntil":null}"#)],
            "GET /api/v2/devices": [(200, #"{"devices":[{"id":"phone","name":"iPhone","createdAt":"2026-10-28T00:00:00Z"}]}"#)],
            "DELETE /api/v2/devices/phone": [(200, #"{"removed":true}"#)]
        ])
        let api = client()
        let settings = try await api.notificationPreferences()
        #expect(settings.quietHours)
        #expect(try await api.saveNotificationPreferences(settings) == settings)
        #expect(try await api.changeAgentControl("warden", paused: true, muteMinutes: 60).paused)
        #expect(try await api.pairedDevices().first?.name == "iPhone")
        try await api.revokeDevice("phone")
        let requests = V2URLProtocol.state.recorded()
        #expect(body(requests[1])["timeZone"] as? String == "America/New_York")
        #expect(body(requests[2])["muteMinutes"] as? Int == 60)
        #expect(requests.last?.httpMethod == "DELETE")
    }

    @Test func designReviewsNameTheirProjectAndTheDesignRowSaysWhatWaits() {
        #expect(V2DesignReview.project(of: "design:67d679c5:design~welcome-edits:0a1b2c3d4e5f") == "67d679c5")
        #expect(V2DesignReview.project(of: "release:abc") == nil)
        #expect(V2DesignReview.project(of: "design:x") == nil)
        #expect(V2DesignSummary(boards: 168, waiting: 1).subtitle == "1 to review · 168 boards")
        #expect(V2DesignSummary(boards: 1, waiting: 0).subtitle == "1 board")
    }

}
