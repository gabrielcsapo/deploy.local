# Repositories created by task agents

`deploy_create_repository({ operationId, name, description? })` creates an owner-scoped
hosted repository through the same `queueProject` and repository runner as the dashboard.
Only conversations without a project can use it. Names are unique per owner, ignoring
case; a collision fails with the existing name. The task attaches immediately so setup
and any failure remain visible under that repository. Retry the identical operation ID
to continue setup or publication; a different request cannot reuse that ID.

The worker-side tool sets a credential-free HTTPS `origin`, captures current files using
the full-tree checkpoint rules (8 MiB, excluding ignored/private files and symlinks: there
is no hosted commit to measure against yet), and creates a commit whose parent is the
hosted repository's seed. Once that commit is installed, later checkpoints in the task are
a delta over it (see [Checkpoint deltas](checkpoint-deltas.md)). Explicit exclusions must be resolved
before publication. It preserves working files and switches Git metadata to `task/<id>`.
The authenticated agent tool protocol transfers a Git bundle to the coordinator, which
advances `main` only if it still equals that seed. This works for the local worker,
managed workers, and remote workers without giving agents enrollment credentials or
expanding workers' read-only Git HTTP access. A worker Git receipt and durable coordinator
reservation make retries reuse the same commit. A lost final response does not republish.
The task's baseline and the remote worker's assignment state update to the published commit.

**Direct-main rule:** only the initial publication performed by this tool may write
`main` directly. Subsequent iterations use the existing task publish/pull request flow,
even when the owner is the only contributor. An external change to `main` during setup
is a conflict; the tool never force-pushes over it. Initial publication queues the normal
push pipeline trigger and adds one compact repository link to the conversation.

The shared shipping instructions require repository creation first, then code and
`deploy.yaml`, checkpoint, suitable Mac/Xcode and Linux jobs, `deploy_application`, and
verification from other computers against `https://<name>.local`. Apple verification
executes the application's real client code to create and read back data; Linux checks
the deployed web app. Follow-up changes repeat build, deploy, verification and publication.
Reports identify the computers and link the repository, application and jobs. The
instructions never count queued work or unavailable computers as successful verification.
