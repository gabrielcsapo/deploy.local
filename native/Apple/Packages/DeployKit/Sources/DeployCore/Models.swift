import Foundation

public struct WorkspaceState: Decodable, Equatable, Sendable {
    public let version: Int
    public let cursor: Int
    public let projects: [Project]
    public let tasks: [WorkspaceTask]
    public let runs: [Run]
    public let workers: [Worker]
    public let adapters: [Adapter]
}

public struct Project: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let owner: String
    public let sourcePath: String?
    public let repositoryPath: String
    public let createdAt: String
}

public struct WorkspaceTask: Decodable, Identifiable, Equatable, Sendable {
    public var queue: RunQueue? = nil
    public var waitingForAnswer: Bool? = nil
    public var pull: TaskPullSummary? = nil
    /// An agent's pending request to drive a browser or window; the task waits on your answer.
    public var controlRequest: ControlRequestSummary? = nil
    public var baseUpdate: BaseUpdate? = nil
    public var workspaceStatus: String? = nil
    public let id: String
    public let projectId: String?
    public let workerId: String?
    public let title: String
    public let status: String
    public let revision: Int
    public let workspacePath: String
    /// Where a remote task computer keeps this workspace; agents link files under it.
    public var remoteWorkspacePath: String? = nil
    public let baseRevision: String
    public let createdAt: String
    public let updatedAt: String
}

public struct TaskPullSummary: Decodable, Equatable, Sendable {
    public let id: String
    public let number: Int
    public let status: String
}

public struct ControlRequestSummary: Decodable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let targetLabel: String
    public let workerName: String
    public var viewOnly: Bool? = nil
    /// A whole Linux desktop whose owner allowed input there.
    public var desktopInput: Bool? = nil
    public var targetReason: String? = nil
    public var record: Bool? = nil
    public let expiresAt: Double
}

public extension WorkspaceTask {
    var needsApproval: Bool { controlRequest != nil }
    var inReview: Bool { pull?.status == "open" && status != "merged" }
    var displayStatus: String { waitingForAnswer == true ? "waiting" : status == "queued" ? "queued" : inReview ? "in_review" : status }
    var reviewLabel: String? {
        guard inReview, let pull else { return nil }
        return "In review · PR #\(pull.number)"
    }
}

public struct PublishDefaults: Decodable, Equatable, Sendable {
    public let title: String
    public let body: String
}

public struct RunQueue: Decodable, Equatable, Sendable {
    public var moveUnavailableReason: String? = nil
    public let reason: String
    public let position: Int?
    public let total: Int
    public let alternatives: [QueueComputer]
    public var detail: String { reason + (total > 1 ? " · Position \(position.map(String.init) ?? "pending") of \(total)" : "") }
}

public struct QueueComputer: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
}

public struct Run: Decodable, Identifiable, Equatable, Sendable {
    public var queue: RunQueue? = nil
    public var agentContext: String? = nil
    public var agentContextAt: String? = nil
    public let id: String
    public let taskId: String
    public let adapter: String
    public let model: String?
    public let effort: String?
    public let status: String
    public let sessionId: String?
    public let createdAt: String
    public let updatedAt: String
    public let error: String?
    public var stopRequested: Bool? = nil
    /// How the coordinator presents a run a computer restart interrupted; nil for other runs.
    public var recoveryView: RunRecovery? = nil
    /// Working right now. A run left 'unknown' by a computer restart is not working: see `recovery`.
    public var isActive: Bool { ["queued", "starting", "running"].contains(status) }
    /// Still holds the task's single writer slot until the restart is resolved.
    public var awaitsRestartResolution: Bool { status == "unknown" }
    /// The restart notice for this run, including from a coordinator that predates `recoveryView`.
    public var recovery: RunRecovery? {
        if let recoveryView { return recoveryView }
        guard awaitsRestartResolution else { return nil }
        return RunRecovery(state: "needs-confirmation", title: RunRecovery.interruptedTitle,
                           detail: "Update deploy.local to resolve this run from here.", canMarkStopped: false, stopRequested: stopRequested ?? false)
    }
}

/// A run a computer restart interrupted: why it is waiting and whether it can be marked stopped.
public struct RunRecovery: Decodable, Equatable, Sendable {
    public static let interruptedTitle = "Interrupted — the computer restarted during this run"
    /// `waiting-for-computer`, `process-running`, `needs-confirmation` or `resolved`.
    public let state: String
    public let title: String
    public let detail: String
    public let canMarkStopped: Bool
    public let stopRequested: Bool
    public var isResolved: Bool { state == "resolved" }
    public init(state: String, title: String, detail: String, canMarkStopped: Bool, stopRequested: Bool) {
        self.state = state; self.title = title; self.detail = detail; self.canMarkStopped = canMarkStopped; self.stopRequested = stopRequested
    }
}

/// Structured deployment metadata recorded with an assistant message by the coordinator.
public struct MessageDeployment: Decodable, Equatable, Sendable {
    public var application: String? = nil
    public let status: String
    public let url: String?
}

public struct Message: Decodable, Identifiable, Equatable, Sendable {
    public var deployment: MessageDeployment? = nil
    public var attachmentIds: [String]? = nil
    public let id: String
    public let taskId: String
    public let role: String
    public let content: String
    public let createdAt: String
    public let runId: String?
    public let isProgress: Bool?
}

public struct TaskActivity: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let status: String
    public let summary: String
    public let items: [ActivityItem]
}
public struct ActivityItem: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let title: String
    public let status: String
    public let detail: String
    public let output: String
    public let source: String?
    public let exitCode: Int?
    public let background: Bool
}

public struct WorkspaceEvent: Codable, Identifiable, Equatable, Sendable {
    public var id: Int { cursor }
    public let cursor: Int
    public let taskId: String
    public let runId: String?
    public let type: String
    public let payload: JSONValue
    public let createdAt: String
}

public struct ModelOption: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let efforts: [String]
}
public struct AgentOption: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let models: [ModelOption]
    public let efforts: [String]
}

public struct ProviderUsageWindow: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let usedPercent: Double
    public let resetsAt: Double?
}

public struct ProviderUsage: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let status: String
    public let plan: String?
    public let checkedAt: Double?
    public let windows: [ProviderUsageWindow]
}

public struct DesktopCaptureStatus: Decodable, Equatable, Sendable {
    public let available: Bool
    public let reason: String
    public let sessionType: String?
    public let desktop: String?
    public let portalAvailable: Bool?
    public let grantStored: Bool?
    public let socketPath: String?
}

/// One thing a computer allows, from the coordinator. Grants happen on the computer itself;
/// `step.where == "here"` is only ever a removal or a project setting. See docs/node-permissions.md.
public struct NodePermission: Decodable, Identifiable, Equatable, Sendable {
    public struct Step: Decodable, Equatable, Sendable {
        public let `where`: String
        public let label: String
        public let command: String?
        public let instruction: String?
        public let action: String?

        public var onComputer: Bool { self.where == "computer" }
    }

    public let id: String
    public let label: String
    public let state: String
    public let summary: String
    public let step: Step?

    public var badge: String {
        switch state {
        case "on": "Allowed"
        case "needs-approval": "Needs approval"
        case "unavailable": "Unavailable"
        case "unknown": "Unknown"
        default: "Off"
        }
    }

    public init(id: String, label: String, state: String, summary: String, step: Step? = nil) {
        self.id = id; self.label = label; self.state = state; self.summary = summary; self.step = step
    }
}

public struct ComputerRole: Decodable, Equatable, Sendable {
    public let state: String
    public let reason: String
    public let fix: String?
    public var badge: String {
        switch state { case "ready": "Ready"; case "needs-setup": "Needs setup"; case "paused": "Paused"; default: "Off" }
    }
}

public struct Worker: Decodable, Identifiable, Equatable, Sendable {
    public var activeTaskCount: Int? = nil
    public var queuedTaskCount: Int? = nil
    public var busyNotice: String? {
        guard let count = activeTaskCount, count > 0 else { return nil }
        return "\(name) is busy with \(count) \(count == 1 ? "task" : "tasks") — this will wait"
    }
    public var build: WorkerBuild? = nil
    public var agentTools: [String]? = nil
    public var update: WorkerUpdate? = nil
    public let id: String
    public let name: String
    public let platform: String
    public let architecture: String
    public let status: String
    public let capabilities: [String]
    public let modelOptions: [AgentOption]?
    public let providers: [ProviderUsage]?
    public var desktopCapture: DesktopCaptureStatus? = nil
    public let connections: [WorkerProviderConnection]?
    public var permissions: [NodePermission]? = nil
    public var roles: [String: ComputerRole]? = nil

    /// "2 of 5 allowed · 1 waiting for approval", or nil from an older coordinator.
    public var permissionsHeadline: String? {
        guard let permissions, !permissions.isEmpty else { return nil }
        let allowed = permissions.filter { $0.state == "on" }.count
        let waiting = permissions.filter { $0.state == "needs-approval" }.count
        return "\(allowed) of \(permissions.count) allowed" + (waiting > 0 ? " · \(waiting) waiting for approval" : "")
    }

    public func isProviderAvailable(_ provider: String) -> Bool {
        guard status == "online", roles?["tasks"]?.state != "off" else { return false }
        if let connection = connections?.first(where: { $0.provider == provider }) {
            return connection.available && connection.enabled != false
        }
        return capabilities.contains(provider)
    }
}

public struct WorkerProviderConnection: Decodable, Equatable, Sendable {
    public let provider: String
    public let available: Bool
    public let enabled: Bool?
}

public struct Adapter: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let available: Bool
    public let capabilities: [String: Bool]
    public let billingMode: String
}

public struct WorkspaceJob: Decodable, Identifiable, Equatable, Sendable {
    public let runId: String?
    public let startedAt: String?
    public let finishedAt: String?
    public let name: String?
    public let id: String
    public let createdAt: String?
    public let workerId: String?
    public let waitingReason: String?
    public let command: String
    public let status: String
    public let digest: String
    public let output: String
    public let truncated: Bool
    /// A task detail carries only the tail of the output; the stored job keeps more.
    public var outputTruncated: Bool? = nil
    public let exitCode: Int?
    public let error: String?
    public let stopRequested: Bool?
    /// Paths the agent asked the worker to return when the job ends.
    public var artifactPaths: [JobArtifactRequest]? = nil
    /// Files stored as task attachments, or skipped with a reason. References only.
    public var artifacts: [JobArtifact]? = nil
    public var isActive: Bool { ["queued", "running"].contains(status) }
}

public struct JobArtifactRequest: Decodable, Equatable, Sendable {
    public let path: String
    public let caption: String?
}

public struct JobArtifact: Decodable, Equatable, Identifiable, Sendable {
    public let path: String
    public let name: String
    public let caption: String?
    public let attachmentId: String?
    public let kind: String?
    public let bytes: Int?
    public let skipped: String?
    public var id: String { attachmentId ?? "skipped:\(path)" }
}

public struct TaskCheckpointSummary: Decodable, Equatable, Sendable {
    public let id: String
    public let createdAt: String
    public let fileCount: Int
    /// Files changed against the task's diff base (the merged commit once its pull request
    /// merged); nil from older coordinators.
    public var changedFileCount: Int? = nil
    public let fresh: Bool
    public let reason: String?

    public var publishCaption: String { publishCaption(since: nil) }

    /// `since` names what a follow-up builds on, e.g. "since #1 merged".
    public func publishCaption(since: String?) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: createdAt) ?? ISO8601DateFormatter().date(from: createdAt)
        let time = date?.formatted(date: .omitted, time: .shortened) ?? createdAt
        let count = changedFileCount ?? fileCount
        return "Captured \(time) · \(count) \(count == 1 ? "file" : "files") · \(since ?? "the full change set")"
    }
}

public struct TaskDetail: Decodable, Equatable, Sendable {
    public var attachments: [MediaAttachment]? = nil
    public var publishDefaults: PublishDefaults? = nil
    public var latestCheckpoint: TaskCheckpointSummary? = nil
    public let task: WorkspaceTask
    public let messages: [Message]
    public let runs: [Run]
    public let jobs: [WorkspaceJob]?
    public let events: [WorkspaceEvent]
    /// `events` is the newest slice; older ones page from `/api/workspace/events?taskId=…&before=eventsBefore`.
    public var eventsTruncated: Bool? = nil
    public var eventsBefore: Int? = nil
    public let cursor: Int
    public let activity: [TaskActivity]?
    public let questions: [WorkspaceQuestion]?
    /// A follow-up waiting for the active turn, or one held back because that turn failed or stopped.
    public var queuedMessage: QueuedMessage? = nil
}

public struct QueuedMessage: Decodable, Equatable, Sendable {
    public var attachmentIds: [String]? = nil
    public let taskId: String
    public let content: String
    /// `queued` waits for the turn; `held` was not sent and says why in `reason`.
    public let status: String
    public let reason: String?
    public let createdAt: String
    public var isHeld: Bool { status == "held" }
    public init(taskId: String, content: String, status: String, reason: String? = nil, createdAt: String) {
        self.taskId = taskId; self.content = content; self.status = status; self.reason = reason; self.createdAt = createdAt
    }
}

public struct WorkspaceQuestion: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let taskId: String
    public let runId: String
    public let question: String
    public let options: [String]
    public let status: String
    public let answer: String?
}

public struct EventPage: Decodable, Sendable {
    public let events: [WorkspaceEvent]
    public let cursor: Int
    public let supportsWait: Bool?
}

/// Put a held follow-up back into the composer without losing what was typed since.
public func draftRestoring(_ held: String, into draft: String) -> String {
    if draft.contains(held) { return draft }
    return draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? held : held + "\n\n" + draft
}

public struct TaskDiff: Decodable, Equatable, Sendable {
    public let truncated: Bool?
    public let excluded: [String]?
    public let hasUnpublishedChanges: Bool?
    /// The task computer has not uploaded changes against the task's current baseline yet.
    public var baselinePending: Bool? = nil
    public let baseRevision: String
    public let headRevision: String
    public let patch: String
    public let status: String
    public let files: [ChangedFile]
    public let checks: [JSONValue]
    /// `turn` when the coordinator diffed the latest turn's checkpoints; `all` (or nil) otherwise.
    public var scope: String? = nil
    /// Why a "This turn" request shows all changes instead, in the coordinator's words.
    public var note: String? = nil
    public var runId: String? = nil
}

/// Which changes the Changes view shows.
public enum DiffScope: String, CaseIterable, Sendable {
    case turn, all
    public var title: String { self == .turn ? "This turn" : "All changes" }
}

public struct ChangedFile: Decodable, Identifiable, Equatable, Sendable {
    public var id: String { path }
    public let path: String
    public let status: String
    public init(path: String, status: String) { self.path = path; self.status = status }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .bool(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .object(let v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }
    public var prettyText: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
    public var displayText: String {
        switch self {
        case .string(let value): value
        case .object(let value):
            value["message"]?.displayText ?? value["text"]?.displayText ?? value["content"]?.displayText ?? value["status"]?.displayText ?? ""
        default: ""
        }
    }
}

/// Merge ordered replay without duplicating events after a reconnect.
public struct EventJournal: Sendable {
    public private(set) var cursor = 0
    public private(set) var events: [WorkspaceEvent] = []
    public init() {}
    public mutating func append(_ incoming: [WorkspaceEvent]) {
        let known = Set(events.map(\.cursor))
        let unique = Dictionary(incoming.filter { !known.contains($0.cursor) }.map { ($0.cursor, $0) }, uniquingKeysWith: { first, _ in first })
        events.append(contentsOf: unique.values)
        events.sort { $0.cursor < $1.cursor }
        cursor = max(cursor, events.last?.cursor ?? 0)
    }
}

public struct ControlTarget: Decodable, Identifiable, Equatable, Sendable {
    public var id: String { workerId + ":" + targetId }
    public let targetId: String
    public let workerId: String
    public let label: String
    public let kind: String
    public let available: Bool
    public let reason: String?
    enum CodingKeys: String, CodingKey { case targetId = "id", workerId, label, kind, available, reason }
}
public struct ControlSession: Decodable, Identifiable, Equatable, Sendable {
    public let targetId: String
    public let viewOnly: Bool?
    public let id: String
    public let workerId: String
    public let targetLabel: String
    public let kind: String
    public let status: String
    public let generation: String
    public let controlOwner: String?
    public let reason: String?
}
public struct ControlCommand: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let sessionId: String
    public let status: String
    public let error: String?
}
public struct ControlRequest: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let workerId: String
    public let targetLabel: String
    public let kind: String
    public let status: String
}
public struct ControlState: Decodable, Equatable, Sendable {
    public let requests: [ControlRequest]?
    public let sessions: [ControlSession]
    public let targets: [ControlTarget]
    public let commands: [ControlCommand]
}
public struct ControlSnapshot: Decodable, Sendable {
    public let image: String?
    public let text: String?
    public let title: String?
    public let width: Double?
    public let height: Double?
    public let inputBounds: [String: Double]?
    public let capturedAt: String
}

public struct BaseUpdate: Decodable, Equatable, Sendable {
    public let status: String
    public var targetBranch: String? = nil
    public var conflicts: [String] = []
    public var error: String? = nil
    public var pending: Bool { !["succeeded", "aborted"].contains(status) }
    public var running: Bool { ["queued", "preparing", "prepared"].contains(status) }
    public var caption: String {
        if pending && !conflicts.isEmpty { return "Resolve conflicts: " + conflicts.joined(separator: ", ") + (error.map { "\n" + $0 } ?? "") }
        if let error { return error }
        if status == "succeeded" { return "Up to date with \(targetBranch ?? "main")." }
        if status == "aborted" { return "Update aborted; workspace restored." }
        return "Waiting for the task computer to finish the update."
    }
}
