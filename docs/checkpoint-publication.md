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

`fileCount` is how many files the checkpoint carries: every workspace file for a
full-tree checkpoint, and the changed files for a delta. `changedFileCount` is measured
against the task's diff base in both cases.

Task detail includes `latestCheckpoint`: `id`, `createdAt`, `fileCount`, `fresh`,
and a nullable `reason`. Web and native review use it to offer a single
“Publish latest checkpoint” action for truncated or excluded diffs, or explain
why a checkpoint cannot be used. Normal complete diffs retain patch publishing.

## The agent names its change, and checks belong to it

`deploy_checkpoint` takes an optional `title` (one imperative line, at most 72 characters) and
`summary` (Markdown). They are stored on the checkpoint and returned with its id.
`taskPublishDefaults` prefers them: the title over one derived from the request, and the summary
over the agent's final message or a description of the commit's shape. A derived title is
shortened at a clause boundary instead of being cut off with an ellipsis (see
`shortenTitle` in `shared/task-title.ts`), which also sets the commit subject.

A pull request reports only the checks and jobs that ran against the version it publishes.
`publishHead` names that version: the task's latest checkpoint while nothing has run or changed
after it, otherwise only the current edit watermark. A job carries the `digest` of the
checkpoint it ran against, and a check carries the edit watermark of the workspace it read
(`editWatermark`), so a re-capture of an unchanged tree keeps its jobs current while an edit
moves everything before it into "Earlier runs (n)". Earlier runs keep their results and never
count towards the pull request's status; when nothing ran against the head, the description,
the web pull request panel and native PullReview all say "No checks ran on this version" rather
than show a stale pass or failure. In the pull request surfaces the same rule applies to
pipeline runs, keyed by the head commit.

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
Eligible complete checkpoints already carry immutable file contents, so publication can
use that tree without depending on the displayed patch. In a repository conversation a
checkpoint carries its changes against a base commit rather than every file (see
[Checkpoint deltas](checkpoint-deltas.md)); publication builds the base tree and applies
the delta, so the published tree is the same either way and the limit is 64 MiB of
changed content instead of 8 MiB of workspace.
