# Update from main

Open a task's Changes view and choose **Update from main**, next to publication.
A behind or conflicting pull request also offers this action for its linked task.
For a pull request targeting another branch, the action uses that target instead of
main. No caller can choose a different project, branch, URL or commit.

Agents can call `deploy_update_base({ operationId })` when asked to update or when
publication reports that the target moved. Pause edits while the update is pending;
use `action: "status"` to read progress. Each new action needs a new operation ID;
retrying the same request uses the same ID.

The coordinator snapshots the task's files into retained Git objects and merges the
pinned target tip. The task computer fetches these objects using its existing
repository read permission, outside the agent sandbox. It installs the merge and
acknowledges the new baseline. Checkpoints then measure changes against that merged
workspace, while review diffs compare against the target tip. The next publication
continues the existing source branch with both histories as ancestors.

Conflicts remain as files in the workspace, with paths recorded on the task. An
owner-triggered conflict starts a resolving run using the task's previous provider
settings. After resolving the files, call `action: "continue"`; publication stays
blocked until resolution finishes. **Abort update** (`action: "abort"`) restores the
pre-update files, index, HEAD and baseline, including unpublished files and deletions.

Plans and worker installation journals survive interrupted requests. Resume a
failed update with `continue`, or abort it. Command generations fence stale worker
acknowledgements so an old update cannot complete a newer abort. Capture a fresh
checkpoint after a successful update; pre-update checkpoints cannot publish over
the merged target. Remote Linux and macOS workers need the worker version that
advertises `deploy_update_base`.
