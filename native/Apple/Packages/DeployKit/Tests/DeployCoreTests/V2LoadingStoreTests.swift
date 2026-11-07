import Foundation
import Testing
@testable import DeployCore

private final class LoadingCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 3
    func next() -> Int { lock.lock(); defer { lock.unlock() }; value += 1; return value }
}
private final class LoadingURLProtocol: URLProtocol, @unchecked Sendable {
    static let counter = LoadingCounter()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix("loading.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let body: String
        var status = 200
        switch url.path {
        case "/api/workspace/state": status = 503; body = "{}"
        case "/api/v2/agents": body = #"{"agents":[{"id":"writer","name":"Release notes writer"}]}"#
        case "/api/v2/inbox":
            if url.query?.contains("answered") == true { body = #"{"items":[],"cursor":3}"# }
            else {
                let cursor = url.host == "legacy.loading.invalid" ? "" : ",\"cursor\":\(Self.counter.next())"
                body = #"{"items":[{"id":"waiting","kind":"question","title":"Continue?","text":"Review","from":"writer","createdAt":"2026-11-07T12:00:00Z","state":"waiting","actions":[]}]\#(cursor)}"#
            }
        case "/api/v2/live": body = #"{"summary":{"running":0,"failing":0,"warning":0,"checkedAt":"now"},"computers":[]}"#
        case "/api/v2/projects":
            if url.host == "missing.loading.invalid" { status = 404; body = "{}" }
            else { body = #"{"projects":[{"id":"tally","name":"tally"}]}"# }
        case "/api/nodes": body = #"{"nodes":[{"id":"ser","name":"SER","online":true}]}"#
        case "/api/user": body = #"{"username":"fixture"}"#
        default: status = 404; body = "{}"
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@Suite struct V2LoadingStoreTests {
    @Test @MainActor func workspaceFailureDoesNotDiscardIndependentAgentsLiveProjectsOrComputers() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let connection = Connection(origin: "https://loading.invalid", username: "fixture", token: "fixture")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LoadingURLProtocol.self]
        let store = V2Store(connection: connection, client: V2Client(connection: connection, session: URLSession(configuration: config)), cacheDirectory: directory)
        await store.refresh()
        #expect(store.snapshot.workspace == nil)
        #expect(store.snapshot.agents.first?.name == "Release notes writer")
        #expect(store.snapshot.live != nil)
        #expect(store.snapshot.projects.first?.name == "tally")
        #expect(store.snapshot.computers.first?.name == "SER")
    }
    @Test @MainActor func newerSnapshotRetainsItsRowsAndLegacyPagesStillLoad() async throws {
        for origin in ["https://loading.invalid", "https://legacy.loading.invalid"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let connection = Connection(origin: origin, username: "fixture", token: "fixture")
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [LoadingURLProtocol.self]
            let store = V2Store(connection: connection, client: V2Client(connection: connection, session: URLSession(configuration: config)), cacheDirectory: directory)
            await store.refresh()
            #expect(store.waiting.map(\.id) == ["waiting"])
            await store.refresh()
            #expect(store.waiting.map(\.id) == ["waiting"])
        }
    }

    @Test @MainActor func absentProjectsEndpointCannotTurnFailedWorkspaceIntoEmptySuccess() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let connection = Connection(origin: "https://missing.loading.invalid", username: "fixture", token: "fixture")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LoadingURLProtocol.self]
        let store = V2Store(connection: connection, client: V2Client(connection: connection, session: URLSession(configuration: config)), cacheDirectory: directory)
        await store.refresh()
        #expect(store.loadState("projects").failed)
        #expect(!store.loadState("projects").hasData)
        #expect(!store.snapshot.loadedResources.contains("projects"))
    }

    @Test @MainActor func inMemoryDecisionPreventsSkeletonBeforeItsListResponds() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2Store(connection: Connection(origin: "https://loading.invalid", username: "fixture", token: "fixture"), cacheDirectory: directory)
        let item = InboxItem(id: "memory", kind: .question, title: "Continue?", text: "Review", from: "writer", createdAt: "2026-11-07T12:00:00Z", actions: [], state: .waiting)
        store.apply(V2EventPage(events: [V2Event(cursor: 1, at: "now", type: "inbox", item: item)], cursor: 1, supportsWait: true))
        #expect(store.waiting.count == 1)
        #expect(store.loadState("waiting").hasData)
        #expect(!store.loadState("waiting").showsSkeleton)
    }

    @Test @MainActor func diskCacheRemembersSuccessfulEmptyButNotUnrequestedResources() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let connection = Connection(origin: "https://loading.invalid", username: "fixture", token: "fixture")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LoadingURLProtocol.self]
        let store = V2Store(connection: connection, client: V2Client(connection: connection, session: URLSession(configuration: config)), cacheDirectory: directory)
        try store.persist()
        let neverLoaded = V2Store(connection: connection, cacheDirectory: directory)
        #expect(neverLoaded.loadState("answered").showsSkeleton)
        await store.refreshResources(["answered"])
        #expect(store.answered.isEmpty)
        let restored = V2Store(connection: connection, cacheDirectory: directory)
        #expect(restored.loadState("answered").hasData)
        #expect(!restored.loadState("answered").showsSkeleton)
        #expect(restored.loadState("answered").header() == nil)
        #expect(restored.loadState("projects").showsSkeleton)
    }

}
