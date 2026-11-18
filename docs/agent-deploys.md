# Deploy applications from a coding task

When you ask an agent to deploy, it uses `deploy_application` on the coordinator.
It does not need Docker, sudo, a user API token, or a listening server on its worker.
The normal deploy.local upload pipeline builds the app, chooses its deployment
computer, publishes its `.local` routes and TLS, and emits deployment notifications.
Events and build logs identify the owner and triggering task.

Write `deploy.yaml` at the application root, for example:

```yaml
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: my-app
components:
  web:
    build:
      context: .
    interfaces:
      http:
        protocol: http
        port: 3000
routes:
  public:
    to: web.http
```

The Dockerfile in the build context is used. Add multiple components for a backend,
frontend, database or worker. Declare secrets under `configuration` and have the user
supply values in deploy.local; do not put credentials in source. Required values
that have not been supplied prevent startup and are reported in the build log.

1. Capture `deploy_checkpoint` after edits. Check its exclusions: checkpoints exclude
   ignored files, symlinks and common credential files. In a repository conversation a
   checkpoint carries only the changes over its base commit (see
   [Checkpoint deltas](checkpoint-deltas.md)); the coordinator materializes base plus
   delta before bundling, so the build still sees the whole tree.
2. Call `deploy_application` with `{ operationId, checkpointId, path?, name? }`.
   `path` defaults to `.` and selects the checkpoint subdirectory containing
   `deploy.yaml`. `name`, when provided, must exactly match `metadata.name`.
   The coordinator restores a fresh copy and uses the CLI's shared bundle file rules.
3. Wait for the result: `{ status: running|failed, url, routes, deploymentId, logTail? }`.
   `deploymentId` is the exact build-log ID; it is null if no build was admitted.
   A rejected checkpoint without a valid manifest has an empty URL and routes.
   Failure output includes the reason and up to approximately 60 bounded log lines,
   with configured secrets and common credential patterns redacted.
4. Verify the returned HTTPS URL from **another online computer** using
   `deploy_run_job`, for example `curl --fail --show-error https://my-app.local`.
   Use its system CA; never disable TLS verification. Collect the job result and
   report the URL. If another computer is unavailable, report verification as pending.
5. On failure, read `logTail`, fix the app, capture a new checkpoint, and deploy with
   a new operation ID. Inspect the app before retrying a timed-out or interrupted
   upload: its detached build may still finish.

New application names are allowed. An existing app can be redeployed only if its
last deployment attempt belongs to this task and owner. Provenance is tied to the
application identity, exact build and source artifact: a manual deploy, another
task, or a delete/recreate invalidates that authority. Failed first attempts are
also attributed so the same task can fix and retry its own app. Success updates
the retained `{ app, taskId, owner }` provenance. Other existing apps are refused;
the agent must ask via `deploy_ask_user`, and the user must perform that existing
application's deployment. Asking does not silently grant overwrite authority.
The agent must not evade this refusal by picking another application's name.

Placement, build admission/queueing, migration, repository ancestry, fleet and
destructive-change gates run in the existing upload handler. No confirmation,
revision replacement or placement override is supplied automatically. If a gate
requires user action, the result explains the failure. For graph changes, include
an up-to-date `# deploy.local/base: sha256:…` directive obtained from the current
exported manifest, as with CLI repository deployment.

The coordinator issues a 60-second, single-use capability for a fixed loopback
upload as the owner. It authorizes only the selected app and unconfirmed detached
upload fields. The capability never reaches the agent and cannot call other APIs.
The owner-scoped operation reservation prevents identical retries from deploying
twice. Build/start polling has a ten-minute overall deadline. Short coordinator requests keep
the original tool call waiting without crossing the proxy idle timeout. After coordinator
restart, a known exact build can be polled again; an interrupted upload without a
known build is never submitted again automatically.

In the task's chat a deploy is one step in the work log: "Deploying drop" with a spinner, then
"Deployed drop · Live at drop.local" or "Deployed drop · Failed: health check", with its time and
**View logs**. A failed step opens to the platform's reason and the last log lines. A completed call
still stores a compact Markdown summary message (`deployment:<id>`) for older clients; conversation
events leave it out so the step is not repeated. Jobs read the same way: the job's name, then
"Passed on SER" or "Failed on SER (exit 1)", with **Output**. See `server/features/agents/work-steps.ts`.

## Bring files back from a job

`deploy_run_job` accepts `artifacts`, a list of up to 20 `{ path, caption? }` entries.
Paths are relative to the job's working directory; `*` and `?` match within one folder
and a single `**` segment spans folders, for example
`[{ "path": "shots/*.png", "caption": "Home screen" }, { "path": "build.log" }]`.
Use this instead of printing, `cat`-ing or base64-encoding files into job output, which
is capped at the last 64,000 characters and costs model tokens.

When the job ends, on any outcome including failure and timeout, the worker resolves the
paths inside its isolated copy and streams each file over its own authenticated channel
(`POST /api/workers/:id/jobs/:jobId/artifacts`). Only regular files whose real
path stays inside the job directory are returned: `..`, absolute paths and symlinks that
escape are refused. The coordinator accepts uploads only from the worker process running
that job generation, and only for paths the agent requested.

| Kind   | Accepted                                                                  | Limit per file |
| ------ | ------------------------------------------------------------------------- | -------------- |
| Images | PNG, JPEG, GIF, WebP (checked by content)                                 | 20 MB          |
| Videos | MP4, MOV, WebM (checked by content)                                       | 25 MB          |
| Text   | UTF-8 `.txt`, `.log`, `.json`, `.xml`, `.md`, `.csv`, `.yaml` and similar | 5 MB           |

At most 20 files and 100 MB are stored per job; the task's attachment storage limit also
applies. Text artifacts are stored as plain text with common credential patterns redacted
(`key=value` secrets, URL credentials, JSON secret fields, bearer tokens, private keys and
well-known token formats). Other binary files are skipped. Anything that is not stored is
listed with a `skipped` reason; it never fails the job.

`deploy_get_job` returns `artifacts: [{ path, name, caption, attachmentId, kind, bytes }]`
or `{ path, name, caption, skipped }` entries. These are references only, never file
contents. To show an image or video in the reply, the agent writes
`![caption](/api/attachments/<attachmentId>)`. To inspect a log, it calls
`deploy_read_artifact { attachmentId, offset?, maxBytes? }`, which returns at most
16 KB of text per call with `totalBytes` and `nextOffset`. Images and videos cannot be
read through that tool.

The Activity tab on web, Mac and iPhone lists each job's artifacts: thumbnails open the
media viewer, and text artifacts open a preview.

Workers advertise the `job-artifacts` capability. A job with artifacts is refused when its
chosen computer, or every eligible computer, runs an older worker; the error tells the
agent to update deploy.local on that computer (the deploy.local Worker app on a Mac, or the
deploy.local node app on Linux). A requirement-based job never lands on an older worker.

## Repository pipeline deployments

A successful owner pipeline can deploy its pinned source, including the first
application deployment. Declare `pipeline.deploy.application` matching the app's
`metadata.name`. Optional `pipeline.deploy.path` (default `.`) selects the repository
subdirectory containing the application's `deploy.yaml`; the pipeline definition
itself remains in the repository-root `deploy.yaml`.

The coordinator reconstructs the pinned commit with `git archive`, expands and
verifies Git LFS objects, then bundles the selected app root using the same file
rules as the CLI and agent tool. Job output and worker checkouts are never deployed.
Submodules, archived links and unsafe paths are rejected. Full uploads support
multiple components, durable volumes, jobs, configuration, and normal placement,
admission, migration and destructive-change checks. No confirmation flags are set.

Only the repository owner's pipelines run, as that owner. A new app name is allowed;
an existing app must have current provenance from the same owner's repository.
Pipeline and task deployments retain `{ app, projectId, owner }` plus the application
identity, exact build and source artifact. Failed admitted builds retain provenance
so the same repository can fix them. Another repository, another owner, or a later
unassociated manual deploy invalidates that authority.

To associate an existing app explicitly, deploy it yourself from the repository's
app directory with `deploy deploy -a <application> --project <project-id>` (the hosted
repository ID appears in its dashboard URL). This uses your normal authenticated
CLI upload, including any confirmations or configuration you must resolve manually.
The coordinator checks that you own the repository. Task deploys from that repository
also establish provenance. A matching name or manifest alone grants no authority.

Existing CI-managed apps may retain the faster CI release path only when `ciTarget`
accepts their healthy graph, the app root is `.`, and the submitted graph is unchanged
and has no volume resources. All other apps use `/api/upload` with a 60-second,
single-use loopback capability. Capability hashes are shared between the pipeline
worker and control process; tokens never enter execution jobs. Both paths recheck
repository provenance at upload admission.

The pipeline step shows **Deploying**, then **Running** and the app URL. Failures show
the reason and direct the owner to deploy manually. **View application** links to the
app; **View logs** appears only when an exact build ID exists. Missing secrets,
destructive changes and other human gates fail the step without auto-confirmation.
An admitted build is polled by its exact ID for up to ten minutes. Lost upload
responses can recover that identity; an interrupted upload with no known identity
is never resubmitted automatically. Inspect the app and deploy manually before retrying.
