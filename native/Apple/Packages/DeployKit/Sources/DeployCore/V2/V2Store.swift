import Foundation
import Observation

public struct V2Draft: Codable, Identifiable, Equatable, Sendable {
    public var id = UUID().uuidString
    public var createOperationId = UUID().uuidString
    public var taskId: String?
    public var revision: Int?
    public var text = ""
    public var projectId: String?
    public var workerId = "local"
    public var model: String?
    public var adapter = "codex"
    public var agent = ""
    public var question = false
    public var rejected = false
    public init() {}
}
public struct V2Snapshot: Codable, Sendable {
    public var inbox: [InboxItem] = []
    public var live: V2Live?
    public var workspace: V2Workspace?
    public var projects: [V2Project] = []
    public var agents: [V2Agent] = []
    public var computers: [V2Computer] = []
    public var account: V2Account?
    public var events: [V2Event] = []
    public var cursor = 0
    public var updatedAt: Date?
    public var drafts: [V2Draft] = []
    public var composer = V2Draft()
    public var composers: [String: V2Draft] = [:]
    public var agentTasks: [String: String] = [:]
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case inbox, live, workspace, projects, agents, computers, account, events, cursor, updatedAt
        case drafts, composer, composers, agentTasks
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        inbox = try values.decode([InboxItem].self, forKey: .inbox)
        live = try values.decodeIfPresent(V2Live.self, forKey: .live)
        workspace = try values.decodeIfPresent(V2Workspace.self, forKey: .workspace)
        projects = try values.decode([V2Project].self, forKey: .projects)
        // Existing on-device snapshots predate the agents list; keep their drafts intact.
        agents = try values.decodeIfPresent([V2Agent].self, forKey: .agents) ?? []
        computers = try values.decode([V2Computer].self, forKey: .computers)
        account = try values.decodeIfPresent(V2Account.self, forKey: .account)
        events = try values.decode([V2Event].self, forKey: .events)
        cursor = try values.decode(Int.self, forKey: .cursor)
        updatedAt = try values.decodeIfPresent(Date.self, forKey: .updatedAt)
        drafts = try values.decode([V2Draft].self, forKey: .drafts)
        composer = try values.decode(V2Draft.self, forKey: .composer)
        composers = try values.decode([String: V2Draft].self, forKey: .composers)
        agentTasks = try values.decode([String: String].self, forKey: .agentTasks)
    }
}

@Observable @MainActor public final class V2Store {
    public private(set) var snapshot = V2Snapshot()
    public private(set) var online = false
    public private(set) var needsAuthentication = false
    public private(set) var busy = false
    public var error: String?
    public var computersError: String?
    public var projectsError: String?
    public var notice: String?
    public var selectedTaskId: String?
    public var openedInboxId: String?
    public var openedAppId: String?
    public var releases: [String: Release] = [:]
    public var rollbacks: [String: Rollback] = [:]
    public let client: V2Client
    public let connection: Connection
    private let cacheURL: URL
    private var polling: Task<Void, Never>?
    private var generation = 0
    private var flushing = false
    private var connectionError: String?

    public init(connection: Connection, client: V2Client? = nil, cacheDirectory: URL? = nil) {
        self.connection = connection
        self.client = client ?? V2Client(connection: connection)
        let key = V2Client.notificationScope(connection)
        let directory = cacheDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("deploy.local/v2")
        cacheURL = directory.appendingPathComponent(key + ".json")
        if let data = try? Data(contentsOf: cacheURL) {
            do { snapshot = try JSONDecoder().decode(V2Snapshot.self, from: data) }
            catch { self.error = "Saved drafts could not be read. Reconnect before sending."; cacheUnreadable = true }
        }
    }
    private var cacheUnreadable = false
    public var waiting: [InboxItem] { snapshot.inbox.filter { $0.state == .waiting }.sorted { $0.createdAt > $1.createdAt } }
    public var answered: [InboxItem] { snapshot.inbox.filter { $0.state == .answered }.sorted { ($0.answer?.at ?? $0.createdAt) > ($1.answer?.at ?? $1.createdAt) } }
    public var tasks: [V2Task] { snapshot.workspace?.tasks ?? [] }
    public func agentName(_ id: String) -> String { snapshot.agents.first { $0.id == id }?.name ?? "An agent" }
    public var today: [V2Task] {
        tasks.filter { !snapshot.agentTasks.values.contains($0.id) && Self.isToday($0.updatedAt) }.sorted { $0.updatedAt > $1.updatedAt }
    }
    public static func isToday(_ value: String) -> Bool {
        guard let date = date(value) else { return false }
        return Calendar.current.isDateInToday(date)
    }
    public static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    public func persist() throws {
        guard !cacheUnreadable else { throw ClientError.invalidResponse }
        try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(snapshot).write(to: cacheURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cacheURL.path)
    }
    public func composer(taskId: String?, agent: String? = nil) -> V2Draft {
        snapshot.composers[taskId ?? agent.map { "agent:" + $0 } ?? "new"] ?? V2Draft()
    }
    private func composerKey(_ draft: V2Draft) -> String { draft.taskId ?? (draft.question ? "agent:" + draft.agent : "new") }
    public func saveComposer(_ draft: V2Draft, context: String? = nil) {
        snapshot.composer = draft
        snapshot.composers = snapshot.composers.filter { $0.value.id != draft.id }
        snapshot.composers[context ?? composerKey(draft)] = draft
        do { try persist() } catch { self.error = "Draft could not be saved: \(error.localizedDescription)" }
    }
    public func suspend() { generation += 1; polling?.cancel(); polling = nil; try? persist() }
    public func start() async {
        suspend()
        let current = generation
        await refresh()
        guard current == generation, !needsAuthentication, !Task.isCancelled else { return }
        polling = Task { [weak self] in
            while let self, !Task.isCancelled, current == self.generation {
                do {
                    if !self.online { await self.refresh() }
                    guard self.online else { try await Task.sleep(for: .seconds(2)); continue }
                    let page = try await self.client.events(after: self.snapshot.cursor)
                    guard current == self.generation, !Task.isCancelled else { return }
                    self.apply(page)
                    // Refresh snapshots for new tasks, updated health and computer availability.
                    await self.refresh()
                    if page.supportsWait != true { try await Task.sleep(for: .seconds(1)) }
                } catch {
                    if Task.isCancelled { return }
                    self.record(error)
                    if self.needsAuthentication { return }
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }
    public func apply(_ page: V2EventPage) {
        for entry in page.events where entry.cursor > snapshot.cursor {
            if let item = entry.item { replace(item) }
            if let release = entry.release { releases[release.id] = release }
            if let rollback = entry.rollback { rollbacks[rollback.id] = rollback }
            if let conversation = entry.event {
                // Updated work-log entries replace their earlier version, preserving typed records.
                snapshot.events.removeAll { $0.taskId == entry.taskId && $0.event?.v2Id == conversation.v2Id }
                snapshot.events.append(entry)
            }
        }
        snapshot.cursor = max(snapshot.cursor, page.cursor)
        // Retain decisions; fold/bound old non-decision history without losing pending actions.
        if snapshot.events.count > 4000 { snapshot.events.removeFirst(snapshot.events.count - 4000) }
        do { try persist() } catch { self.error = error.localizedDescription }
    }
    private func replace(_ item: InboxItem) {
        snapshot.inbox.removeAll { $0.id == item.id }
        snapshot.inbox.append(item)
    }
    public func refresh() async {
        do {
            async let workspace = client.workspace()
            async let waiting = client.inbox()
            async let answered = client.inbox(state: "answered")
            async let live = client.live()
            async let agents = try? client.agents()
            let next = try await (workspace, waiting, answered, live)
            guard !Task.isCancelled else { return }
            snapshot.workspace = next.0; snapshot.inbox = next.1 + next.2; snapshot.live = next.3
            if let agents = await agents { snapshot.agents = agents }
            snapshot.updatedAt = Date(); online = true; needsAuthentication = false
            if error == connectionError { error = nil }; connectionError = nil
            do { snapshot.projects = try await client.projects(fallback: next.0.projects); projectsError = nil }
            catch { projectsError = "Projects could not be refreshed."; if case ClientError.response(401, _) = error { throw error } }
            do { snapshot.computers = try await client.computers(); computersError = nil }
            catch ClientError.response(403, _) { computersError = "Only an administrator can view these computers." }
            catch { computersError = "Computers could not be refreshed."; if case ClientError.response(401, _) = error { throw error } }
            snapshot.account = try await client.account()
            try persist()
            await flushDrafts()
        } catch { if !Task.isCancelled { record(error) } }
    }
    public func createAgent(_ values: V2NewAgent) async throws -> V2Agent {
        let agent = try await client.createAgent(values)
        // A refresh or cache failure after a successful POST must never invite a second creation.
        if let agents = try? await client.agents() { snapshot.agents = agents }
        snapshot.agents.removeAll { $0.id == agent.id }
        snapshot.agents.append(agent)
        try? persist()
        return agent
    }
    private func record(_ error: Error) {
        online = false
        if case ClientError.response(401, _) = error { needsAuthentication = true }
        connectionError = coordinatorErrorDescription(error)
        self.error = connectionError
    }
    public func updateAgent(_ value: V2Agent) {
        snapshot.agents.removeAll { $0.id == value.id }
        snapshot.agents.append(value)
        try? persist()
    }
    public func answer(_ item: InboxItem, action: InboxAction, note: String? = nil) async {
        guard online, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await client.answer(item.id, action: action.id, note: note)
            replace(result.item)
            notice = result.alreadyAnswered ? "Already answered on \(result.item.answer?.on.rawValue ?? "another device")." : nil
            try persist()
        } catch { self.error = coordinatorErrorDescription(error); if error is URLError { online = false } }
    }
    @discardableResult public func enqueue(_ draft: V2Draft) async -> Bool {
        guard !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard !cacheUnreadable else { return false }
        if !snapshot.drafts.contains(where: { $0.id == draft.id }) { snapshot.drafts.append(draft) }
        do { try persist() } catch { self.error = "Message was not queued: \(error.localizedDescription)"; return false }
        snapshot.composer = V2Draft()
        snapshot.composers = snapshot.composers.filter { $0.value.id != draft.id }
        try? persist()
        if online { await flushDrafts() }
        return true
    }
    public func flushDrafts() async {
        guard online, !flushing, !cacheUnreadable else { return }
        flushing = true
        defer { flushing = false }
        while var draft = snapshot.drafts.first {
            if draft.rejected { return }
            do {
                if draft.question && !draft.agent.isEmpty {
                    _ = try await client.sendAgent(draft.agent, text: draft.text, operationId: draft.id, model: draft.model)
                    snapshot.drafts.removeFirst()
                    try persist()
                    await refresh()
                    continue
                }
                if draft.taskId == nil {
                    let title = draft.question && !draft.agent.isEmpty ? "Ask \(agentName(draft.agent))" : String(draft.text.prefix(120))
                    let task = try await client.createTask(operationId: draft.createOperationId, title: title, projectId: draft.projectId, workerId: draft.workerId)
                    draft.taskId = task.id; draft.revision = task.revision
                    snapshot.drafts[0] = draft
                    if draft.question && !draft.agent.isEmpty { snapshot.agentTasks[draft.agent] = task.id }
                    try persist()
                }
                guard let taskId = draft.taskId else { return }
                if draft.revision == nil {
                    draft.revision = try await client.task(taskId).task.revision
                    snapshot.drafts[0] = draft
                    try persist()
                }
                try await client.send(taskId: taskId, operationId: draft.id, revision: draft.revision!, text: draft.text, model: draft.model, adapter: draft.adapter)
                snapshot.drafts.removeFirst()
                selectedTaskId = taskId
                try persist()
                notice = nil
            } catch {
                if case ClientError.response(let status, _) = error, [400, 409, 422].contains(status) {
                    snapshot.drafts[0].rejected = true
                    try? persist()
                    self.error = "This conversation changed. Your queued draft is saved; review it before retrying."
                } else if error is URLError { record(error) }
                else { self.error = coordinatorErrorDescription(error) }
                return
            }
        }
    }
    public func recoverDraft(_ id: String) {
        guard let index = snapshot.drafts.firstIndex(where: { $0.id == id && $0.rejected }) else { return }
        snapshot.composer = snapshot.drafts.remove(at: index)
        // Explicit editing after a definitive rejection gets a new operation, never automatic replay.
        snapshot.composer.id = UUID().uuidString; snapshot.composer.revision = nil; snapshot.composer.rejected = false
        if snapshot.composer.taskId == nil { snapshot.composer.createOperationId = UUID().uuidString }
        snapshot.composers["new"] = snapshot.composer
        try? persist()
    }
    public func conversation(_ taskId: String) -> [ConversationEvent] {
        snapshot.events.filter { $0.taskId == taskId }.compactMap(\.event)
    }
}

extension ConversationEvent {
    public var v2Id: String {
        switch self {
        case .you(let value): value.id
        case .reply(let value): value.id
        case .worklog(let value): value.id
        case .decision(let value): value.id
        case .task(let value): value.id
        case .release(let value): value.id
        case .screenshot(let value): value.id
        case .report(let value): value.id
        }
    }
    public var v2Date: String {
        switch self {
        case .you(let value): value.at
        case .reply(let value): value.at
        case .worklog(let value): value.at
        case .decision(let value): value.at
        case .task(let value): value.at
        case .release(let value): value.at
        case .screenshot(let value): value.at
        case .report(let value): value.at
        }
    }
}
