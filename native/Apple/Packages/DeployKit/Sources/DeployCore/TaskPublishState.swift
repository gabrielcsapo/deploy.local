import Foundation

/// What the Changes card offers. A task is a conversation: after its pull request merges, the
/// merged pull request stays as history and new work publishes as a follow-up pull request.
/// Mirrors `taskPublishState` in the web dashboard.
public struct TaskPublishState: Equatable, Sendable {
    public let open: ProjectWorkItem?
    public let mergedPull: ProjectWorkItem?
    public let merged: Bool
    /// The fresh checkpoint to publish when the diff cannot carry the work (incomplete, or not yet
    /// uploaded against the task's current baseline).
    public let checkpoint: TaskCheckpointSummary?
    public let changed: Bool
    public let followUp: Bool
    public let reason: String?
    /// True when publishing cannot run for a reason other than the title.
    public let unavailable: Bool
    public let action: String

    public var pull: ProjectWorkItem? { open ?? mergedPull }
    /// Publish controls show before a merge, and after one only with new work.
    public var offersPublish: Bool { !merged || followUp }

    public init(taskStatus: String?, workspaceStatus: String?, pulls: [ProjectWorkItem],
                latestCheckpoint: TaskCheckpointSummary?, diff: TaskDiff?, working: Bool, busy: Bool, needsPublication: Bool = false) {
        let open = pulls.first { $0.status == "open" }
        let mergedPull = pulls.filter { $0.status == "merged" }.max { ($0.number ?? 0) < ($1.number ?? 0) }
        let merged = open == nil && (mergedPull != nil || taskStatus == "merged")
        self.open = open; self.mergedPull = mergedPull; self.merged = merged
        let incomplete = diff?.truncated == true || diff?.excluded?.isEmpty == false
        let pending = diff.map { $0.patch.isEmpty && $0.baselinePending == true } ?? false
        let checkpointChanges: Int? = latestCheckpoint.map { latest in
            if let count = latest.changedFileCount { return count }
            // Older coordinators: a checkpoint from before the merge holds only merged work.
            if merged, let mergedAt = mergedPull?.mergedAt { return latest.createdAt > mergedAt ? latest.fileCount : 0 }
            return latest.fileCount
        }
        let updated = open != nil && needsPublication
        let checkpoint = (incomplete || pending || updated) && latestCheckpoint?.fresh == true && (updated || checkpointChanges != 0) ? latestCheckpoint : nil
        self.checkpoint = checkpoint
        let changed = updated || checkpoint != nil || diff?.hasUnpublishedChanges == true
        let followUp = merged && changed
        self.changed = changed; self.followUp = followUp
        let since = mergedPull?.number.map { "since #\($0) merged" } ?? "since the merge"
        let nothingNew: String? = merged ? "No changes \(since)." : nil
        let notReady = workspaceStatus != nil && workspaceStatus != "ready"
        reason = {
            guard let diff else { return "Loading changes…" }
            if working { return "Wait for the active run or check to finish." }
            if notReady { return "Workspace is not ready." }
            if updated, checkpoint != nil { return "Main merged into this task — Update pull request." }
            if let checkpoint {
                return checkpoint.publishCaption(since: merged ? since : nil)
            }
            if incomplete || pending {
                if let latest = latestCheckpoint, latest.fresh, checkpointChanges == 0 { return nothingNew ?? "No changes to publish." }
                if let latest = latestCheckpoint { return latest.reason ?? "Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step" }
                return incomplete ? "The diff is incomplete. Ask the agent to capture a new checkpoint to publish the full change set." : diff.status
            }
            if diff.patch.isEmpty { return diff.status.contains("not been uploaded") ? diff.status : nothingNew ?? "No changes to publish." }
            if (open ?? mergedPull) != nil, !changed {
                return diff.hasUnpublishedChanges == false ? nothingNew ?? "No unpublished changes." : "Refresh changes to compare with the pull request."
            }
            return nil
        }()
        unavailable = busy || working || diff == nil || (checkpoint == nil && (incomplete || diff?.patch.isEmpty != false)) || notReady
        action = followUp ? "Publish follow-up" : updated ? "Update pull request" : checkpoint != nil ? "Publish latest checkpoint" : open != nil ? "Update pull request" : "Publish as pull request"
    }
}
