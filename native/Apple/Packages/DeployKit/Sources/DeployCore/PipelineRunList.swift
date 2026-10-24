import Foundation

/// Statuses of a pipeline run, or its deployment, that are still moving.
public let activePipelineStatuses: Set<String> = ["queued", "waiting", "running", "cancelling", "deploying", "publishing", "ready"]

/// The Pipelines list right after "Run pipeline": the started run leads it until the
/// coordinator's listing includes it, and then the coordinator's copy (with live status) wins.
public func pipelineRuns(_ runs: [ProjectWorkItem], showing started: ProjectWorkItem?) -> [ProjectWorkItem] {
    guard let started, !runs.contains(where: { $0.id == started.id }) else { return runs }
    return [started] + runs
}

/// Whether any listed run is still in motion, so the list keeps polling for live status.
public func pipelineRunsInMotion(_ runs: [ProjectWorkItem]) -> Bool {
    runs.contains { activePipelineStatuses.contains($0.status) || activePipelineStatuses.contains($0.deployment?.status ?? "") }
}
