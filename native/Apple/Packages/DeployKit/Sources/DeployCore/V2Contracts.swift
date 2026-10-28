import Foundation

// Wire types shared with shared/v2/contracts.ts. Dates remain ISO 8601 strings.
public typealias AgentId = String
public typealias UserId = String

public enum Role: String, Codable, Equatable, Sendable {
    case coordinator = "coordinator"
    case takeTasks = "take-tasks"
    case runApps = "run-apps"
    case serveModels = "serve-models"
    case useScreen = "use-screen"
}

public enum ApprovalAction: String, Codable, Equatable, Sendable {
    case merge = "merge"
    case ship = "ship"
    case rollback = "rollback"
    case restart = "restart"
    case install = "install"
    case changeSecrets = "change-secrets"
    case useScreen = "use-screen"
    case spend = "spend"
}

public enum ApprovalMode: String, Codable, Equatable, Sendable {
    case ask = "ask"
    case allow = "allow"
    case never = "never"
}

public struct ApprovalRule: Codable, Equatable, Sendable {
    public var id: String
    public var agent: AgentId
    public var action: ApprovalAction
    public var projectId: String?
    public var mode: ApprovalMode
    public var limit: String?

    public init(id: String, agent: AgentId, action: ApprovalAction, projectId: String? = nil, mode: ApprovalMode, limit: String? = nil) {
        self.id = id
        self.agent = agent
        self.action = action
        self.projectId = projectId
        self.mode = mode
        self.limit = limit
    }
}

public struct Agent: Codable, Equatable, Sendable {
    public var id: AgentId
    public var name: String
    public var job: String
    public var computers: [String]
    public var createdBy: UserId

    public init(id: AgentId, name: String, job: String, computers: [String], createdBy: UserId) {
        self.id = id
        self.name = name
        self.job = job
        self.computers = computers
        self.createdBy = createdBy
    }
}

public enum WorkIcon: String, Codable, Equatable, Sendable {
    case file = "file"
    case edit = "edit"
    case terminal = "terminal"
    case pulse = "pulse"
    case logs = "logs"
    case search = "search"
}

public struct WorkStep: Codable, Equatable, Sendable {
    public var icon: WorkIcon
    public var text: String
    public var added: Double?
    public var removed: Double?

    public init(icon: WorkIcon, text: String, added: Double? = nil, removed: Double? = nil) {
        self.icon = icon
        self.text = text
        self.added = added
        self.removed = removed
    }
}

public enum InboxKind: String, Codable, Equatable, Sendable {
    case question = "question"
    case merge = "merge"
    case rollback = "rollback"
    case control = "control"
    case install = "install"
    case other = "other"
}

public enum InboxState: String, Codable, Equatable, Sendable {
    case waiting = "waiting"
    case answered = "answered"
    case expired = "expired"
    case withdrawn = "withdrawn"
}

public enum AnswerSource: String, Codable, Equatable, Sendable {
    case web = "web"
    case iphone = "iphone"
    case desktop = "desktop"
    case cli = "cli"
}

public struct InboxAction: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var primary: Bool?
    public var confirm: String?

    public init(id: String, label: String, primary: Bool? = nil, confirm: String? = nil) {
        self.id = id
        self.label = label
        self.primary = primary
        self.confirm = confirm
    }
}

public struct InboxAnswer: Codable, Equatable, Sendable {
    public var actionId: String
    public var by: UserId
    public var on: AnswerSource
    public var at: String
    public var note: String?

    public init(actionId: String, by: UserId, on: AnswerSource, at: String, note: String? = nil) {
        self.actionId = actionId
        self.by = by
        self.on = on
        self.at = at
        self.note = note
    }
}

public struct InboxItem: Codable, Equatable, Sendable {
    public var id: String
    public var kind: InboxKind
    public var title: String
    public var text: String
    public var from: AgentId
    public var projectId: String?
    public var taskId: String?
    public var createdAt: String
    public var actions: [InboxAction]
    public var state: InboxState
    public var answer: InboxAnswer?

    public init(id: String, kind: InboxKind, title: String, text: String, from: AgentId, projectId: String? = nil, taskId: String? = nil, createdAt: String, actions: [InboxAction], state: InboxState, answer: InboxAnswer? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.text = text
        self.from = from
        self.projectId = projectId
        self.taskId = taskId
        self.createdAt = createdAt
        self.actions = actions
        self.state = state
        self.answer = answer
    }
}

public enum ReleaseSourceKind: String, Codable, Equatable, Sendable {
    case pr = "pr"
    case ship = "ship"
    case cli = "cli"
    case pipeline = "pipeline"
}

public struct ReleaseSource: Codable, Equatable, Sendable {
    public var kind: ReleaseSourceKind
    public var ref: String

    public init(kind: ReleaseSourceKind, ref: String) {
        self.kind = kind
        self.ref = ref
    }
}

public struct ReleaseApp: Codable, Equatable, Sendable {
    public var appId: String
    public var from: String?
    public var to: String

    public init(appId: String, from: String? = nil, to: String) {
        self.appId = appId
        self.from = from
        self.to = to
    }
}

public struct ReleaseMigration: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var reversible: Bool

    public init(id: String, title: String, reversible: Bool) {
        self.id = id
        self.title = title
        self.reversible = reversible
    }
}

public enum ReleaseStepName: String, Codable, Equatable, Sendable {
    case prepare = "prepare"
    case verify = "verify"
    case activate = "activate"
    case watch = "watch"
}

public enum ReleaseStepState: String, Codable, Equatable, Sendable {
    case waiting = "waiting"
    case running = "running"
    case done = "done"
    case failed = "failed"
    case skipped = "skipped"
}

public struct ReleaseStep: Codable, Equatable, Sendable {
    public var name: ReleaseStepName
    public var state: ReleaseStepState
    public var startedAt: String?
    public var endedAt: String?
    public var detail: String?

    public init(name: ReleaseStepName, state: ReleaseStepState, startedAt: String? = nil, endedAt: String? = nil, detail: String? = nil) {
        self.name = name
        self.state = state
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.detail = detail
    }
}

public enum ReleaseState: String, Codable, Equatable, Sendable {
    case running = "running"
    case live = "live"
    case failed = "failed"
    case rolledBack = "rolled-back"
    case superseded = "superseded"
}

public struct Release: Codable, Equatable, Sendable {
    public var id: String
    public var projectId: String
    public var source: ReleaseSource
    public var startedBy: UserId
    public var apps: [ReleaseApp]
    public var migrations: [ReleaseMigration]
    public var backupId: String?
    public var steps: [ReleaseStep]
    public var state: ReleaseState

    public init(id: String, projectId: String, source: ReleaseSource, startedBy: UserId, apps: [ReleaseApp], migrations: [ReleaseMigration], backupId: String? = nil, steps: [ReleaseStep], state: ReleaseState) {
        self.id = id
        self.projectId = projectId
        self.source = source
        self.startedBy = startedBy
        self.apps = apps
        self.migrations = migrations
        self.backupId = backupId
        self.steps = steps
        self.state = state
    }
}

public struct Rollback: Codable, Equatable, Sendable {
    public var id: String
    public var projectId: String
    public var from: String
    public var to: String
    public var reason: String
    public var approvedBy: UserId
    public var ruleId: String?
    public var steps: [ReleaseStep]

    public init(id: String, projectId: String, from: String, to: String, reason: String, approvedBy: UserId, ruleId: String? = nil, steps: [ReleaseStep]) {
        self.id = id
        self.projectId = projectId
        self.from = from
        self.to = to
        self.reason = reason
        self.approvedBy = approvedBy
        self.ruleId = ruleId
        self.steps = steps
    }
}

public enum AppKind: String, Codable, Equatable, Sendable {
    case web = "web"
    case worker = "worker"
}

public enum HealthState: String, Codable, Equatable, Sendable {
    case healthy = "healthy"
    case warning = "warning"
    case failing = "failing"
    case stopped = "stopped"
}

public struct HTTPHealth: Codable, Equatable, Sendable {
    public var path: String
    public var status: Double
    public var p95ms: Double
    public var reqPerMin: Double

    public init(path: String, status: Double, p95ms: Double, reqPerMin: Double) {
        self.path = path
        self.status = status
        self.p95ms = p95ms
        self.reqPerMin = reqPerMin
    }
}

public struct JobHealth: Codable, Equatable, Sendable {
    public var perMin: Double
    public var failRate: Double
    public var baselineFailRate: Double

    public init(perMin: Double, failRate: Double, baselineFailRate: Double) {
        self.perMin = perMin
        self.failRate = failRate
        self.baselineFailRate = baselineFailRate
    }
}

public struct QueueHealth: Codable, Equatable, Sendable {
    public var depth: Double
    public var oldestSec: Double

    public init(depth: Double, oldestSec: Double) {
        self.depth = depth
        self.oldestSec = oldestSec
    }
}

public struct RestartHealth: Codable, Equatable, Sendable {
    public var count: Double
    public var windowSec: Double

    public init(count: Double, windowSec: Double) {
        self.count = count
        self.windowSec = windowSec
    }
}

public struct AppHealth: Codable, Equatable, Sendable {
    public var appId: String
    public var kind: AppKind
    public var state: HealthState
    public var summary: String
    public var http: HTTPHealth?
    public var jobs: JobHealth?
    public var queue: QueueHealth?
    public var restarts: RestartHealth?
    public var heartbeatAt: String?

    public init(appId: String, kind: AppKind, state: HealthState, summary: String, http: HTTPHealth? = nil, jobs: JobHealth? = nil, queue: QueueHealth? = nil, restarts: RestartHealth? = nil, heartbeatAt: String? = nil) {
        self.appId = appId
        self.kind = kind
        self.state = state
        self.summary = summary
        self.http = http
        self.jobs = jobs
        self.queue = queue
        self.restarts = restarts
        self.heartbeatAt = heartbeatAt
    }
}

public enum ScreenshotTargetKind: String, Codable, Equatable, Sendable {
    case web = "web"
    case iosSimulator = "ios-simulator"
    case desktop = "desktop"
}

public struct ScreenshotTarget: Codable, Equatable, Sendable {
    public var kind: ScreenshotTargetKind
    public var url: String?
    public var device: String?

    public init(kind: ScreenshotTargetKind, url: String? = nil, device: String? = nil) {
        self.kind = kind
        self.url = url
        self.device = device
    }
}

public struct Screenshot: Codable, Equatable, Sendable {
    public var id: String
    public var taskId: String
    public var target: ScreenshotTarget
    public var takenAt: String
    public var image: String
    public var markup: Markup?

    public init(id: String, taskId: String, target: ScreenshotTarget, takenAt: String, image: String, markup: Markup? = nil) {
        self.id = id
        self.taskId = taskId
        self.target = target
        self.takenAt = takenAt
        self.image = image
        self.markup = markup
    }
}

public enum MarkupTool: String, Codable, Equatable, Sendable {
    case pen = "pen"
    case arrow = "arrow"
}

public enum MarkupColor: Int, Codable, Equatable, Sendable {
    case first = 0
    case second = 1
    case third = 2
}

// A point is a JSON pair, not an object with x/y keys.
public struct MarkupPoint: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
    public init(from decoder: Decoder) throws {
        var values = try decoder.unkeyedContainer()
        x = try values.decode(Double.self)
        y = try values.decode(Double.self)
        guard values.isAtEnd else {
            throw DecodingError.dataCorruptedError(in: values, debugDescription: "Expected two coordinates")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.unkeyedContainer()
        try values.encode(x)
        try values.encode(y)
    }
}

public struct MarkupStroke: Codable, Equatable, Sendable {
    public var tool: MarkupTool
    public var color: MarkupColor
    public var points: [MarkupPoint]

    public init(tool: MarkupTool, color: MarkupColor, points: [MarkupPoint]) {
        self.tool = tool
        self.color = color
        self.points = points
    }
}

public struct MarkupText: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var text: String
    public var color: MarkupColor

    public init(x: Double, y: Double, text: String, color: MarkupColor) {
        self.x = x
        self.y = y
        self.text = text
        self.color = color
    }
}

public struct Markup: Codable, Equatable, Sendable {
    public var strokes: [MarkupStroke]
    public var texts: [MarkupText]

    public init(strokes: [MarkupStroke], texts: [MarkupText]) {
        self.strokes = strokes
        self.texts = texts
    }
}

public enum AttachmentKind: String, Codable, Equatable, Sendable {
    case photo = "photo"
    case file = "file"
    case screenshot = "screenshot"
    case projectFile = "project-file"
}

public struct Attachment: Codable, Equatable, Sendable {
    public var kind: AttachmentKind
    public var name: String
    public var bytes: Double
    public var ref: String

    public init(kind: AttachmentKind, name: String, bytes: Double, ref: String) {
        self.kind = kind
        self.name = name
        self.bytes = bytes
        self.ref = ref
    }
}

public struct ReportSection: Codable, Equatable, Sendable {
    public var title: String
    public var body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }
}

public struct YouEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var text: String
    public var attachments: [Attachment]
    public var model: String?

    public init(id: String, at: String, text: String, attachments: [Attachment], model: String? = nil) {
        self.id = id
        self.at = at
        self.text = text
        self.attachments = attachments
        self.model = model
    }
}

public struct ReplyEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var agent: AgentId
    public var paragraphs: [String]

    public init(id: String, at: String, agent: AgentId, paragraphs: [String]) {
        self.id = id
        self.at = at
        self.agent = agent
        self.paragraphs = paragraphs
    }
}

public struct WorkLogEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var summary: String
    public var steps: [WorkStep]
    public var live: Bool

    public init(id: String, at: String, summary: String, steps: [WorkStep], live: Bool) {
        self.id = id
        self.at = at
        self.summary = summary
        self.steps = steps
        self.live = live
    }
}

public struct DecisionEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var inboxItemId: String

    public init(id: String, at: String, inboxItemId: String) {
        self.id = id
        self.at = at
        self.inboxItemId = inboxItemId
    }
}

public struct TaskEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var taskId: String

    public init(id: String, at: String, taskId: String) {
        self.id = id
        self.at = at
        self.taskId = taskId
    }
}

public struct ReleaseEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var releaseId: String

    public init(id: String, at: String, releaseId: String) {
        self.id = id
        self.at = at
        self.releaseId = releaseId
    }
}

public struct ScreenshotEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var screenshotId: String

    public init(id: String, at: String, screenshotId: String) {
        self.id = id
        self.at = at
        self.screenshotId = screenshotId
    }
}

public struct ReportEvent: Codable, Equatable, Sendable {
    public var id: String
    public var at: String
    public var title: String
    public var sections: [ReportSection]

    public init(id: String, at: String, title: String, sections: [ReportSection]) {
        self.id = id
        self.at = at
        self.title = title
        self.sections = sections
    }
}

// Encode the TypeScript discriminated union as flat objects with a kind key.
public enum ConversationEvent: Codable, Equatable, Sendable {
    case you(YouEvent)
    case reply(ReplyEvent)
    case worklog(WorkLogEvent)
    case decision(DecisionEvent)
    case task(TaskEvent)
    case release(ReleaseEvent)
    case screenshot(ScreenshotEvent)
    case report(ReportEvent)
    private enum CodingKeys: String, CodingKey { case kind }
    private enum Kind: String, Codable { case you, reply, worklog, decision, task, release, screenshot, report }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .you: self = .you(try YouEvent(from: decoder))
        case .reply: self = .reply(try ReplyEvent(from: decoder))
        case .worklog: self = .worklog(try WorkLogEvent(from: decoder))
        case .decision: self = .decision(try DecisionEvent(from: decoder))
        case .task: self = .task(try TaskEvent(from: decoder))
        case .release: self = .release(try ReleaseEvent(from: decoder))
        case .screenshot: self = .screenshot(try ScreenshotEvent(from: decoder))
        case .report: self = .report(try ReportEvent(from: decoder))
        }
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .you(let value):
            try values.encode(Kind.you, forKey: .kind)
            try value.encode(to: encoder)
        case .reply(let value):
            try values.encode(Kind.reply, forKey: .kind)
            try value.encode(to: encoder)
        case .worklog(let value):
            try values.encode(Kind.worklog, forKey: .kind)
            try value.encode(to: encoder)
        case .decision(let value):
            try values.encode(Kind.decision, forKey: .kind)
            try value.encode(to: encoder)
        case .task(let value):
            try values.encode(Kind.task, forKey: .kind)
            try value.encode(to: encoder)
        case .release(let value):
            try values.encode(Kind.release, forKey: .kind)
            try value.encode(to: encoder)
        case .screenshot(let value):
            try values.encode(Kind.screenshot, forKey: .kind)
            try value.encode(to: encoder)
        case .report(let value):
            try values.encode(Kind.report, forKey: .kind)
            try value.encode(to: encoder)
        }
    }
}
