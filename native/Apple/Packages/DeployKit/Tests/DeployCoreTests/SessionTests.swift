import Testing
import Foundation
@testable import DeployCore

@Test @MainActor func expiredSessionPreservesConnectionAndDraft() {
    let connection = Connection(origin: "https://home.local", username: "pilot", token: "test-only")
    let store = WorkspaceStore(connection: connection)
    store.draft = "Keep this unsent work"
    store.recordConnectionFailure(URLError(.notConnectedToInternet))
    #expect(!store.isConnected)
    #expect(!store.needsAuthentication)
    #expect(store.connection == connection)
    store.recordConnectionFailure(ClientError.response(401, "Unauthorized"))
    #expect(store.needsAuthentication)
    #expect(store.connection == connection)
    #expect(store.draft == "Keep this unsent work")
    #expect(store.error?.contains("Sign in again") == true)
}

@Test(arguments: ["https://other.local/api/state", "http://deploy.local/api/state", "https://deploy.local:8443/api/state"])
func credentialsCannotFollowRedirects(destination: String) async throws {
    let session = URLSession(configuration: .ephemeral)
    let origin = URL(string: "https://deploy.local/api/state")!
    var request = URLRequest(url: origin)
    request.setValue("test-only-token", forHTTPHeaderField: "X-Deploy-Token")
    let task = session.dataTask(with: request)
    let response = HTTPURLResponse(url: origin, statusCode: 302, httpVersion: nil, headerFields: nil)!
    await confirmation { confirmed in
        OriginRedirectGuard().urlSession(session, task: task, willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: destination)!)) { redirected in
                #expect(redirected == nil)
                confirmed()
            }
    }
    session.invalidateAndCancel()
}

@Test func restrictCoordinatorOrigins() throws {
    #expect(throws: ClientError.self) { try Connection(origin: "http://home.local", username: "u", token: "t").baseURL() }
    #expect(throws: ClientError.self) { try Connection(origin: "https://user:secret@home.local", username: "u", token: "t").baseURL() }
    #expect(throws: ClientError.self) { try Connection(origin: "https://home.local/other", username: "u", token: "t").baseURL() }
    #expect(try Connection(origin: "http://127.0.0.1:17843", username: "u", token: "t").baseURL().port == 17843)
    #expect(try Connection(origin: "https://deploy.local", username: "u", token: "t").baseURL().host == "deploy.local")
}

@Test func replayKeepsUniqueOrderedEvents() throws {
    func event(_ cursor: Int) throws -> WorkspaceEvent {
        let source = """
        {"cursor":\(cursor),"taskId":"t","runId":null,"type":"message","payload":{"text":"hello"},"createdAt":"2026-10-14T12:00:00Z"}
        """
        return try JSONDecoder().decode(WorkspaceEvent.self, from: Data(source.utf8))
    }
    var journal = EventJournal()
    journal.append(try [event(3), event(1), event(3)])
    journal.append(try [event(2), event(3), event(4)])
    #expect(journal.events.map(\.cursor) == [1, 2, 3, 4])
    #expect(journal.cursor == 4)
    #expect(journal.events.first?.payload.displayText == "hello")
}

@Test(arguments: ["null", "\"project-one\""])
func tasksDecodeWithOptionalProject(projectJSON: String) throws {
    let data = Data("""
    {"id":"t","projectId":\(projectJSON),"title":"Plan work","status":"ready","revision":0,"workspacePath":"/scratch/t","baseRevision":"abc","createdAt":"2026-10-14T12:00:00Z","updatedAt":"2026-10-14T12:00:00Z"}
    """.utf8)
    let task = try JSONDecoder().decode(WorkspaceTask.self, from: data)
    #expect(task.projectId == (projectJSON == "null" ? nil : "project-one"))
}

@Test func workerUsageDecodesAlongsideOlderWorkers() throws {
    let base = #"{"id":"local","name":"Mac","platform":"darwin","architecture":"arm64","status":"online","capabilities":[]}"#
    let oldWorker = try JSONDecoder().decode(Worker.self, from: Data(base.utf8))
    #expect(oldWorker.providers == nil)
    let source = String(base.dropLast()) + #", "providers":[{"id":"codex","name":"Codex","status":"signed-in","checkedAt":1792036958.5,"windows":[{"id":"weekly","label":"Weekly","usedPercent":0,"resetsAt":null}]},{"id":"claude","name":"Claude","status":"signed-out","windows":[]}]}"#
    let worker = try JSONDecoder().decode(Worker.self, from: Data(source.utf8))
    #expect(worker.providers?.first?.windows.first?.usedPercent == 0)
    #expect(worker.providers?.first?.windows.first?.resetsAt == nil)
    #expect(worker.providers?.last?.status == "signed-out")
}

@Test(arguments: ["null", "\"local\""])
func jobsDecodeBeforeAndAfterWorkerAssignment(workerJSON: String) throws {
    let data = Data("""
    {"id":"job","workerId":\(workerJSON),"command":"make test","status":"queued","digest":"abc","output":"","truncated":false,"waitingReason":"Waiting for an eligible worker"}
    """.utf8)
    let job = try JSONDecoder().decode(WorkspaceJob.self, from: data)
    #expect(job.workerId == (workerJSON == "null" ? nil : "local"))
    #expect(job.waitingReason == "Waiting for an eligible worker")
    #expect(job.isActive)
}
