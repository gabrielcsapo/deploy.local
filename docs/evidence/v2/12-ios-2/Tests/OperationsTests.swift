import Testing
import Foundation
import CryptoKit
import DeployCore

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
private func body(_ request: URLRequest) -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

private let releaseJSON = #"{"id":"9c3e1fa","projectId":"home-gym","source":{"kind":"ship","ref":"meal"},"startedBy":"gabriel","apps":[{"appId":"web","to":"new"},{"appId":"sync","to":"new"}],"migrations":[],"steps":[{"name":"verify","state":"running"}],"state":"running"}"#
private let rollbackJSON = #"{"id":"rb","projectId":"home-gym","from":"9c3e1fa","to":"81be0d2","reason":"Health failed","approvedBy":"gabriel","steps":[{"name":"activate","state":"running"}]}"#
private let restoreJSON = #"{"id":"copy","backupId":"backup","projectId":"home-gym","state":"ready","createdAt":"2026-10-27T14:00:00Z","addresses":[{"app":"home-gym","url":"http://localhost:1234"}]}"#
private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(type, from: Data(json.utf8)) }
private func session() -> URLSession {
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [V2URLProtocol.self]
    return URLSession(configuration: config)
}
private var certificate: String { try! String(contentsOf: Bundle.module.url(forResource: "ca", withExtension: "pem", subdirectory: "Fixtures")!, encoding: .utf8) }
private var fingerprint: String {
    let base64 = certificate.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "").replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
    return SHA256.hash(data: Data(base64Encoded: base64)!).map { String(format: "%02X", $0) }.joined(separator: ":")
}
private func payload(_ changes: [String: Any] = [:]) throws -> String {
    let base: [String: Any] = ["version": 1, "address": "https://fixture.invalid", "fingerprint": fingerprint, "token": String(repeating: "t", count: 64), "expiresAt": Date().addingTimeInterval(300).timeIntervalSince1970 * 1000]
    return String(decoding: try JSONSerialization.data(withJSONObject: base.merging(changes) { _, new in new }), as: UTF8.self)
}
@Suite(.serialized) struct OperationsTests {
    @Test func releasesShipAndRollbackUseWholeProjectContract() async throws {
        V2URLProtocol.state.reset([
            "GET /api/projects/home-gym/releases": [(200, "{\"releases\":[\(releaseJSON)]}")],
            "GET /api/releases/9c3e1fa": [(200, "{\"release\":\(releaseJSON)}")],
            "POST /api/projects/home-gym/releases": [(202, "{\"release\":\(releaseJSON)}")],
            "GET /api/projects/home-gym/rollbacks": [(200, "{\"rollbacks\":[\(rollbackJSON)]}")],
            "POST /api/projects/home-gym/rollback": [(202, "{\"rollback\":\(rollbackJSON)}")]
        ])
        let api = client()
        #expect(try await api.releases(project: "home-gym").first?.apps.count == 2)
        #expect(try await api.release("9c3e1fa").steps.first?.state == .running)
        #expect(try await api.ship(project: "home-gym", task: "meal", ref: "main").id == "9c3e1fa")
        #expect(try await api.rollbacks(project: "home-gym").first?.id == "rb")
        #expect(try await api.rollback(project: "home-gym", from: "9c3e1fa", to: "81be0d2").to == "81be0d2")
        let requests = V2URLProtocol.state.recorded()
        #expect((body(requests[2])["source"] as? [String: String]) == ["kind": "ship", "ref": "meal"])
        #expect(body(requests[2])["ref"] as? String == "main")
        #expect(body(requests[4])["confirmBackupId"] == nil)
        #expect(requests[4].value(forHTTPHeaderField: "X-Deploy-Token") == "private-token")
    }
    @Test func destructiveReleaseRequestsAreNotRetriedAfterLostResponse() async {
        V2URLProtocol.state.reset(["POST /api/projects/home-gym/releases": [(-1, "")]])
        await #expect(throws: URLError.self) { try await client().ship(project: "home-gym", task: "meal", ref: "main") }
        #expect(V2URLProtocol.state.recorded().count == 1)
    }
    @Test func rollbackDataLossConflictIsNotApprovedAutomatically() async {
        V2URLProtocol.state.reset(["POST /api/projects/home-gym/rollback": [(409, #"{"error":"Review the pre-release backup","dataLoss":{"backupId":"backup"}}"#)]])
        await #expect(throws: ClientError.self) { try await client().rollback(project: "home-gym", from: "a", to: "b") }
        #expect(V2URLProtocol.state.recorded().count == 1)
    }
    @Test @MainActor func typedEventsUpdateReleaseAndRollbackSteps() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2Store(connection: connection, client: client(), cacheDirectory: directory)
        let page = try decode(V2EventPage.self, "{\"cursor\":2,\"events\":[{\"cursor\":1,\"taskId\":\"home-gym\",\"at\":\"now\",\"type\":\"release\",\"release\":\(releaseJSON)},{\"cursor\":2,\"taskId\":\"home-gym\",\"at\":\"now\",\"type\":\"rollback\",\"rollback\":\(rollbackJSON)}]}")
        store.apply(page)
        #expect(store.releases["9c3e1fa"]?.steps.first?.state == .running)
        #expect(store.rollbacks["rb"]?.steps.first?.name == .activate)
        store.apply(page)
        #expect(store.releases.count == 1)
    }
    @Test func restoreCopyMustBeCheckedBeforeSwitchAndCannotCancelAfterSwitch() async throws {
        V2URLProtocol.state.reset([
            "GET /api/backups": [(200, "{\"backups\":[],\"restores\":[\(restoreJSON)],\"schedules\":[]}")],
            "POST /api/backups/backup/restore": [(201, "{\"restore\":\(restoreJSON)}")],
            "POST /api/backups/backup/restore/copy/switch": [(202, "{\"restore\":\(restoreJSON.replacingOccurrences(of: "ready", with: "switching"))}")],
            "POST /api/backups/backup/restore/copy/cancel": [(200, "{\"restore\":\(restoreJSON.replacingOccurrences(of: "ready", with: "cancelled"))}")]
        ])
        let api = client()
        #expect(try await api.backups().restores.count == 1)
        let restore = try await api.restore(backup: "backup")
        #expect(restore.addresses.first?.isCoordinatorOnly == true)
        #expect(V2URLProtocol.state.recorded().count == 2)
        await #expect(throws: ClientError.self) { try await api.switchRestore(restore, checked: false) }
        #expect(V2URLProtocol.state.recorded().count == 2)
        let switched = try await api.switchRestore(restore, checked: true)
        #expect(body(V2URLProtocol.state.recorded()[2])["confirm"] as? Bool == true)
        await #expect(throws: ClientError.self) { try await api.cancelRestore(switched) }
        #expect(V2URLProtocol.state.recorded().count == 3)
        #expect(try await api.cancelRestore(restore).state == "cancelled")
    }
    @Test func pairingRejectsExpiredMalformedAndInsecureQRBeforeSending() throws {
        for change: [String: Any] in [["version": 2], ["expiresAt": 1], ["address": "http://fixture.invalid"], ["address": "https://fixture.invalid/steal"], ["address": "https://user:pass@fixture.invalid"], ["fingerprint": "AA"], ["token": "short"]] {
            #expect(throws: ClientError.self) { try V2PairingPayload.parse(payload(change)) }
        }
        #expect(try V2PairingPayload.parse(payload()).version == 1)
    }
    @Test func pairingExchangeUsesOnlySingleUseTokenAndRetainsPin() async throws {
        let qr = try V2PairingPayload.parse(payload())
        V2URLProtocol.state.reset(["GET /ca.crt": [(200, certificate)], "POST /api/devices/exchange": [(200, "{\"id\":\"phone\",\"username\":\"gabriel\",\"token\":\"device-token\",\"expiresAt\":\(Date().addingTimeInterval(86400).timeIntervalSince1970 * 1000)}")]])
        let device = try await V2PairingClient.exchange(qr, name: "Test iPhone", session: session())
        #expect(device.connection.token == "device-token")
        #expect(device.fingerprint == qr.fingerprint)
        let download = try #require(V2URLProtocol.state.recorded().first)
        #expect(download.value(forHTTPHeaderField: "X-Deploy-Token") == nil)
        let request = V2URLProtocol.state.recorded()[1]
        #expect(body(request)["token"] as? String == qr.token)
        #expect(body(request)["name"] as? String == "Test iPhone")
        #expect(request.value(forHTTPHeaderField: "X-Deploy-Token") == "")
    }
    @Test func pairingDetectsOldCoordinatorAndDoesNotReplayExpiredCode() async throws {
        let qr = try V2PairingPayload.parse(payload())
        for status in [404, 501, 410] {
            V2URLProtocol.state.reset(["GET /ca.crt": [(200, certificate)], "POST /api/devices/exchange": [(status, #"{"error":"Code unavailable"}"#)]])
            await #expect(throws: ClientError.self) { try await V2PairingClient.exchange(qr, name: "iPhone", session: session()) }
            #expect(V2URLProtocol.state.recorded().count == 2)
        }
    }
    @Test func mismatchedDownloadedCertificateNeverReceivesThePairToken() async throws {
        let qr = try V2PairingPayload.parse(payload(["fingerprint": Array(repeating: "AB", count: 32).joined(separator: ":")]))
        V2URLProtocol.state.reset(["GET /ca.crt": [(200, certificate)]])
        await #expect(throws: ClientError.self) { try await V2PairingClient.exchange(qr, name: "iPhone", session: session()) }
        #expect(V2URLProtocol.state.recorded().count == 1)
        #expect(V2URLProtocol.state.recorded().first?.httpMethod == "GET")
        #expect(throws: ClientError.self) { try V2PairingClient.certificateDER(Data("not a certificate".utf8), fingerprint: fingerprint) }
    }
    @Test func fingerprintMustMatchExactly() {
        #expect(V2PinnedCoordinator.matches(certificate: Data("abc".utf8), fingerprint: "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"))
        #expect(!V2PinnedCoordinator.matches(certificate: Data("different".utf8), fingerprint: "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"))
    }
    @Test func answeredUsesOutcomeAndShortDates() throws {
        var item = InboxItem(id: "i", kind: .rollback, title: "Roll back?", text: "", from: "warden", createdAt: "now", actions: [InboxAction(id: "rollback", label: "Roll back", primary: true)], state: .answered, answer: InboxAnswer(actionId: "rollback", by: "gabriel", on: .iphone, at: "now"))
        #expect(V2Labels.outcome(item) == "Approved")
        for action in ["dismiss", "deny", "skip", "not-now"] { item.answer?.actionId = action; #expect(V2Labels.outcome(item) == "Not now") }
        item.answer?.actionId = "answer"; #expect(V2Labels.outcome(item) == "Answered")
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = ISO8601DateFormatter().date(from: "2026-10-27T12:00:00Z")!
        #expect(V2Labels.shortDate("2026-10-27T02:14:00Z", now: now, calendar: calendar) == "2:14")
        #expect(V2Labels.shortDate("2026-10-26T02:14:00Z", now: now, calendar: calendar) == "Yesterday")
        #expect(!V2Labels.shortDate("2026-10-24T02:14:00Z", now: now, calendar: calendar).contains("2026"))
    }
}
