import Foundation
import Observation

@Observable @MainActor
public final class WorkspaceStore {
    public private(set) var connection: Connection?
    public private(set) var state: WorkspaceState?
    public private(set) var detail: TaskDetail?
    public private(set) var diff: TaskDiff?
    /// The pull request that links the selected task, newest open one first.
    public private(set) var linkedPull: ProjectWorkItem?
    /// Pull requests and issues of the selected task's project, to resolve `#3` mentions in conversation.
    public private(set) var projectPulls: [ProjectWorkItem] = []
    public private(set) var projectIssues: [ProjectWorkItem] = []
    public var selectedTaskId: String?
    public var error: String?
    public var busy = false
    public var isConnected = false
    public private(set) var needsAuthentication = false
    public var effort = ""
    public var model = ""
    public var adapter = "codex"
    public var draft = ""
    public var checkCommand = "git diff --check"
    public private(set) var lastUpdated: Date?
    private var client: WorkspaceClient?
    private var polling: Task<Void, Never>?
    private var lifecycleGeneration = 0
    private var connectionError: String?
    private let sendJournal = SendJournal()
    private var drafts: [String: String] = [:]

    public init(connection: Connection? = CredentialVault.load()) {
        self.connection = connection
        if let connection { client = WorkspaceClient(connection: connection) }
        drafts = UserDefaults.standard.dictionary(forKey: "deploy.workspace.drafts") as? [String: String] ?? [:]
    }

    private var selectionKey: String? {
        connection.map { "deploy.workspace.selected.\($0.origin)|\($0.username)" }
    }
    public var projects: [Project] { state?.projects ?? [] }
    public var tasks: [WorkspaceTask] { state?.tasks ?? [] }
    public var currentTask: WorkspaceTask? { detail?.task.id == selectedTaskId ? detail?.task : tasks.first { $0.id == selectedTaskId } }
    public var activeRun: Run? { detail?.runs.last(where: \.isActive) }
    public var isWorking: Bool { activeRun != nil || currentTask?.status == "checking" }
    public var selectedProject: Project? { projects.first { $0.id == currentTask?.projectId } }

    public func controlState(taskId: String) async throws -> ControlState {
        guard let client else { throw URLError(.userAuthenticationRequired) }
        return try await client.request("/api/workspace/tasks/\(taskId)/controls")
    }
    public func controlSnapshot(taskId: String, sessionId: String) async throws -> ControlSnapshot? {
        guard let client else { throw URLError(.userAuthenticationRequired) }
        return try await client.request("/api/workspace/tasks/\(taskId)/controls/\(sessionId)")
    }
    public func controlCommand(taskId: String, action: String, body: [String: JSONValue]) async throws -> JSONValue {
        guard let client else { throw URLError(.userAuthenticationRequired) }
        return try await client.request("/api/workspace/tasks/\(taskId)/controls/\(action)", method: "POST", body: JSONEncoder().encode(body))
    }

    public func start() async {
        guard client != nil, !needsAuthentication else { return }
        lifecycleGeneration += 1
        let generation = lifecycleGeneration
        polling?.cancel()
        await refresh()
        if generation == lifecycleGeneration, !needsAuthentication, !Task.isCancelled { beginPolling() }
    }

    public func login(origin: String, username: String, password: String) async {
        busy = true
        defer { busy = false }
        do {
            let result = try await WorkspaceClient.login(origin: origin, username: username, password: password)
            _ = try result.baseURL()
            suspend()
            state = nil; detail = nil; diff = nil; selectedTaskId = nil; draft = ""
            connection = result
            needsAuthentication = false
            client = WorkspaceClient(connection: result)
            error = nil
            saveLogin(result)
            await start()
        } catch { self.error = coordinatorErrorDescription(error) }
    }

    private var loginSaveFailure: (message: String, retryable: Bool)?
    /// The Keychain refused the login and retrying could help (not for unsigned builds).
    public var canRetrySavingLogin: Bool {
        guard let loginSaveFailure else { return false }
        return loginSaveFailure.retryable && error == loginSaveFailure.message
    }

    private func saveLogin(_ connection: Connection) {
        do {
            try CredentialVault.save(connection)
            loginSaveFailure = nil
        } catch {
            let failure = CredentialVault.saveFailure(error)
            loginSaveFailure = failure
            self.error = failure.message
        }
    }

    public func retrySavingLogin() {
        guard let connection else { return }
        error = nil
        saveLogin(connection)
    }

    public func disconnect() {
        suspend()
        CredentialVault.clear()
        connection = nil; client = nil; state = nil; detail = nil; diff = nil
        selectedTaskId = nil; isConnected = false
        needsAuthentication = false
    }

    public func saveDraft() {
        if let selectedTaskId { drafts[selectedTaskId] = draft }
        UserDefaults.standard.set(drafts, forKey: "deploy.workspace.drafts")
    }

    public func select(_ id: String?) async {
        saveDraft()
        selectedTaskId = id
        if let key = selectionKey { UserDefaults.standard.set(id, forKey: key) }
        draft = id.flatMap { drafts[$0] } ?? ""
        detail = nil; diff = nil; linkedPull = nil; projectPulls = []; projectIssues = []
        await refreshDetail()
    }

    public func refresh() async {
        guard let client else { return }
        do {
            let next: WorkspaceState = try await client.request("/api/workspace/state")
            guard client === self.client else { return }
            if state != next { state = next }
            isConnected = true
            if error == connectionError { error = nil }
            connectionError = nil
            lastUpdated = Date()
            if selectedTaskId == nil || !next.tasks.contains(where: { $0.id == selectedTaskId }) {
                let saved = selectionKey.flatMap { UserDefaults.standard.string(forKey: $0) }
                await select(next.tasks.first(where: { $0.id == saved })?.id ?? next.tasks.first?.id)
            } else { await refreshDetail() }
        } catch {
            guard client === self.client, !Task.isCancelled else { return }
            recordConnectionFailure(error)
        }
    }

    public func refreshDetail() async {
        guard let client, let id = selectedTaskId else { return }
        do {
            let next: TaskDetail = try await client.request("/api/workspace/tasks/\(id)")
            guard client === self.client, selectedTaskId == id else { return }
            if detail == nil, let last = next.runs.last {
                adapter = last.adapter; model = last.model ?? ""; effort = last.effort ?? ""
            }
            let changedStatus = detail?.task.status != next.task.status
            if detail != next { detail = next }
            if changedStatus { await loadDiff() }
        } catch {
            guard client === self.client, id == selectedTaskId, !Task.isCancelled else { return }
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = coordinatorErrorDescription(error) }
        }
    }

    public func loadDiff() async {
        guard let client, let id = selectedTaskId else { return }
        do {
            let result: TaskDiff = try await client.request("/api/workspace/tasks/\(id)/diff")
            guard client === self.client, id == selectedTaskId else { return }
            diff = result
            await loadLinkedPull()
        } catch {
            guard client === self.client, id == selectedTaskId, !Task.isCancelled else { return }
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = coordinatorErrorDescription(error) }
        }
    }

    public func loadLinkedPull() async {
        guard let client, let id = selectedTaskId, let projectId = currentTask?.projectId else { linkedPull = nil; return }
        // Linking is recorded on the pull request; older coordinators simply return no match.
        guard let response: ProjectWorkResponse = try? await client.request("/api/workspace/projects/\(projectId)/pulls"),
              client === self.client, id == selectedTaskId else { return }
        let pulls = response.items ?? []
        let linked = pulls.filter { $0.taskIds?.contains(id) == true }
        let next = linked.first { $0.status == "open" } ?? linked.first
        if next != linkedPull { linkedPull = next }
        if pulls != projectPulls { projectPulls = pulls }
        if let issues: ProjectWorkResponse = try? await client.request("/api/workspace/projects/\(projectId)/issues"),
           client === self.client, id == selectedTaskId, (issues.items ?? []) != projectIssues {
            projectIssues = issues.items ?? []
        }
    }

    public func createProject(name: String, source: String) async -> Bool {
        guard let client else { return false }
        busy = true
        defer { busy = false }
        do {
            var body = ["operationId": UUID().uuidString, "name": name]
            if !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["sourcePath"] = source }
            let _: Project = try await client.request("/api/workspace/projects", method: "POST", body: JSONEncoder().encode(body))
            await refresh()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    public func createTask(projectId: String? = nil, title: String, workerId: String = "local") async -> Bool {
        guard let client else { return false }
        busy = true
        defer { busy = false }
        do {
            var body = ["operationId": UUID().uuidString, "title": title, "workerId": workerId]
            if let projectId, !projectId.isEmpty { body["projectId"] = projectId }
            let task: WorkspaceTask = try await client.request("/api/workspace/tasks", method: "POST", body: JSONEncoder().encode(body))
            await refresh()
            await select(task.id)
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    public func send() async {
        guard let client, let task = currentTask, !isWorking, !busy, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let content = draft
        let body: SendBody
        do {
            body = try sendJournal.prepare(connection: client.connection, taskId: task.id,
                proposed: SendBody(operationId: UUID().uuidString, revision: task.revision, content: content,
                                   model: model.isEmpty ? nil : model, effort: effort.isEmpty ? nil : effort, adapter: adapter))
        } catch {
            self.error = "Message was not sent because its retry record could not be saved: \(error.localizedDescription)"
            return
        }
        busy = true
        defer { busy = false }
        do {
            let _: Run = try await client.request("/api/workspace/tasks/\(task.id)/messages", method: "POST", body: JSONEncoder().encode(body))
            try sendJournal.acknowledge(connection: client.connection, operationId: body.operationId)
            guard client === self.client else { return }
            if selectedTaskId == task.id && draft == content { draft = ""; saveDraft() }
            error = nil
            await refresh()
        } catch {
            // Authentication, rate limits and transport failures retain the original operation.
            // Only definitive validation/revision rejection permits a corrected command.
            if case ClientError.response(let code, _) = error, [400, 409, 422].contains(code) {
                try? sendJournal.acknowledge(connection: client.connection, operationId: body.operationId)
            }
            guard client === self.client else { return }
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = error.localizedDescription; await refreshDetail() }
        }
    }

    public func answerQuestion(_ question: WorkspaceQuestion, answer: String, dismiss: Bool = false) async {
        guard let client, isConnected, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let body: [String: JSONValue] = ["operationId": .string(UUID().uuidString), "answer": .string(answer), "dismiss": .bool(dismiss)]
            let _: WorkspaceQuestion = try await client.request("/api/workspace/tasks/\(question.taskId)/questions/\(question.id)/answer", method: "POST", body: JSONEncoder().encode(body))
            UserDefaults.standard.removeObject(forKey: "deploy.question." + question.id)
            await refresh()
        } catch {
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = error.localizedDescription; await refreshDetail() }
        }
    }

    public func stop() async {
        guard let client, let task = currentTask else { return }
        busy = true
        defer { busy = false }
        do {
            let body = RevisionCommand(operationId: UUID().uuidString, revision: task.revision)
            let _: WorkspaceTask = try await client.request("/api/workspace/tasks/\(task.id)/stop", method: "POST", body: JSONEncoder().encode(body))
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    /// Whether the selected task is closed: done by hand or finished by its merged pull request.
    public var currentTaskClosed: Bool { ["done", "merged"].contains(currentTask?.status ?? "") }

    /// Close the selected task as done, or reopen a closed one for review.
    public func setCurrentTaskClosed(_ closed: Bool) async {
        guard let client, let task = currentTask else { return }
        busy = true
        defer { busy = false }
        do {
            let body = RevisionCommand(operationId: UUID().uuidString, revision: task.revision)
            let _: WorkspaceTask = try await client.request("/api/workspace/tasks/\(task.id)/\(closed ? "close" : "reopen")",
                                                            method: "POST", body: JSONEncoder().encode(body))
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    public func cancelJob(_ job: WorkspaceJob) async {
        guard let client, let task = currentTask else { return }
        busy = true
        defer { busy = false }
        do {
            let body = ["operationId": UUID().uuidString]
            let _: JSONValue = try await client.request("/api/workspace/tasks/\(task.id)/jobs/\(job.id)/cancel", method: "POST", body: JSONEncoder().encode(body))
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    public func runCheck() async {
        guard let client, let task = currentTask, !isWorking else { return }
        busy = true
        defer { busy = false }
        do {
            let body = CheckBody(operationId: UUID().uuidString, revision: task.revision, command: checkCommand)
            let _: JSONValue = try await client.request("/api/workspace/tasks/\(task.id)/check", method: "POST", body: JSONEncoder().encode(body))
            await loadDiff()
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    public func suspend() {
        lifecycleGeneration += 1
        polling?.cancel()
        saveDraft()
    }

    private func pollChanges() async {
        guard let client else { return }
        if !isConnected { await refresh(); return }
        do {
            let page: EventPage = try await client.request("/api/workspace/events?after=\(state?.cursor ?? 0)&waitMs=10000")
            if page.supportsWait != true { try await Task.sleep(for: .seconds(1)) }
            guard client === self.client, !Task.isCancelled else { return }
            // Empty responses refresh capability/worker freshness after an idle interval.
            await refresh()
        } catch {
            guard client === self.client, !Task.isCancelled else { return }
            recordConnectionFailure(error)
        }
    }

    func recordConnectionFailure(_ failure: Error) {
        isConnected = false
        connectionError = coordinatorErrorDescription(failure)
        error = connectionError
        if case ClientError.response(401, _) = failure {
            needsAuthentication = true
            polling?.cancel()
            saveDraft()
        }
    }

    private func beginPolling() {
        polling?.cancel()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                if self?.isConnected != true { try? await Task.sleep(for: .seconds(1)) }
                guard !Task.isCancelled else { break }
                await self?.pollChanges()
            }
        }
    }
}

private struct RevisionCommand: Encodable { let operationId: String; let revision: Int }
private struct CheckBody: Encodable { let operationId: String; let revision: Int; let command: String }
