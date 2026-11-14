import Testing
import Foundation
@testable import DeployCore

/// A small coordinator: an empty long poll waits as the real server does, and wakes on a new event.
private final class PacingServer: @unchecked Sendable {
    private let lock = NSLock()
    private var cursor = 0
    private var queued = 0
    private var refreshes = 0
    private var liveReads = 0
    private var computerReads = 0
    private var eventType = "agent"
    private var waits: [Int] = []
    private var tasks = "[]"
    private var parked: (id: UUID, respond: @Sendable (String) -> Void)?
    private let newTask = #"[{"id":"new","title":"New task","status":"ready","revision":0,"workspacePath":"/fixture","baseRevision":"abc","createdAt":"2026-10-27T14:14:00Z","updatedAt":"2026-10-27T14:14:00Z"}]"#

    func reset() { lock.lock(); defer { lock.unlock() }; cursor = 0; queued = 0; refreshes = 0; liveReads = 0; computerReads = 0; eventType = "agent"; waits = []; tasks = "[]"; parked = nil }
    var counts: (refreshes: Int, live: Int, computers: Int, waits: [Int]) { lock.lock(); defer { lock.unlock() }; return (refreshes, liveReads, computerReads, waits) }
    /// Queues events. The server learns of a new task with the last of them, as a real one would.
    func publish(_ count: Int, type: String = "agent") {
        lock.lock(); queued += count; eventType = type
        let waiting = parked; parked = nil
        let body = waiting == nil ? nil : nextEvent()
        lock.unlock()
        if let waiting, let body { waiting.respond(body) }
    }
    func poll(waitMs: Int, respond: @escaping @Sendable (String) -> Void) {
        lock.lock(); defer { lock.unlock() }
        waits.append(waitMs)
        if queued > 0 { let body = nextEvent(); DispatchQueue.global().async { respond(body) }; return }
        let id = UUID()
        parked = (id, respond)
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(waitMs)) { [self] in
            lock.lock()
            let expired = parked?.id == id
            if expired { parked = nil }
            let body = page("")
            lock.unlock()
            if expired { respond(body) }
        }
    }
    private func nextEvent() -> String {
        queued -= 1; cursor += 1
        if queued == 0 { tasks = newTask }
        return page(#"{"cursor":\#(cursor),"taskId":null,"at":"now","type":"\#(eventType)","agentId":"x"}"#)
    }
    private func page(_ events: String) -> String { #"{"events":[\#(events)],"cursor":\#(cursor),"supportsWait":true}"# }
    func body(path: String) -> String {
        lock.lock(); defer { lock.unlock() }
        switch path {
        case "/api/state": refreshes += 1; return #"{"cursor":0,"projects":[],"tasks":\#(tasks),"workers":[]}"#
        case "/api/agents": return #"{"agents":[]}"#
        case "/api/inbox": return #"{"items":[]}"#
        case "/api/live": liveReads += 1; return #"{"summary":{"running":0,"failing":0,"warning":0,"checkedAt":"2026-10-27T14:14:00Z"},"computers":[]}"#
        case "/api/nodes": computerReads += 1; return #"{"nodes":[]}"#
        case "/api/user": return #"{"username":"gabriel"}"#
        default: return "{}"
        }
    }
}
private final class PacingURLProtocol: URLProtocol, @unchecked Sendable {
    static let server = PacingServer()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pacing.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private var stopped = false
    private func deliver(_ body: String) {
        guard !stopped, let url = request.url else { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func startLoading() {
        let url = request.url!
        guard url.path == "/api/activity-events" else { return deliver(Self.server.body(path: url.path)) }
        let waitMs = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "waitMs" }?.value.flatMap(Int.init) ?? 0
        Self.server.poll(waitMs: waitMs) { [self] body in deliver(body) }
    }
    override func stopLoading() { stopped = true }
}

@Suite(.serialized) struct V2RefreshPacingTests {
    private let start = ContinuousClock.now
    private func pacer() -> V2RefreshPacer { V2RefreshPacer(interval: .seconds(2)) }

    @Test func nothingIsDueUntilAPageArrives() {
        var pacer = pacer()
        #expect(!pacer.shouldRefresh(at: start))
        #expect(pacer.waitMs(at: start) == 10_000)
        pacer.pageArrived()
        #expect(pacer.shouldRefresh(at: start))
    }
    @Test func theFirstPageAfterAQuietSpellRefreshesAtOnce() {
        var pacer = pacer()
        pacer.refreshStarted(); pacer.refreshFinished(at: start)
        pacer.pageArrived()
        #expect(pacer.shouldRefresh(at: start + .seconds(2)))
        #expect(pacer.shouldRefresh(at: start + .seconds(10)))
    }
    @Test func aBurstWaitsOutTheIntervalAndTheLongPollShortensToMatch() {
        var pacer = pacer()
        pacer.refreshStarted(); pacer.refreshFinished(at: start)
        #expect(pacer.waitMs(at: start + .milliseconds(200)) == 10_000)
        pacer.pageArrived()
        #expect(!pacer.shouldRefresh(at: start + .milliseconds(200)))
        #expect(pacer.waitMs(at: start + .milliseconds(200)) == 1_800)
        // Rounded up, so a poll that times out lands at or after the moment the refresh is due.
        #expect(pacer.waitMs(at: start + .milliseconds(1_999) + .microseconds(500)) == 1)
        #expect(pacer.waitMs(at: start + .seconds(2)) == 0)
        #expect(pacer.shouldRefresh(at: start + .seconds(2)))
    }
    @Test func theIntervalRunsFromTheEndOfASlowRefresh() {
        var pacer = pacer()
        pacer.pageArrived()
        pacer.refreshStarted()
        // A page during the refresh asks for another, after a full interval from when it ended.
        pacer.pageArrived()
        pacer.refreshFinished(at: start + .seconds(5))
        #expect(!pacer.shouldRefresh(at: start + .seconds(6)))
        #expect(pacer.shouldRefresh(at: start + .seconds(7)))
    }
    @Test func aRefreshAnsweredPendingPagesSoTheNextPollWaitsInFull() {
        var pacer = pacer()
        pacer.pageArrived()
        pacer.refreshStarted(); pacer.refreshFinished(at: start)
        #expect(!pacer.shouldRefresh(at: start + .seconds(5)))
        #expect(pacer.waitMs(at: start + .seconds(5)) == 10_000)
    }

    /// Shorter than the ten-second long poll, so passing proves no page had to time out in full.
    @MainActor private func wait(until condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(condition())
    }
    @Test @MainActor func healthRefreshesLiveAndComputersPromptlyWithoutAFullRefresh() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let server = PacingURLProtocol.server
        server.reset()
        let connection = Connection(origin: "https://pacing.invalid", username: "gabriel", token: "private-token")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PacingURLProtocol.self]
        let store = V2Store(connection: connection, client: V2Client(connection: connection, session: URLSession(configuration: config)), cacheDirectory: directory, refreshInterval: .seconds(1))
        await store.start()
        defer { store.suspend() }
        server.publish(1, type: "health")
        try await wait { server.counts.live == 2 && server.counts.computers == 2 }
        #expect(store.snapshot.cursor == 1)
        #expect(server.counts.refreshes == 1)
    }

    @Test @MainActor func aBurstAppliesEveryEventWithFewRefreshesAndTheLastOneIsNotStranded() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let server = PacingURLProtocol.server
        server.reset()
        let connection = Connection(origin: "https://pacing.invalid", username: "gabriel", token: "private-token")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PacingURLProtocol.self]
        let client = V2Client(connection: connection, session: URLSession(configuration: config))
        let store = V2Store(connection: connection, client: client, cacheDirectory: directory, refreshInterval: .seconds(1))
        await store.start()
        defer { store.suspend() }
        try await wait { server.counts.refreshes == 1 }

        server.publish(40)
        try await wait { store.snapshot.cursor == 40 }
        #expect(server.counts.refreshes <= 3)

        // No further events arrive, so only a refresh after the last one can bring this task in.
        try await wait { store.tasks.contains { $0.id == "new" } }
        #expect(server.counts.refreshes <= 4)
        // Then the loop goes back to waiting in full.
        try await wait { server.counts.waits.last == 10_000 }
    }
}

@Suite struct V2IdleRefreshTests {
    @Test func irrelevantAndEmptyPagesNeverRequestFullRefreshButLiveRemainsFresh() {
        let start = ContinuousClock.now
        var pacer = V2RefreshPacer(interval: .seconds(2))
        pacer.refreshStarted(); pacer.refreshFinished(at: start)
        var full = 0
        var light = 0
        for second in 1...60 {
            let now = start + .seconds(second)
            pacer.pageArrived(relevant: false)
            if pacer.shouldRefresh(at: now) { full += 1; pacer.refreshStarted(); pacer.refreshFinished(at: now) }
            else if pacer.shouldRefreshLive(at: now) { light += 1; pacer.liveRefreshFinished(at: now) }
        }
        #expect(full == 0)
        #expect(light == 4)
    }
    @Test func healthUsesTheLightReadAndNewTasksStillRefreshImmediatelyAfterIdle() {
        let start = ContinuousClock.now
        var pacer = V2RefreshPacer(interval: .seconds(2))
        pacer.refreshStarted(); pacer.refreshFinished(at: start)
        pacer.pageArrived(relevant: false, health: true)
        #expect(!pacer.shouldRefresh(at: start + .seconds(2)))
        #expect(pacer.shouldRefreshLive(at: start + .seconds(2)))
        pacer.liveRefreshFinished(at: start + .seconds(2))
        #expect(pacer.waitMs(at: start + .seconds(12)) == 5_000)
        pacer.pageArrived()
        #expect(pacer.shouldRefresh(at: start + .seconds(12)))
    }
    @Test @MainActor func irrelevantPagesAdvanceInMemoryWithoutRewritingCache() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let connection = Connection(origin: "https://pacing.invalid", username: "gabriel", token: "private-token")
        let store = V2Store(connection: connection, cacheDirectory: directory)
        try store.persist()
        let file = try #require(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let before = try Data(contentsOf: file)
        let date = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        let relevant = store.apply(V2EventPage(events: [V2Event(cursor: 1, at: "now", type: "ignored")], cursor: 1, supportsWait: true))
        store.apply(V2EventPage(events: [], cursor: 1, supportsWait: true))
        #expect(!relevant)
        #expect(store.snapshot.cursor == 1)
        #expect(try Data(contentsOf: file) == before)
        #expect(try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date == date)
    }
}
