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

Verification an agent runs in its own workspace counts as a check (`verificationRun` in
`server/workspace/workspace-verification.ts`), including the piped form agents use in practice:
`2>&1` and one trailing `| tail -N` or `| head -N`. Any other pipe, write or redirection is
still an edit rather than a check. A pipe makes the shell report the last stage, so the exit
code is `tail`'s; the result is then read from the captured output tail instead
(`verificationOutcome`), and the few scrubbed lines it was read from are kept on the record.
`set -o pipefail` restores the exit code. Output that does not say how the run ended records as
"Result unknown (output piped)" in the description, the web panel and native PullReview, and
counts towards neither a pass nor a failure.

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

## Storage and recovery lifecycle

`coordination.ts` validates authenticated `deploy_checkpoint` captures, pins delta bases
with `retainCheckpointBase`, and saves the checkpoint in the workspace records table.
`update-base.ts` also creates an empty delta over the installed merge commit. A snapshot
contains base64 file bytes, paths, executable flags, exclusions, a content digest and,
for deltas, a base commit and deleted paths. Its content digest is not a hash of the
entire serialized snapshot (exclusions are not part of it).

Full bodies are consumed by checkpoint commit/publication, application deployment,
job assignment/restore, and the latest-checkpoint changed-file comparison. Task history,
published check attribution, publication freshness and Git ref retention need only
record metadata plus snapshot digest, base commit, exclusion count and file count.

`checkpoint-retention.ts` currently deletes only known Git base refs, never checkpoint
records or bodies. It protects active jobs, incomplete deployments, open tasks and
unpublished captures newer than the published checkpoint. Ref deletion compares the
expected base commit. A delta body is not independently restorable without its Git
base; keeping the body does not itself keep the base alive.

Rsync backs up the whole data directory, substituting SQLite online backups for live
databases. Offline `workspace/recovery.ts` inventories and verifies the complete
workspace directory, requires stopped workers/idle operations, and restores only at
the original path. Encrypted `recovery-bundle.ts` instead selects databases and a
limited set of files; external checkpoint bodies must be added to that selection.
The worker job transport sends a materialized snapshot, not the underlying database
row. Self-update database
snapshots stay alongside the unchanged data directory; they are not independent
workspace exports.

Closed tasks have `closedAt`, and reopening clears it. Task publication and workspace
commit IDs, linked pull requests, pending merges/base updates, active jobs and
incomplete deployments matter to retention. Existing ref retention is not evidence
that a snapshot body is disposable: unpublished work can be the only surviving copy.

## Metadata reads and external snapshot storage

Checkpoint metadata reads use SQL JSON projections in `workspace/store.ts`, with an
owner/task partial index in workspace.db. Task history, publication freshness and
naming, published check attribution, job/deployment reservations, and Git ref cleanup
do not load snapshot bodies. The projected evidence includes content digest, base
commit, file count, exclusion count, and base-update provenance. The latest-checkpoint
changed-file comparison still loads that one checkpoint because it compares file trees.
Offline recovery's idle check selects only operation kinds, excluding checkpoints.

A local generated database containing 100 old-form checkpoints with roughly 1 MiB
snapshots measured **59.01 ms before and 0.328 ms after** for a one-task checkpoint
lookup (median of five calls, Node 26.8.1). The old list/filter sent 104,893,780 bytes
through JSON.parse; the indexed metadata lookup sent 342 bytes. This measures the
checkpoint lookup, not a whole HTTP request. The regression also checks the query
plan, owner isolation, and that task detail/freshness never parse body contents.

New writes retain the serialized snapshot at
`workspace/blobs/sha256/<first-two-hex>/<sha256-hex>`. The record carries
`snapshotBlob: { digest, byteSize }` and `snapshotInfo` instead of `snapshot`.
The file digest covers the entire serialized snapshot, including exclusions; it is
separate from the existing tree/content digest used for jobs and publication.
Identical bodies share a file. A private temporary file is synced, atomically linked
without replacing an existing destination, and its directory entries synced before
the database write. Existing files are verified rather than overwritten.

`get('checkpoint', owner, id)` materializes and verifies the body, preserving the
existing publication, commit, deployment and worker-job contract. Inline snapshots
remain readable. Scheduled maintenance migrates at most eight old rows per pass,
stopping after processing 16 MiB (one row can cross that threshold) and yielding
between rows. A compare-and-update guards concurrent row changes. Failed writes or
rolled-back transactions leave old rows intact; an unreferenced file is harmless and
is deliberately not swept. No snapshot migration runs during startup.

Rsync includes this directory without new exclusions. Offline workspace recovery
copies and verifies it, and now rejects missing referenced bodies. Encrypted recovery
bundles select bodies from the **snapshotted** workspace database, verify them, and
verify references again on import/rehearsal. Tests round-trip mixed inline/external
records through all three backup paths. The encrypted bundle's existing 128 MiB
limit remains: it fails rather than omitting checkpoint bodies. Git repositories/base
objects are still necessary to restore deltas; adding the bodies does not turn the
encrypted control-state bundle into a complete Git/worktree backup.

Migration frees SQLite pages for reuse; it does not immediately shrink workspace.db
on disk. No full VACUUM, production migration, release, or garbage collection was run.
All coordinator processes reading the new records need the updated code; rollback
to code that only understands inline snapshots needs a compatible data restore.

## Snapshot expiry decision

No snapshot bodies are deleted by this change. Existing cleanup removes only known
Git checkpoint-base refs, immediately on close/merge and in the hourly sweep. It
preserves open tasks, active jobs, incomplete deployments, and unpublished captures,
but it has neither a 30-day snapshot policy nor a durable proof that a body is safe
to discard. Its existing ref deletion behavior is unchanged.

A follow-up can reopen a merged/done task and clear `closedAt`; the task's history
still names its old checkpoints. Task `publishedCheckpointId`,
`workspaceCommit.checkpointId`, linked pull requests, `pendingMergeCommit`, active
base updates, jobs, and incomplete deployments all need consideration. Pull requests
link tasks/commits rather than maintaining a complete snapshot-reference inventory.
An unpublished capture may be the only surviving copy, and merely retaining a delta
body does not retain its base Git object. I could not establish safe disposal for
every remaining reader/reference, so the requested conservative fallback applies:
no 30-day deletion or orphan-file sweep. A regression restores old unpublished
captures from both storage forms after ref cleanup, using fixed historical dates.

## Local verification limits

The storage tests cover inline-only database startup, bounded/yielding migration,
mixed-form reopen, deduplication, binary and executable restoration, rollback/write
failure, missing/corrupt files, and owner isolation. Existing real commit, publication,
delta/job, deployment, follow-up and base-update tests exercise the new stored form.

The MCP-to-HTTP remote-worker integration could not complete in this sandbox:
`worker-process.ts` calls `ps` to claim the worker lease and receives `EPERM` before
the worker starts. The remaining coordination tests were run with just that test
excluded. No production server or other worktree was contacted.
