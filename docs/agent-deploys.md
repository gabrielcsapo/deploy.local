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

1. Capture `deploy_checkpoint` after edits. Check its exclusions: checkpoints contain
   at most 8 MiB and exclude ignored files, symlinks and common credential files.
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

A completed tool call appends a compact Markdown transcript attachment containing
app name, status, URL and **View logs**. It uses the existing message/blockquote
styles on web, Mac and iOS; no separate transcript renderer is required.

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
