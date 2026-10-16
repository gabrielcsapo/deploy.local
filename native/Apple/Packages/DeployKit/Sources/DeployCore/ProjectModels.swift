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
    public var displayTitle: String { title ?? "\(trigger == "manual" ? "Manual run" : "Pipeline") \(commit?.prefix(7) ?? "")" }
}
public struct PipelineDeployment: Decodable, Equatable, Sendable {
    public let application: String
    public let status: String
    public let releaseId: String?
    public let error: String?
}
public struct ProjectComment: Decodable, Identifiable, Sendable {
    public let id: String
    public let author: String
    public let body: String
    public let createdAt: String
}
public struct MergeOperation: Decodable, Sendable {
    public let status: String
    public let error: String?
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
public struct PullComparison: Decodable, Sendable {
    public let baseCommit: String
    public let headCommit: String
    public let mergeBase: String
    public let patch: String
    public let fastForward: Bool
}
public struct RepositoryInfo: Decodable, Sendable {
    public let status: String
    public let clonePath: String
    public let defaultBranch: String?
    public let refs: [RepositoryRef]?
    public let operation: MergeOperation?
    public struct RepositoryRef: Decodable, Sendable { public let name: String; public let oid: String }
}
public struct IssueTaskResponse: Decodable, Sendable { public let task: WorkspaceTask }
