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
private let agentId = "d5eb96ea-63bb-43df-91fb-63dc741ac621"
private let agentJSON = #"{"id":"d5eb96ea-63bb-43df-91fb-63dc741ac621","name":"Release notes writer","job":"Summarize what was merged…","projectId":"p","schedule":{"enabled":false,"time":"08:00","futureOption":true},"triggers":{"mention":true,"disk":false},"apps":[],"computers":[],"createdBy":"gabriel","futureField":{"nested":true}}"#
private func routes() -> [String: [(Int, String)]] {
    ["GET /api/workspace/state": [(200, #"{"cursor":0,"projects":[],"tasks":[],"workers":[]}"#)],
     "GET /api/v2/agents": [(200, #"{"agents":[]}"#)],
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
    @Test func agentDraftPostsOnlyTheDescriptionAndDecodesTheEnvelope() async throws {
        V2URLProtocol.state.reset(["POST /api/v2/agents/draft": [(200, #"{"draft":{"name":"Notes","job":"Summarize changes.\nAsk before publishing.","computers":["SER"],"apps":[],"futureField":true}}"#)]])
        let draft = try await client().draftAgent(job: "Write release notes for home-gym")
        #expect(draft.name == "Notes")
        #expect(draft.job == "Summarize changes.\nAsk before publishing.")
        #expect(draft.computers == ["SER"])
        let request = try #require(V2URLProtocol.state.recorded().first)
        #expect(Set(body(request).keys) == ["job"])
        #expect(body(request)["job"] as? String == "Write release notes for home-gym")
    }

    @Test func createAgentSendsOnlyEditableFieldsAndDecodes201() async throws {
        V2URLProtocol.state.reset(["POST /api/v2/agents": [(201, #"{"agent":\#(agentJSON)}"#)]])
        let api = client()
        for enabled in [false, true] {
            let values = V2NewAgent(name: "Edited name", job: "Edited instructions\nAsk first", projectId: "p", schedule: .init(enabled: enabled, time: "19:30"))
            let agent = try await api.createAgent(values)
            #expect(agent.id == agentId && agent.projectId == "p")
            #expect(agent.schedule?.enabled == false)
            let request = try #require(V2URLProtocol.state.recorded().last)
            let json = body(request)
            #expect(Set(json.keys) == ["name", "job", "projectId", "schedule"])
            #expect(json["name"] as? String == values.name && json["job"] as? String == values.job)
            #expect(json["projectId"] as? String == "p")
            let schedule = try #require(json["schedule"] as? [String: Any])
            #expect(Set(schedule.keys) == ["enabled", "time"])
            #expect(schedule["enabled"] as? Bool == enabled && schedule["time"] as? String == "19:30")
        }
        _ = try await api.createAgent(.init(name: "No project", job: "Check things", schedule: .init(enabled: false, time: "08:00")))
        let request = try #require(V2URLProtocol.state.recorded().last)
        #expect(Set(body(request).keys) == ["name", "job", "schedule"])
    }

    @Test func draftAndCreateErrorsPropagateAndDraftCanBeRetried() async throws {
        V2URLProtocol.state.reset([
            "POST /api/v2/agents/draft": [(502, #"{"error":"The model returned an invalid agent draft."}"#), (200, #"{"draft":{"name":"Notes","job":"Write notes","computers":[]}}"#)],
            "POST /api/v2/agents": [(400, #"{"error":"Invalid project"}"#)]
        ])
        let api = client()
        await #expect(throws: ClientError.self) { try await api.draftAgent(job: "Write notes") }
        #expect(try await api.draftAgent(job: "Write notes").name == "Notes")
        await #expect(throws: ClientError.self) {
            try await api.createAgent(.init(name: "Notes", job: "Write notes", schedule: .init(enabled: false, time: "08:00")))
        }
        #expect(V2URLProtocol.state.recorded().count == 3)
    }

    @Test func malformedDraftsAndCreationResponsesAreRejected() async throws {
        V2URLProtocol.state.reset([
            "POST /api/v2/agents/draft": [(200, #"{"draft":{"name":"Notes","computers":[]}}"#)],
            "POST /api/v2/agents": [(201, #"{"agent":{"name":"Notes"}}"#)]
        ])
        await #expect(throws: DecodingError.self) { try await client().draftAgent(job: "Write notes") }
        await #expect(throws: DecodingError.self) {
            try await client().createAgent(.init(name: "Notes", job: "Write notes", schedule: .init(enabled: false, time: "08:00")))
        }
    }

    @Test @MainActor func creationRefreshesAgentsAndKeepsTheCreatedAgentIfRefreshFails() async throws {
        for status in [200, 503] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            V2URLProtocol.state.reset([
                "POST /api/v2/agents": [(201, #"{"agent":\#(agentJSON)}"#)],
                "GET /api/v2/agents": [(status, status == 200 ? #"{"agents":[{"id":"other","name":"Other"},\#(agentJSON)]}"# : #"{"error":"Unavailable"}"#)]
            ])
            let store = V2Store(connection: connection, client: client(), cacheDirectory: directory)
            let created = try await store.createAgent(.init(name: "Notes", job: "Write notes", schedule: .init(enabled: false, time: "08:00")))
            #expect(created.id == agentId)
            #expect(store.snapshot.agents.filter { $0.id == agentId }.count == 1)
            #expect(store.agentName(created.id) == "Release notes writer")
            #expect(store.snapshot.agents.count == (status == 200 ? 2 : 1))
            let restored = V2Store(connection: connection, client: client(), cacheDirectory: directory)
            #expect(restored.snapshot.agents == store.snapshot.agents)
            #expect(V2URLProtocol.state.recorded().map { "\($0.httpMethod!) \($0.url!.path)" } == ["POST /api/v2/agents", "GET /api/v2/agents"])
        }
    }

    @Test func agentsDecodeCoordinatorResponseAndOptionalFields() async throws {
        V2URLProtocol.state.reset(["GET /api/v2/agents": [(200, #"{"agents":[\#(agentJSON),{"id":"minimal","name":"Minimal"},{"id":"nullable","name":"Nullable","job":null,"projectId":null,"schedule":null}],"futureField":true}"#)]])
        let agents = try await client().agents()
        #expect(agents.map(\.id) == [agentId, "minimal", "nullable"])
        #expect(agents[0].name == "Release notes writer")
        #expect(agents[0].job == "Summarize what was merged…")
        #expect(agents[0].projectId == "p")
        #expect(agents[0].schedule?.enabled == false)
        #expect(agents[0].schedule?.time == "08:00")
        #expect(agents[1].job == nil && agents[1].projectId == nil && agents[1].schedule == nil)
        #expect(agents[2].schedule == nil)
    }

    @Test func agentScheduleUsesWebWordingAndToleratesMissingDetails() throws {
        for (schedule, expected) in [
            (#"null"#, "Only when you press Run now"),
            (#"{}"#, "Only when you press Run now"),
            (#"{"enabled":false,"time":"08:00"}"#, "Only when you press Run now"),
            (#"{"enabled":true,"time":"08:00"}"#, "Every morning at 08:00"),
            (#"{"enabled":true,"time":"19:30"}"#, "Every morning at 19:30"),
            (#"{"enabled":true}"#, "Every morning"),
            (#"{"enabled":true,"time":null}"#, "Every morning")
        ] {
            let json = #"{"id":"a","name":"Agent","schedule":\#(schedule)}"#
            let agent = try JSONDecoder().decode(V2Agent.self, from: Data(json.utf8))
            #expect(agent.scheduleDescription == expected)
        }
    }

    @Test func agentControlsUseTheCoordinatorId() async throws {
        let path = "/api/v2/agents/\(agentId)/control"
        V2URLProtocol.state.reset([
            "GET " + path: [(200, #"{"paused":false,"mutedUntil":null}"#)],
            "PATCH " + path: [(200, #"{"paused":true,"mutedUntil":null}"#)]
        ])
        let api = client()
        #expect(try await api.agentControl(agentId).paused == false)
        #expect(try await api.changeAgentControl(agentId, paused: true, muteMinutes: 60).paused)
        let requests = V2URLProtocol.state.recorded()
        #expect(requests.map { $0.url?.path } == [path, path])
        #expect(body(requests[1])["paused"] as? Bool == true)
        #expect(body(requests[1])["muteMinutes"] as? Int == 60)
    }

    @Test @MainActor func agentsPersistAndRefreshFailuresKeepLastListWithoutFailingRefresh() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var responses = routes()
        responses["GET /api/v2/agents"] = [
            (200, #"{"agents":[\#(agentJSON)]}"#),
            (503, #"{"error":"Unavailable"}"#),
            (200, #"{"agents":[{"id":"missing-name"}]}"#),
            (401, #"{"error":"Unavailable"}"#),
            (-1, ""),
            (200, #"{"agents":[]}"#)
        ]
        V2URLProtocol.state.reset(responses)
        let store = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        await store.refresh()
        #expect(store.snapshot.agents.map(\.id) == [agentId])
        #expect(store.agentName(agentId) == "Release notes writer")
        #expect(store.agentName("scout") == "An agent")
        let restored = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        #expect(restored.snapshot.agents == store.snapshot.agents)
        for _ in 0..<4 {
            await restored.refresh()
            #expect(restored.online && !restored.needsAuthentication && restored.error == nil)
            #expect(restored.snapshot.agents == store.snapshot.agents)
        }
        await restored.refresh()
        #expect(restored.online && restored.snapshot.agents.isEmpty)
    }

    @Test func snapshotsWithoutAgentsKeepSavedDrafts() throws {
        var snapshot = V2Snapshot()
        var draft = V2Draft(); draft.text = "Keep my draft"
        snapshot.drafts = [draft]; snapshot.composer = draft; snapshot.composers["new"] = draft
        var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        json.removeValue(forKey: "agents")
        let restored = try JSONDecoder().decode(V2Snapshot.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(restored.agents.isEmpty)
        #expect(restored.drafts == [draft] && restored.composer == draft && restored.composers["new"] == draft)
    }

    @Test @MainActor func agentDraftUsesRealNameAndId() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var responses = routes()
        responses["GET /api/v2/agents"] = [(200, #"{"agents":[\#(agentJSON)]}"#)]
        V2URLProtocol.state.reset(responses)
        let store = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        var draft = V2Draft(); draft.agent = agentId; draft.question = true; draft.text = "What merged?"
        #expect(await store.enqueue(draft))
        await store.refresh()
        let request = try #require(V2URLProtocol.state.recorded().first { $0.httpMethod == "POST" && $0.url?.path == "/api/workspace/tasks" })
        #expect(body(request)["title"] as? String == "Ask Release notes writer")
        #expect(store.snapshot.agentTasks[agentId] == "t")
    }

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
    @Test func eventPagesDecodeEventsWithoutATask() throws {
        // A background job's work log has no task; one such event must not fail the whole page.
        let json = #"{"events":[{"cursor":131,"taskId":null,"runId":null,"at":"2026-10-17T04:54:44.526Z","type":"job"},{"cursor":132,"taskId":"t","at":"now","type":"job"}],"cursor":132,"supportsWait":true}"#
        let page = try JSONDecoder().decode(V2EventPage.self, from: Data(json.utf8))
        #expect(page.events.map(\.taskId) == [nil, "t"])
        #expect(page.cursor == 132)
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
            "PATCH /api/v2/agents/\(agentId)/control": [(200, #"{"paused":true,"mutedUntil":null}"#)],
            "GET /api/v2/devices": [(200, #"{"devices":[{"id":"phone","name":"iPhone","createdAt":"2026-10-28T00:00:00Z"}]}"#)],
            "DELETE /api/v2/devices/phone": [(200, #"{"removed":true}"#)]
        ])
        let api = client()
        let settings = try await api.notificationPreferences()
        #expect(settings.quietHours)
        #expect(try await api.saveNotificationPreferences(settings) == settings)
        #expect(try await api.changeAgentControl(agentId, paused: true, muteMinutes: 60).paused)
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

    @Test func aDesignReviewCarriesItsRewrittenNotesAndOlderCoordinatorsSendNone() throws {
        let note = #"{"id":"design-draw-how","title":"Drawing: how it works","page":"Design canvas","before":[{"text":"Pen (P): click points","gone":true}],"after":[{"text":"Pen (P): a stroke inks a mark","added":true}],"changed":1,"total":1}"#
        let review = #"{"item":\#(answeredJSON),"task":null,"branch":"design/drawing-note","before":"a","after":"b","boards":[],"notes":[\#(note)]}"#
        let decoded = try JSONDecoder().decode(V2DesignReview.self, from: Data(review.utf8))
        #expect(decoded.changedNotes.first?.title == "Drawing: how it works")
        #expect(decoded.changedNotes.first?.after?.first?.marked == true)
        #expect(decoded.changedNotes.first?.before?.first?.marked == true)
        let older = review.replacingOccurrences(of: #","notes":[\#(note)]"#, with: "")
        #expect(try JSONDecoder().decode(V2DesignReview.self, from: Data(older.utf8)).changedNotes.isEmpty)
    }

    @Test func comparisonMovesLeftToRevealAfterAndClampsAtTheEdges() {
        #expect(V2DesignComparison.after(at: 0, width: 192) == 100)
        #expect(V2DesignComparison.after(at: 96, width: 192) == 50)
        #expect(V2DesignComparison.after(at: 192, width: 192) == 0)
        #expect(V2DesignComparison.after(at: -20, width: 192) == 100)
        #expect(V2DesignComparison.after(at: 220, width: 192) == 0)
        #expect(V2DesignComparison.after(at: 0, width: 0) == 50)
        #expect(V2DesignComparison.percent(101) == 100)
        #expect(V2DesignComparison.percent(-1) == 0)
    }

    @Test func removedBoardFlagIsCompatibleWithOlderCoordinators() throws {
        let board = #"{"file":"Phone.html","title":"Phone","w":390,"h":844,"added":false,"lines":[]}"#
        let older = try JSONDecoder().decode(V2DesignReview.Board.self, from: Data(board.utf8))
        #expect(!older.isRemoved)
        let removed = board.replacingOccurrences(of: #""added":false"#, with: #""added":false,"removed":true"#)
        #expect(try JSONDecoder().decode(V2DesignReview.Board.self, from: Data(removed.utf8)).isRemoved)
    }

}
