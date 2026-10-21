import Foundation
import Observation

@Observable @MainActor
public final class WorkspaceStore {
    public private(set) var connection: Connection?
    public private(set) var state: WorkspaceState?
    public private(set) var detail: TaskDetail?
    /// Recently opened tasks, so switching shows the conversation at once (like the Codex app)
    /// while a fresh copy loads, instead of blanking to a spinner for a network round trip.
    @ObservationIgnored private var detailCache: [String: TaskDetail] = [:]
    @ObservationIgnored private var diffCache: [String: TaskDiff] = [:]
    @ObservationIgnored private var pullCache: [String: (linked: ProjectWorkItem?, pulls: [ProjectWorkItem], issues: [ProjectWorkItem])] = [:]
    @ObservationIgnored private var cacheOrder: [String] = []
    @ObservationIgnored private var prefetching: Set<String> = []
    @ObservationIgnored private var settingsAdoptedFor: String?
    @ObservationIgnored private var warmedCache = false
    @ObservationIgnored private var summaryCache: (jobs: [WorkspaceJob], activity: [TaskActivity], value: TaskActivitySummary)?
    /// The selected task's activity summary, computed once per change to its jobs or activity.
    /// Views read it several times per render (toolbar, card, rail, composer pill).
    public var activitySummary: TaskActivitySummary {
        let jobs = detail?.jobs ?? [], activity = detail?.activity ?? []
        if let cached = summaryCache, cached.jobs == jobs, cached.activity == activity { return cached.value }
        let value = TaskActivitySummary(jobs: jobs, activity: activity)
        summaryCache = (jobs, activity, value)
        return value
    }
    /// All of the task's changes. Publishing, counts and checks always use this.
    public private(set) var diff: TaskDiff?
    /// What the latest turn changed, loaded only while Changes shows "This turn".
    public private(set) var turnDiff: TaskDiff?
    /// The diff the Changes view shows for the chosen scope.
    public var shownDiff: TaskDiff? { diffScope == .turn ? turnDiff : diff }
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
    public var pendingAttachments: [MediaAttachment] = []
    public var uploadingAttachment = false
    public var attachmentUploadProgress = 0.0
    public var attachmentUploadName: String?
    @ObservationIgnored var mediaUploadTask: Task<MediaAttachment, Error>?
    public var checkCommand = "git diff --check"
    /// "This turn" diffs the latest turn's checkpoints; "All changes" is the cumulative task diff.
    public private(set) var diffScope: DiffScope = .all
    /// A file link from the conversation waiting to be shown in Changes.
    public private(set) var fileRequest: TaskFileReference?
    /// Where the last file link landed, for the Changes view to scroll to or explain.
    public private(set) var fileFocus: FileLinkFocus?
    /// Increments when your own message is sent or queued, so the transcript follows it and the reply.
    public private(set) var followRequest = 0
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
    public var queuedMessage: QueuedMessage? { detail?.task.id == selectedTaskId ? detail?.queuedMessage : nil }
    /// While a turn runs, Send queues one follow-up on the coordinator instead of interrupting it.
    public var sendQueues: Bool { activeRun != nil && currentTask?.status != "checking" }
    public var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty) && !uploadingAttachment && !busy && isConnected
            && (!isWorking || (sendQueues && queuedMessage?.status != "queued"))
    }
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
            state = nil; detail = nil; diff = nil; selectedTaskId = nil; draft = ""; pendingAttachments = []
            connection = result
            needsAuthentication = false
            client = WorkspaceClient(connection: result)
            resetTaskCache()
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
        resetTaskCache()
        selectedTaskId = nil; pendingAttachments = []; isConnected = false
        needsAuthentication = false
    }

    public func saveDraft() {
        if let selectedTaskId { drafts[selectedTaskId] = draft }
        UserDefaults.standard.set(drafts, forKey: "deploy.workspace.drafts")
        if let selectedTaskId, let key = selectionKey {
            UserDefaults.standard.set(try? JSONEncoder().encode(pendingAttachments), forKey: key + ".media." + selectedTaskId)
        }
    }

    public func select(_ id: String?) async {
        saveDraft()
        selectedTaskId = id
        if let key = selectionKey { UserDefaults.standard.set(id, forKey: key) }
        draft = id.flatMap { drafts[$0] } ?? ""
        pendingAttachments = []
        if let id, let key = selectionKey, let data = UserDefaults.standard.data(forKey: key + ".media." + id) { pendingAttachments = (try? JSONDecoder().decode([MediaAttachment].self, from: data)) ?? [] }
        let cached = id.flatMap { detailCache[$0] }
        let pulls = id.flatMap { pullCache[$0] }
        detail = cached; diff = id.flatMap { diffCache[$0] }; turnDiff = nil
        linkedPull = pulls?.linked; projectPulls = pulls?.pulls ?? []; projectIssues = pulls?.issues ?? []
        fileRequest = nil; fileFocus = nil
        settingsAdoptedFor = nil
        if let cached, let id { adoptRunSettings(cached, for: id) }
        await refreshDetail()
    }

    /// Fetches a task into the cache without showing it, e.g. when its row is hovered, so opening
    /// it is instant. Never touches the selected task's published state.
    public func prefetch(_ id: String) async {
        guard let client, id != selectedTaskId, detailCache[id] == nil, !prefetching.contains(id) else { return }
        prefetching.insert(id)
        defer { prefetching.remove(id) }
        guard let next: TaskDetail = try? await client.request("/api/workspace/tasks/\(id)"), client === self.client else { return }
        remember(next, for: id)
    }

    /// A different coordinator or account must never show another's cached conversations.
    private func resetTaskCache() {
        detailCache = [:]; diffCache = [:]; pullCache = [:]; cacheOrder = []; warmedCache = false
    }

    private func remember(_ detail: TaskDetail, for id: String) {
        detailCache[id] = detail
        cacheOrder.removeAll { $0 == id }
        cacheOrder.append(id)
        while cacheOrder.count > 24 {
            let evicted = cacheOrder.removeFirst()
            detailCache[evicted] = nil; diffCache[evicted] = nil; pullCache[evicted] = nil
        }
    }

    private func adoptRunSettings(_ detail: TaskDetail, for id: String) {
        guard settingsAdoptedFor != id else { return }
        settingsAdoptedFor = id
        if let last = detail.runs.last { adapter = last.adapter; model = last.model ?? ""; effort = last.effort ?? "" }
    }

    public func refresh() async {
        guard let client else { return }
        do {
            let next: WorkspaceState = try await client.request("/api/workspace/state")
            guard client === self.client else { return }
            if state != next { state = next }
            if !warmedCache {
                // Warm the most recent tasks once per connection so the first switches are instant too.
                warmedCache = true
                let recent = next.tasks.sorted { $0.updatedAt > $1.updatedAt }.prefix(6).map(\.id)
                Task { [weak self] in for id in recent { await self?.prefetch(id) } }
            }
            // @Observable notifies on every assignment, so only write values that changed;
            // otherwise each poll re-renders every view that reads them.
            if !isConnected { isConnected = true }
            if error != nil, error == connectionError { error = nil }
            if connectionError != nil { connectionError = nil }
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
            adoptRunSettings(next, for: id)
            let changedStatus = detail?.task.status != next.task.status
            if detail != next { detail = next }
            remember(next, for: id)
            adoptHeldMessage()
            if changedStatus || diff == nil { await loadDiff() }
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
            if diff != result { diff = result }
            diffCache[id] = result
            if diffScope == .turn { await loadTurnDiff() }
            if fileRequest != nil { resolveFileRequest() }
            await loadLinkedPull()
        } catch {
            guard client === self.client, id == selectedTaskId, !Task.isCancelled else { return }
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = coordinatorErrorDescription(error) }
        }
    }

    private func loadTurnDiff() async {
        guard let client, let id = selectedTaskId else { return }
        do {
            let result: TaskDiff = try await client.request("/api/workspace/tasks/\(id)/diff?scope=turn")
            guard client === self.client, id == selectedTaskId, diffScope == .turn else { return }
            turnDiff = result
        } catch {
            guard client === self.client, id == selectedTaskId, !Task.isCancelled else { return }
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = coordinatorErrorDescription(error) }
        }
    }

    public func setDiffScope(_ scope: DiffScope) async {
        guard scope != diffScope else { return }
        diffScope = scope
        fileFocus = nil
        if scope == .turn { turnDiff = nil; await loadTurnDiff() }
    }

    /// Show a file linked from the conversation in Changes, scrolled to it when the diff has it.
    public func openFile(_ reference: TaskFileReference) async {
        fileRequest = reference
        fileFocus = nil
        if shownDiff != nil { resolveFileRequest() } else { await loadDiff() }
    }

    private func resolveFileRequest() {
        guard let reference = fileRequest, let shown = shownDiff else { return }
        var focus = taskFileFocus(reference, files: shown.files, patches: reviewFilePatches(shown.patch, files: shown.files))
        // A file outside this turn may still be part of the task; look there before saying so.
        if diffScope == .turn, focus == .unchanged, let diff {
            diffScope = .all
            focus = taskFileFocus(reference, files: diff.files, patches: reviewFilePatches(diff.patch, files: diff.files))
        }
        fileRequest = nil
        fileRequests += 1
        fileFocus = FileLinkFocus(reference: reference, focus: focus, request: fileRequests)
    }
    private var fileRequests = 0

    public func clearFileFocus() { fileFocus = nil }

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
        pullCache[id] = (linkedPull, projectPulls, projectIssues)
    }

    public func publishTask(title: String, description: String) async -> ProjectWorkItem? {
        guard let client, let task = currentTask, !busy, !isWorking else { return nil }
        busy = true
        defer { busy = false }
        do {
            let body: [String: JSONValue] = ["operationId": .string(UUID().uuidString), "revision": .number(Double(task.revision)), "title": .string(title), "body": .string(description)]
            let result: TaskPublishResult = try await client.request("/api/workspace/tasks/\(task.id)/publish", method: "POST", body: JSONEncoder().encode(body))
            guard client === self.client, task.id == selectedTaskId else { return nil }
            linkedPull = result.pull
            await refresh()
            await loadDiff()
            return result.pull
        } catch { self.error = coordinatorErrorDescription(error); return nil }
    }

    /// Takes a remote task worker's access away. Granting it again happens on that computer.
    public func revokeWorker(id: String) async -> Bool {
        guard let client, let path = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return false }
        busy = true
        defer { busy = false }
        do {
            let _: JSONValue = try await client.request("/api/workspace/computers/\(path)/revoke", method: "POST", body: JSONEncoder().encode(["operationId": UUID().uuidString]))
            await refresh()
            return true
        } catch { self.error = coordinatorErrorDescription(error); return false }
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
            var body = ["operationId": UUID().uuidString, "title": taskTitle(title), "workerId": workerId]
            if let projectId, !projectId.isEmpty { body["projectId"] = projectId }
            let task: WorkspaceTask = try await client.request("/api/workspace/tasks", method: "POST", body: JSONEncoder().encode(body))
            await refresh()
            await select(task.id)
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    @discardableResult public func addAttachment(data: Data, name: String, caption: String = "", taskId requestedTaskId: String? = nil) async -> Bool {
        guard let client, let taskId = requestedTaskId ?? selectedTaskId else { return false }
        while uploadingAttachment {
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return false }
            guard client === self.client else { return false }
        }
        let draftKey = selectionKey.map { $0 + ".media." + taskId }
        let targetDraft = selectedTaskId == taskId ? pendingAttachments : draftKey.flatMap { UserDefaults.standard.data(forKey: $0) }.flatMap { try? JSONDecoder().decode([MediaAttachment].self, from: $0) } ?? []
        guard data.count <= 20 * 1024 * 1024, targetDraft.count < 20 else { error = "Use at most 20 images, each at most 20 MB."; return false }
        uploadingAttachment = true
        defer { uploadingAttachment = false }
        do {
            var parts = URLComponents(); parts.queryItems = [URLQueryItem(name: "name", value: name), URLQueryItem(name: "caption", value: caption), URLQueryItem(name: "operationId", value: UUID().uuidString)]
            let attachment: MediaAttachment = try await client.request("/api/workspace/tasks/\(taskId)/attachments?\(parts.percentEncodedQuery!)", method: "POST", body: data, contentType: "application/octet-stream", timeout: 90)
            guard client === self.client else { return false }
            if selectedTaskId == taskId { pendingAttachments.append(attachment); saveDraft() }
            else if let draftKey {
                let previous = UserDefaults.standard.data(forKey: draftKey).flatMap { try? JSONDecoder().decode([MediaAttachment].self, from: $0) } ?? []
                UserDefaults.standard.set(try? JSONEncoder().encode(previous + [attachment]), forKey: draftKey)
            }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func saveUploadedAttachment(_ attachment: MediaAttachment, taskId: String) {
        guard let key = selectionKey.map({ $0 + ".media." + taskId }) else { return }
        let previous = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([MediaAttachment].self, from: $0) } ?? []
        UserDefaults.standard.set(try? JSONEncoder().encode(previous + [attachment]), forKey: key)
    }
    public func removeAttachment(_ id: String) { pendingAttachments.removeAll { $0.id == id }; saveDraft() }

    public func send() async {
        guard let client, let task = currentTask, !busy, canSend,
              !isWorking || (sendQueues && queuedMessage?.status != "queued") else { return }
        // Your own message, and the reply after it, should stay in view.
        followRequest += 1
        if isWorking { await queue(draft, task: task, client: client); return }
        let content = draft
        let body: SendBody
        do {
            body = try sendJournal.prepare(connection: client.connection, taskId: task.id,
                proposed: SendBody(operationId: UUID().uuidString, revision: task.revision, content: content,
                                   model: model.isEmpty ? nil : model, effort: effort.isEmpty ? nil : effort, adapter: adapter, attachmentIds: pendingAttachments.map(\.id)))
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
            if selectedTaskId == task.id && draft == content { draft = ""; pendingAttachments = []; saveDraft() }
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

    /// Queue one follow-up for when the active turn ends. The coordinator keeps it, so every device
    /// sees it; it sends only after a successful turn and is held (back in the draft) otherwise.
    private func queue(_ content: String, task: WorkspaceTask, client: WorkspaceClient) async {
        busy = true
        defer { busy = false }
        do {
            let body = QueueBody(operationId: UUID().uuidString, content: content,
                                 model: model.isEmpty ? nil : model, effort: effort.isEmpty ? nil : effort, adapter: adapter, attachmentIds: pendingAttachments.map(\.id))
            let _: JSONValue = try await client.request("/api/workspace/tasks/\(task.id)/queue", method: "POST", body: JSONEncoder().encode(body))
            guard client === self.client else { return }
            if selectedTaskId == task.id && draft == content { draft = ""; pendingAttachments = []; saveDraft() }
            error = nil
            await refresh()
        } catch {
            guard client === self.client else { return }
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = error.localizedDescription; await refreshDetail() }
        }
    }

    /// Cancel a queued follow-up, or dismiss one that was held back.
    public func cancelQueuedMessage() async {
        guard let client, let task = currentTask else { return }
        busy = true
        defer { busy = false }
        do {
            let body = ["operationId": UUID().uuidString]
            let _: JSONValue = try await client.request("/api/workspace/tasks/\(task.id)/queue/cancel", method: "POST", body: JSONEncoder().encode(body))
            await refreshDetail()
        } catch {
            if case ClientError.response(401, _) = error { recordConnectionFailure(error) }
            else { self.error = error.localizedDescription }
        }
    }

    /// A held follow-up returns to the draft once per device, ahead of anything typed since.
    private func adoptHeldMessage() {
        guard let held = queuedMessage, held.isHeld else { return }
        let key = "deploy.workspace.held.\(held.taskId)"
        guard UserDefaults.standard.string(forKey: key) != held.createdAt else { return }
        UserDefaults.standard.set(held.createdAt, forKey: key)
        draft = draftRestoring(held.content, into: draft)
        for attachment in detail?.attachments ?? [] where held.attachmentIds?.contains(attachment.id) == true && !pendingAttachments.contains(where: { $0.id == attachment.id }) { pendingAttachments.append(attachment) }
        saveDraft()
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

    /// One identity per app launch, so the coordinator can tell this controller from others.
    private let controlClientId = UUID().uuidString

    /// Answer the selected task's pending agent-control request from the conversation.
    /// `always` also lets agents in the task's project use the task browser without asking.
    public func respondToControlRequest(allow: Bool, always: Bool = false) async {
        guard let client, let task = currentTask, let request = task.controlRequest else { return }
        busy = true
        defer { busy = false }
        do {
            if always, allow, let projectId = task.projectId {
                let policy: [String: JSONValue] = ["operationId": .string(UUID().uuidString), "autoApproveTaskBrowser": .bool(true)]
                let _: JSONValue = try await client.request("/api/workspace/projects/\(projectId)/settings/control",
                                                            method: "POST", body: JSONEncoder().encode(policy))
            }
            let body = ["operationId": UUID().uuidString, "clientId": controlClientId, "requestId": request.id]
            let _: JSONValue = try await client.request("/api/workspace/tasks/\(task.id)/controls/\(allow ? "approve" : "deny")",
                                                        method: "POST", body: JSONEncoder().encode(body))
            await refresh()
        } catch { self.error = error.localizedDescription; await refresh() }
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
private struct QueueBody: Encodable { let operationId: String; let content: String; let model: String?; let effort: String?; let adapter: String; let attachmentIds: [String] }
private struct CheckBody: Encodable { let operationId: String; let revision: Int; let command: String }
