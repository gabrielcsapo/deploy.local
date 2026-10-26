import Foundation

public struct ProjectWorkItem: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String?
    public let number: Int?
    public let body: String?
    public let status: String
    public let revision: Int?
    public let sourceBranch: String?
    public let targetBranch: String?
    public let taskIds: [String]?
    public let commit: String?
    public let trigger: String?
    public let createdAt: String
    public let deployment: PipelineDeployment?
    // Fields the server already returns; all optional so older coordinators still decode.
    public let author: String?
    public let updatedAt: String?
    public let issueIds: [String]?
    public let pullId: String?
    public let taskId: String?
    public let ref: String?
    public let mergedCommit: String?
    public let mergedBaseCommit: String?
    public let mergedAt: String?
    public let mergeOperationId: String?
    public var displayTitle: String { title ?? "\(trigger == "manual" ? "Manual run" : trigger == "push" ? "Push" : trigger == "pull_request" ? "Pull request checks" : "Pipeline") \(commit?.prefix(7) ?? "")" }

    public init(id: String, title: String? = nil, number: Int? = nil, body: String? = nil, status: String,
                revision: Int? = nil, sourceBranch: String? = nil, targetBranch: String? = nil, taskIds: [String]? = nil,
                commit: String? = nil, trigger: String? = nil, createdAt: String = "", deployment: PipelineDeployment? = nil,
                author: String? = nil, updatedAt: String? = nil, issueIds: [String]? = nil, pullId: String? = nil,
                taskId: String? = nil, ref: String? = nil, mergedCommit: String? = nil, mergedBaseCommit: String? = nil,
                mergedAt: String? = nil, mergeOperationId: String? = nil) {
        self.id = id; self.title = title; self.number = number; self.body = body; self.status = status
        self.revision = revision; self.sourceBranch = sourceBranch; self.targetBranch = targetBranch; self.taskIds = taskIds
        self.commit = commit; self.trigger = trigger; self.createdAt = createdAt; self.deployment = deployment
        self.author = author; self.updatedAt = updatedAt; self.issueIds = issueIds; self.pullId = pullId
        self.taskId = taskId; self.ref = ref; self.mergedCommit = mergedCommit; self.mergedBaseCommit = mergedBaseCommit
        self.mergedAt = mergedAt; self.mergeOperationId = mergeOperationId
    }

    /// Return a copy with a locally predicted status, used until the coordinator confirms it.
    public func with(status next: String) -> ProjectWorkItem {
        ProjectWorkItem(id: id, title: title, number: number, body: body, status: next, revision: revision,
                        sourceBranch: sourceBranch, targetBranch: targetBranch, taskIds: taskIds, commit: commit,
                        trigger: trigger, createdAt: createdAt, deployment: deployment, author: author,
                        updatedAt: updatedAt, issueIds: issueIds, pullId: pullId, taskId: taskId, ref: ref,
                        mergedCommit: mergedCommit, mergedBaseCommit: mergedBaseCommit, mergedAt: mergedAt,
                        mergeOperationId: mergeOperationId)
    }
}
public struct PipelineDeployment: Decodable, Equatable, Sendable {
    public let application: String
    public let status: String
    public let releaseId: String?
    public let error: String?
    public let url: String?
    public let buildLogId: Int?
    public init(application: String, status: String, releaseId: String? = nil, error: String? = nil, url: String? = nil, buildLogId: Int? = nil) {
        self.url = url; self.buildLogId = buildLogId
        self.application = application; self.status = status; self.releaseId = releaseId; self.error = error
    }
}
public struct ProjectComment: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let author: String
    public let body: String
    public let createdAt: String
    public init(id: String, author: String, body: String, createdAt: String) {
        self.id = id; self.author = author; self.body = body; self.createdAt = createdAt
    }
}
public struct MergeOperation: Decodable, Equatable, Sendable {
    public let status: String
    public let error: String?
    public let headCommit: String?
    public init(status: String, error: String? = nil, headCommit: String? = nil) {
        self.status = status; self.error = error; self.headCommit = headCommit
    }
}
public struct ProjectWorkResponse: Decodable, Sendable {
    public let items: [ProjectWorkItem]?
    public let runs: [ProjectWorkItem]?
    public let record: ProjectWorkItem?
    public let pipeline: ProjectWorkItem?
    public let comments: [ProjectComment]?
    public let jobs: [WorkspaceJob]?
    public let mergeOperation: MergeOperation?
    public let checks: [ProjectWorkItem]?
}
public struct PullComparison: Decodable, Equatable, Sendable {
    public let baseCommit: String
    public let headCommit: String
    public let mergeBase: String
    public let patch: String
    public let fastForward: Bool
    public init(baseCommit: String, headCommit: String, mergeBase: String, patch: String, fastForward: Bool) {
        self.baseCommit = baseCommit; self.headCommit = headCommit; self.mergeBase = mergeBase
        self.patch = patch; self.fastForward = fastForward
    }
}
public struct RepositoryInfo: Decodable, Sendable {
    public let status: String
    public let clonePath: String
    public let sshClonePath: String?
    public let sshPort: Int?
    public let defaultBranch: String?
    public let refs: [RepositoryRef]?
    public let operation: MergeOperation?
    public struct RepositoryRef: Decodable, Sendable { public let name: String; public let oid: String }
    /// Build credential-free clone addresses from the same server fields as the web client.
    public func cloneURL(origin: String, ssh: Bool = false) -> URL? {
        guard let base = try? Connection(origin: origin, username: "", token: "").baseURL() else { return nil }
        let path = ssh ? sshClonePath : clonePath
        guard let path, path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        if ssh {
            guard let sshPort, (1...65535).contains(sshPort) else { return nil }
            var url = URLComponents()
            url.scheme = "ssh"; url.user = "git"; url.host = base.host; url.port = sshPort
            guard let decodedPath = path.removingPercentEncoding else { return nil }
            url.path = decodedPath
            return url.url
        }
        return URL(string: path, relativeTo: base)?.absoluteURL
    }
    public var branches: [String] { (refs ?? []).filter { $0.name.hasPrefix("refs/heads/") }.map { String($0.name.dropFirst(11)) } }
    public func oid(ofBranch branch: String) -> String? { refs?.first { $0.name == "refs/heads/" + branch }?.oid }
}
public struct RepositoryCommit: Decodable, Identifiable, Equatable, Sendable {
    public var id: String { oid }
    public let oid: String
    public let parents: [String]
    public let author: String
    public let date: String
    public let subject: String
    public init(oid: String, parents: [String] = [], author: String = "", date: String = "", subject: String = "") {
        self.oid = oid; self.parents = parents; self.author = author; self.date = date; self.subject = subject
    }
}
public struct RepositoryHistory: Decodable, Sendable {
    public let commit: String
    public let commits: [RepositoryCommit]
}
public struct RepositoryDiff: Decodable, Sendable {
    public let base: String?
    public let commit: String
    public let patch: String
}
public struct IssueTaskResponse: Decodable, Sendable { public let task: WorkspaceTask }
