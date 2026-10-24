# Publishing checkpoints

`POST /api/workspace/tasks/:id/publish` accepts an optional `checkpointId` alongside
`operationId` and the task `revision`. Without it, patch publication is unchanged.
With it, Publish builds the exact validated checkpoint tree, including binary bytes
and executable modes, on the task branch or the linked open pull request's source
branch. A moved branch with a different tree is refused rather than overwritten.
The commit uses `taskPublishDefaults`; PR editorial fields, publish receipts,
operation replay, events and push triggers follow the existing publish path.

Checkpoints are owner scoped and must have the authenticated task/run provenance
recorded by `deploy_checkpoint`. Publish refuses active runs/checks/jobs and
checkpoints with excluded files. The checkpoint must be no older than completed
runs (completion time, falling back to update time) or the latest remote diff's
coordinator receipt time. The same guard runs again inside the publication
transaction. Missing timestamps are treated conservatively.

Task detail includes `latestCheckpoint`: `id`, `createdAt`, `fileCount`, `fresh`,
and a nullable `reason`. Web and native review use it to offer a single
“Publish latest checkpoint” action for truncated or excluded diffs, or explain
why a checkpoint cannot be used. Normal complete diffs retain patch publishing.

## Timestamp limitation

The strict timestamp rule deliberately does not infer that an older checkpoint
matches a newer, truncated diff. In the current agent protocol, checkpoint tools
are authenticated only while a run is active. Run completion and the final diff
upload normally occur after the last agent checkpoint, making that checkpoint
stale under this rule. Asking the agent for another in-run checkpoint alone does
not resolve this ordering. Such a task needs a verified post-run capture protocol,
or a worker supporting `deploy_commit` to commit while its run is active. This
change does not retroactively certify the old worker's final snapshot as fresh.

## Worker upload limits

The existing 50,000-character remote patch/display limit is retained. Simply
raising it is not a contained fix: worker completion sends both task and turn
patches with other metadata, and the coordinator caps the whole request at
512,000 bytes. Binary patches and JSON escaping further increase wire size.
A full-patch transport needs separate bounded storage/upload and display handling.
Eligible complete checkpoints already carry immutable full file contents (up to
8 MiB), so publication can use that tree without depending on the displayed patch.
