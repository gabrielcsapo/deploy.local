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
