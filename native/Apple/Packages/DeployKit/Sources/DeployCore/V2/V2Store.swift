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
    public var inboxPosition = V2InboxPosition()
    public var live: V2Live?
    public var workspace: V2Workspace?
    public var projects: [V2Project] = []
    public var agents: [V2Agent] = []
    public var computers: [V2Computer] = []
    public var account: V2Account?
    public var events: [V2Event] = []
    public var cursor = 0
    public var loadedResources: Set<String> = []
    public var resourceDates: [String: Date] = [:]
    public var updatedAt: Date?
    public var drafts: [V2Draft] = []
    public var composer = V2Draft()
    public var composers: [String: V2Draft] = [:]
    public var agentTasks: [String: String] = [:]
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case loadedResources, resourceDates
        case inbox, inboxPosition, live, workspace, projects, agents, computers, account, events, cursor, updatedAt
        case drafts, composer, composers, agentTasks
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        loadedResources = try values.decodeIfPresent(Set<String>.self, forKey: .loadedResources) ?? []
        resourceDates = try values.decodeIfPresent([String: Date].self, forKey: .resourceDates) ?? [:]
        inbox = try values.decode([InboxItem].self, forKey: .inbox)
        inboxPosition = try values.decodeIfPresent(V2InboxPosition.self, forKey: .inboxPosition) ?? V2InboxPosition()
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
        // Legacy snapshots only prove the resources that actually contain data. An old
        // updatedAt does not prove that a swallowed optional request ever succeeded.
        if workspace != nil { loadedResources.insert("workspace") }
        if live != nil { loadedResources.insert("live") }
        if !projects.isEmpty { loadedResources.insert("projects") }
        if !agents.isEmpty { loadedResources.insert("agents") }
        if !computers.isEmpty { loadedResources.insert("computers") }
        if inbox.contains(where: { $0.state == .waiting }) { loadedResources.insert("waiting") }
        if inbox.contains(where: { $0.state == .answered }) { loadedResources.insert("answered") }

    }
}

/// Relevant events request a paced full refresh. Health events and a 15-second fallback
/// update only Live and computers, including availability changes with no mapped event.
struct V2RefreshPacer {
    static let longPollMs = 10_000
    let interval: Duration
    private var pending = false
    private var finishedAt: ContinuousClock.Instant?
    private var liveFinishedAt: ContinuousClock.Instant?
    private var pendingLive = false

    init(interval: Duration) { self.interval = interval }

    mutating func pageArrived(relevant: Bool = true, health: Bool = false) {
        pending = pending || relevant
        pendingLive = pendingLive || health
    }
    /// A refresh reads everything up to now, so only pages after this point ask for another.
    mutating func refreshStarted() { pending = false }
    mutating func refreshFinished(at now: ContinuousClock.Instant) { finishedAt = now; liveRefreshFinished(at: now) }
    mutating func liveRefreshFinished(at now: ContinuousClock.Instant) { liveFinishedAt = now; pendingLive = false }
    func shouldRefreshLive(at now: ContinuousClock.Instant) -> Bool { liveRemaining(at: now) == .zero }
    private func liveRemaining(at now: ContinuousClock.Instant) -> Duration {
        guard let liveFinishedAt else { return .seconds(15) }
        return max(.zero, (pendingLive ? interval : .seconds(15)) - liveFinishedAt.duration(to: now))
    }
    func shouldRefresh(at now: ContinuousClock.Instant) -> Bool {
        pending && remaining(at: now) == .zero
    }
    func waitMs(at now: ContinuousClock.Instant) -> Int {
        let wait = min(pending ? remaining(at: now) : .seconds(10), liveRemaining(at: now))
        let parts = wait.components
        let ms = parts.seconds * 1000 + (parts.attoseconds + 999_999_999_999_999) / 1_000_000_000_000_000
        return Int(min(ms, Int64(Self.longPollMs)))
    }
    private func remaining(at now: ContinuousClock.Instant) -> Duration {
        guard let finishedAt else { return .zero }
        return max(.zero, interval - finishedAt.duration(to: now))
    }
}

@Observable @MainActor public final class V2Store {
    public private(set) var snapshot = V2Snapshot()
    public private(set) var loads: [String: V2LoadState] = [:]
    @ObservationIgnored private var activeReads: [String: UUID] = [:]
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
    @ObservationIgnored public var readCache: [String: Any] = [:]
    @ObservationIgnored public var readDates: [String: Date] = [:]
    private let cacheURL: URL
    private var polling: Task<Void, Never>?
    private var generation = 0
    private var flushing = false
    private var connectionError: String?
    @ObservationIgnored private var pacer: V2RefreshPacer

    public init(connection: Connection, client: V2Client? = nil, cacheDirectory: URL? = nil, refreshInterval: Duration = .seconds(2)) {
        self.connection = connection
        pacer = V2RefreshPacer(interval: refreshInterval)
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
    public func suspend() {
        generation += 1; polling?.cancel(); polling = nil
        leaveResources(Array(loads.keys)); try? persist()
    }
    public func loadState(_ key: String) -> V2LoadState {
        let state = loads[key] ?? V2LoadState(hasData: snapshot.loadedResources.contains(key))
        let known: Bool
        switch key {
        case "waiting": known = !waiting.isEmpty
        case "answered": known = !answered.isEmpty
        case "agents": known = !snapshot.agents.isEmpty
        case "projects": known = !snapshot.projects.isEmpty
        case "computers": known = !snapshot.computers.isEmpty
        case "workspace": known = snapshot.workspace != nil
        case "live": known = snapshot.live != nil
        default: known = false
        }
        return known ? state.retainingData() : state
    }
    public func leaveResources(_ keys: [String]) {
        for key in keys { loads[key]?.leave(); activeReads[key] = nil }
    }
    public func start() async {
        suspend()
        let current = generation
        await refresh(foreground: true)
        guard current == generation, !needsAuthentication, !Task.isCancelled else { return }
        polling = Task { [weak self] in
            while let self, !Task.isCancelled, current == self.generation {
                do {
                    if !self.online { await self.refresh(foreground: true) }
                    guard self.online else { try await Task.sleep(for: .seconds(2)); continue }
                    let page = try await self.client.events(after: self.snapshot.cursor, waitMs: self.pacer.waitMs(at: .now))
                    guard current == self.generation, !Task.isCancelled else { return }
                    let relevant = self.apply(page)
                    // Refresh snapshots for task/inbox changes; poll Live separately for health and computers.
                    // In this loop, not beside it: a refresh that started before a page must not
                    // overwrite what that page just applied.
                    self.pacer.pageArrived(relevant: relevant, health: page.events.contains { $0.type == "health" })
                    if self.pacer.shouldRefresh(at: .now) { await self.refresh() }
                    else if self.pacer.shouldRefreshLive(at: .now) { await self.refreshLive() }
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
    @discardableResult public func apply(_ page: V2EventPage) -> Bool {
        var changed = false
        var relevant = false
        for entry in page.events where entry.cursor > snapshot.cursor {
            if entry.type == "agent" { relevant = true }
            if let item = entry.item, snapshot.inboxPosition.accepts(item, cursor: entry.cursor, at: entry.at, previous: snapshot.inbox.first(where: { $0.id == item.id })) { replace(item); changed = true }
            if let release = entry.release { releases[release.id] = release; changed = true }
            if let rollback = entry.rollback { rollbacks[rollback.id] = rollback; changed = true }
            if let conversation = entry.event {
                // Updated work-log entries replace their earlier version, preserving typed records.
                snapshot.events.removeAll { $0.taskId == entry.taskId && $0.event?.v2Id == conversation.v2Id }
                snapshot.events.append(entry); changed = true
            }
        }
        snapshot.cursor = max(snapshot.cursor, page.cursor)
        // Retain decisions; fold/bound old non-decision history without losing pending actions.
        if snapshot.events.count > 4000 { snapshot.events.removeFirst(snapshot.events.count - 4000) }
        if changed { do { try persist() } catch { self.error = error.localizedDescription } }
        return changed || relevant
    }
    private func replace(_ item: InboxItem) {
        snapshot.inbox.removeAll { $0.id == item.id }
        snapshot.inbox.append(item)
    }
    /// Full refreshes remain owned by the event pacer. Navigation and gestures read only
    /// the displayed resources; automatic polling never starts foreground header status.
    public func refresh(foreground: Bool = false) async {
        needsAuthentication = false
        pacer.refreshStarted()
        defer { pacer.refreshFinished(at: .now) }
        await refreshResources(["workspace", "waiting", "answered", "live", "agents", "projects", "computers", "account"], foreground: foreground)
        if online { await flushDrafts() }
    }
    public func refreshResources(_ keys: [String], foreground: Bool = true) async {
        await withTaskGroup(of: Void.self) { group in
            for key in keys { group.addTask { await self.refreshResource(key, foreground: foreground) } }
        }
    }
    private func refreshResource(_ key: String, foreground: Bool) async {
        if let active = activeReads[key] {
            if foreground { loads[key]?.promote(active) }
            return
        }
        var state = loadState(key)
        let ticket = state.begin(foreground: foreground)
        loads[key] = state; activeReads[key] = ticket
        defer { if activeReads[key] == ticket { activeReads[key] = nil } }
        do {
            // Fetch before mutating the snapshot. Navigation invalidates the ticket, so
            // responses from an earlier visit cannot overwrite this visit's data.
            let apply: () -> Void
            switch key {
            case "workspace":
                let value = try await client.workspace(); apply = { self.snapshot.workspace = value }
            case "waiting", "answered":
                let page = try await client.inboxPage(state: key)
                apply = { self.mergeInbox(page, waiting: key == "waiting") }
            case "live":
                let value = try await client.live(); apply = { self.snapshot.live = value }
            case "agents":
                let value = try await client.agents(); apply = { self.snapshot.agents = value }
            case "projects":
                let value = try await client.projects(fallback: snapshot.workspace?.projects ?? (loadState("projects").hasData ? snapshot.projects : nil))
                apply = { self.snapshot.projects = value; self.projectsError = nil }
            case "computers":
                let value = try await client.computers(); apply = { self.snapshot.computers = value; self.computersError = nil }
            case "account":
                let value = try await client.account(); apply = { self.snapshot.account = value }
            default: return
            }
            guard !Task.isCancelled, loads[key]?.succeed(ticket) == true else { return }
            apply()
            snapshot.loadedResources.insert(key); snapshot.resourceDates[key] = Date()
            snapshot.updatedAt = Date()
            online = ["workspace", "waiting", "live"].allSatisfy { loadState($0).hasData && !loadState($0).failed }
            if online { if error == connectionError { error = nil }; connectionError = nil }
            try persist()
        } catch {
            guard !Task.isCancelled, loads[key]?.fail(ticket) == true else { return }
            if key == "computers", case ClientError.response(403, _) = error { computersError = "Only an administrator can view these computers." }
            else if key == "projects" { projectsError = "Projects could not be refreshed." }
            if ["workspace", "waiting", "live"].contains(key) { record(error) }
            else if key != "agents", case ClientError.response(401, _) = error { record(error) }
        }
    }
    private func mergeInbox(_ page: V2InboxPage, waiting: Bool) {
        var position = snapshot.inboxPosition
        let boundary = waiting ? position.waiting : position.answered
        if let cursor = page.cursor, cursor < boundary { return }
        let previous = snapshot.inbox
        var items = previous.filter { item in
            guard item.state == (waiting ? .waiting : .answered) else { return true }
            return (position.items[item.id] ?? 0) > (page.cursor ?? 0)
        }
        for item in page.items {
            let old = previous.first { $0.id == item.id }
            if let cursor = page.cursor {
                let known = position.items[item.id] ?? 0
                if known > cursor || (known == cursor && old != nil && old?.state != item.state) { continue }
                position.items[item.id] = cursor
            } else {
                // Old coordinators lack positions. Keep newer event/answered truth rather
                // than resurrecting a waiting decision from an undated legacy response.
                if (position.items[item.id] ?? 0) > 0 { continue }
                if let old, old.state != .waiting, item.state == .waiting, item.createdAt <= old.createdAt { continue }
            }
            items.removeAll { $0.id == item.id }; items.append(item)
        }
        if waiting { position.waiting = max(boundary, page.cursor ?? 0) }
        else { position.answered = max(boundary, page.cursor ?? 0) }
        snapshot.inbox = items; snapshot.inboxPosition = position
    }
    private func refreshLive() async {
        defer { pacer.liveRefreshFinished(at: .now) }
        await refreshResources(["live", "computers"], foreground: false)
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
