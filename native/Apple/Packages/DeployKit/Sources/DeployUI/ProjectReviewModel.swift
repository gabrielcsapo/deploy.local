import Foundation
import Observation
import DeployCore

/// Project issues, pull requests and pipelines share one model so actions update the screen at once
/// and the coordinator's answer replaces the prediction on the next refresh.
@Observable @MainActor
final class ProjectReviewModel {
    let projectId: String
    let connection: Connection
    var section: String
    var selected = ""
    private(set) var items: [ProjectWorkItem] = []
    private(set) var detail: ProjectWorkResponse?
    private(set) var comparison: PullComparison?
    private(set) var repository: RepositoryInfo?
    /// Every pipeline run of the project, newest first, to find the run a merge produced.
    private(set) var runs: [ProjectWorkItem] = []
    /// Jobs for the pipeline runs shown on screen, keyed by run ID.
    private(set) var jobs: [String: [WorkspaceJob]] = [:]
    private(set) var commits: [RepositoryCommit] = []
    var error: String?
    private(set) var busy = false
    private(set) var loaded = false
    // Predictions shown until the coordinator confirms them.
    private(set) var requestedMerge = false
    private var awaitedMergeOperation: String?
    private var predictedStatus: (id: String, status: String)?
    private(set) var pendingComment: ProjectComment?
    private(set) var startingChecks = false
    /// The run "Run pipeline" just started: it leads the list, highlighted, until you open another record.
    private(set) var startedRun: ProjectWorkItem?
    private var pendingCommands: [String: String] = [:]
    /// A failed refresh reports its error; the next successful refresh clears it. Action errors stay until the next action.
    private var errorFromRefresh = false
    private var commitsHead = ""

    init(projectId: String, connection: Connection, section: String = "repository", selected: String = "") {
        self.projectId = projectId
        self.connection = connection
        self.section = section
        self.selected = selected
    }

    private var base: String { "/api/workspace/projects/\(projectId)" }
    var branches: [String] { repository?.branches ?? [] }

    /// The selected record with any local prediction applied.
    var record: ProjectWorkItem? {
        guard let record = detail?.record ?? detail?.pipeline else { return nil }
        if let predictedStatus, predictedStatus.id == record.id, predictedStatus.status != record.status { return record.with(status: predictedStatus.status) }
        return record
    }
    var phase: PullPhase? {
        guard section == "pulls", let record else { return nil }
        let awaiting = awaitedMergeOperation.map { $0 != record.mergeOperationId } ?? false
        return pullPhase(record: record, operation: detail?.mergeOperation, requestedMerge: requestedMerge || awaiting)
    }
    var checks: [ProjectWorkItem] { detail?.checks ?? [] }
    var checkResult: ReviewCheckSummary { checkSummary(runs: checks, headCommit: comparison?.headCommit) }
    var mergeability: PullMergeability { pullMergeability(comparison) }
    var mergeResult: ProjectWorkItem? { resultingPipeline(runs: runs, mergedCommit: record?.mergedCommit) }
    var comments: [ProjectComment] { (detail?.comments ?? []) + (pendingComment.map { [$0] } ?? []) }
    /// The rows the list shows: for pipelines, a just-started run leads before the coordinator lists it.
    var listItems: [ProjectWorkItem] { section == "pipelines" ? pipelineRuns(items, showing: startedRun) : items }
    /// Poll briskly only while something is visibly in motion.
    var pollInterval: Duration {
        let active: Set<String> = ["queued", "waiting", "running", "cancelling"]
        if phase == .merging || startingChecks || checks.contains(where: { active.contains($0.status) }) { return .milliseconds(800) }
        if let result = mergeResult, active.contains(result.status) || active.contains(result.deployment?.status ?? "") { return .seconds(1.5) }
        if section == "pipelines", let record, active.contains(record.status) { return .seconds(1.5) }
        if section == "pipelines", selected.isEmpty, pipelineRunsInMotion(listItems) { return .seconds(1.5) }
        return .seconds(2.5)
    }

    func select(_ id: String) {
        guard selected != id else { return }
        if !id.isEmpty && id != startedRun?.id { startedRun = nil }
        selected = id
        detail = nil; comparison = nil; commits = []; commitsHead = ""
        requestedMerge = false; awaitedMergeOperation = nil; predictedStatus = nil; pendingComment = nil; startingChecks = false
    }
    func show(section next: String) {
        guard section != next else { return }
        section = next
        items = []; loaded = false; error = nil; startedRun = nil
        select("")
    }

    // MARK: Actions

    func create(title: String, body: String, source: String, target: String, taskIds: [String]) async -> Bool {
        var payload: [String: JSONValue] = section == "pipelines" ? ["ref": .string(target)] : ["title": .string(title), "body": .string(body)]
        if section == "pulls" {
            payload["sourceBranch"] = .string(source); payload["targetBranch"] = .string(target)
            payload["taskIds"] = .array(taskIds.map { .string($0) })
        }
        guard let result: ProjectWorkItem = await perform({ try await self.request("/\(self.section)", body: payload) }) else { return false }
        if section == "pipelines" {
            // Close the composer at once and show the new run at the top of the list with live status;
            // the list refresh follows in the background instead of holding the composer open.
            select("")
            startedRun = result
            Task { await refresh() }
            return true
        }
        select(result.id)
        await refresh()
        return true
    }
    func update(title: String, body: String) async -> Bool {
        guard let record else { return false }
        let payload: [String: JSONValue] = ["title": .string(title), "body": .string(body), "revision": .number(Double(record.revision ?? 0))]
        let result: ProjectWorkItem? = await perform { try await self.request("/\(self.section)/\(record.id)/update", body: payload) }
        await refresh()
        return result != nil
    }
    func setOpen(_ open: Bool) async {
        guard let record else { return }
        predictedStatus = (record.id, open ? "open" : "closed")
        let result: ProjectWorkItem? = await perform {
            try await self.request("/\(self.section)/\(record.id)/\(open ? "reopen" : "close")", body: ["revision": .number(Double(record.revision ?? 0))])
        }
        if result == nil { predictedStatus = nil }
        await refresh()
    }
    func merge() async {
        guard let record, let comparison else { return }
        requestedMerge = true
        let result: ProjectWorkItem? = await perform {
            try await self.request("/pulls/\(record.id)/merge", body: [
                "revision": .number(Double(record.revision ?? 0)),
                "baseCommit": .string(comparison.baseCommit), "headCommit": .string(comparison.headCommit),
            ])
        }
        awaitedMergeOperation = result?.mergeOperationId
        requestedMerge = false
        await refresh()
    }
    func retryMerge() async {
        guard let record else { return }
        requestedMerge = true
        let _: ProjectWorkItem? = await perform { try await self.request("/pulls/\(record.id)/retry-merge", body: ["revision": .number(Double(record.revision ?? 0))]) }
        requestedMerge = false
        await refresh()
    }
    func runChecks() async {
        guard let record else { return }
        startingChecks = true
        let _: ProjectWorkItem? = await perform { try await self.request("/pipelines", body: ["pullId": .string(record.id)]) }
        startingChecks = false
        await refresh()
    }
    func comment(_ text: String) async -> Bool {
        guard let record else { return false }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return false }
        pendingComment = ProjectComment(id: "pending", author: connection.username, body: body,
                                        createdAt: Date().formatted(.iso8601))
        let result: ProjectComment? = await perform { try await self.request("/\(self.section)/\(record.id)/comments", body: ["body": .string(body)]) }
        await refresh()
        pendingComment = nil
        return result != nil
    }
    func startTask() async -> String? {
        guard let record else { return nil }
        let result: IssueTaskResponse? = await perform { try await self.request("/issues/\(record.id)/task", body: ["revision": .number(Double(record.revision ?? 0))]) }
        await refresh()
        return result?.task.id
    }
    func cancelPipeline() async {
        guard let record else { return }
        let _: ProjectWorkItem? = await perform { try await self.request("/pipelines/\(record.id)/cancel", body: [:]) }
        await refresh()
    }
    func retryRepository() async {
        let _: JSONValue? = await perform { try await self.request("/repository/retry", body: [:]) }
        await refresh()
    }

    /// Compare two branches with bounded histories and the repository diff endpoint.
    func preview(source: String, target: String) async throws -> (BranchComparison, String) {
        let sourceRef = Self.encode("refs/heads/" + source), targetRef = Self.encode("refs/heads/" + target)
        let sourceHistory: RepositoryHistory = try await request("/repository/history?ref=\(sourceRef)&limit=100")
        let targetHistory: RepositoryHistory = try await request("/repository/history?ref=\(targetRef)&limit=100")
        let comparison = compareBranches(source: sourceHistory.commits, target: targetHistory.commits)
        guard let base = comparison.mergeBase, !comparison.ahead.isEmpty else { return (comparison, "") }
        let diff: RepositoryDiff = try await request("/repository/diff?ref=\(sourceRef)&base=\(base)")
        return (comparison, diff.patch)
    }

    private static func encode(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value }

    // MARK: Loading

    func refresh() async {
        let expectedSection = section, expectedSelection = selected
        do {
            let info: RepositoryInfo = try await request("/repository"); repository = info
            if errorFromRefresh { error = nil; errorFromRefresh = false }
            if expectedSection == "repository" { loaded = true; return }
            let response: ProjectWorkResponse = try await request("/\(expectedSection)")
            guard section == expectedSection else { return }
            items = response.items ?? response.runs ?? []
            if expectedSection == "pipelines" { runs = items }
            loaded = true
            guard !expectedSelection.isEmpty else { return }
            let next: ProjectWorkResponse = try await request("/\(expectedSection)/\(expectedSelection)")
            guard section == expectedSection, selected == expectedSelection else { return }
            detail = next
            if let predicted = predictedStatus, next.record?.status == predicted.status { predictedStatus = nil }
            if let awaited = awaitedMergeOperation, next.record?.mergeOperationId == awaited { awaitedMergeOperation = nil }
            if expectedSection == "pulls" { await refreshPull(expectedSelection, next) }
        } catch { if !Task.isCancelled { self.error = describe(error); errorFromRefresh = true } }
    }

    private func refreshPull(_ id: String, _ next: ProjectWorkResponse) async {
        do {
            let diff: PullComparison = try await request("/pulls/\(id)/diff")
            guard selected == id else { return }
            if comparison != diff { comparison = diff }
            if commitsHead != diff.headCommit {
                let history: RepositoryHistory = try await request("/repository/history?ref=\(diff.headCommit)&limit=50")
                guard selected == id else { return }
                commits = Array(history.commits.prefix { $0.oid != diff.mergeBase })
                commitsHead = diff.headCommit
            }
        } catch { if !Task.isCancelled && selected == id { self.error = describe(error); errorFromRefresh = true } }
        // Runs are needed for the merge result; job details for the newest checks and that result.
        if next.record?.status == "merged" || next.mergeOperation != nil {
            if let response: ProjectWorkResponse = try? await request("/pipelines") { runs = response.runs ?? [] }
        }
        var visible = Array((next.checks ?? []).prefix(3).map(\.id))
        if let result = mergeResult { visible.append(result.id) }
        for run in visible {
            if let response: ProjectWorkResponse = try? await request("/pipelines/\(run)"), let runJobs = response.jobs {
                if jobs[run] != runJobs { jobs[run] = runJobs }
            }
        }
    }

    // MARK: Transport

    private func perform<T>(_ work: @escaping @MainActor () async throws -> T) async -> T? {
        guard !busy else { return nil }
        busy = true; error = nil; errorFromRefresh = false
        defer { busy = false }
        do { return try await work() } catch { self.error = describe(error); return nil }
    }

    private func describe(_ error: Error) -> String {
        if case ClientError.response(_, let message) = error { return message }
        return error.localizedDescription
    }

    func request<T: Decodable & Sendable>(_ path: String, body: [String: JSONValue]? = nil) async throws -> T {
        let client = WorkspaceClient(connection: connection)
        var payload = body
        var key: String?
        if let body {
            // Retrying the same command reuses its operation ID, so the coordinator replays instead of repeating it.
            let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
            let signature = path + String(data: try encoder.encode(body), encoding: .utf8)!
            key = signature
            let operation = pendingCommands[signature] ?? UUID().uuidString
            pendingCommands[signature] = operation
            payload?["operationId"] = .string(operation)
        }
        let result: T = try await client.request(base + path, method: payload == nil ? "GET" : "POST", body: try payload.map { try JSONEncoder().encode($0) })
        if let key { pendingCommands.removeValue(forKey: key) }
        return result
    }
}
