# Remote container server telemetry

Changes are uncommitted. No image-build code, screens, real data directories, SER, or live deploy.local were touched.

## Separate logical changes

1. **SER credential and ingestion boundary:** `server/telemetry-remote.ts`, `server/telemetry-schema.ts`, `server/api/fleet.ts`, and the shared bounded reader export in `server/telemetry-http.ts`. Authenticated deploy/recreate/project-release job claims issue a random deployment token and store only its hash, with a computer and app-owner grant. `POST /api/agent/telemetry/v1/server` requires the existing node ID/secret, then resolves attribution exclusively through the bearer token. It checks the computer grant and current deployment owner before calling the existing `ingestServer`. No body-supplied app name is accepted. Revoked computers, local-only tokens, forged tokens, other computers' tokens, and changed owners fail closed.
2. **Standalone worker relay and environment:** `server/telemetry-relay.ts`, `server/telemetry-runtime.ts`, `server/agent-graph-runtime.ts`, and `bin/deploy.js`. The agent starts a local relay on stable port 5358 and installs a remote environment provider. Legacy `runContainer` already calls `containerTelemetryEnvironment`; the graph executor now adds platform env after user env for runtime containers and graph jobs. Both RFR and legacy DEPLOY variable names receive the worker-local URL and the SER token. A worker never issues attribution tokens into its own database. No changes to `server/docker.ts` or image preparation were needed.
3. **Verification and handoff:** `server/telemetry-relay.test.ts`, the added graph regression, `scripts/telemetry-relay-fixture.mjs`, this note, and moving the existing HTTP edge test's fixture ports from 5330/5331 to 5350/5351.

## Execution path and trust

Remote application jobs are claimed by `bin/deploy.js` (`cmdAgentRun`, `processAgentJob`, `executeAgentDeploy`, `executeAgentRecreate`). Admitted graph payloads come from `createAgentGraphPayload` and execute in `executeAgentApplicationGraph`; project releases use the same executor through `server/v2/releases-worker.ts`. Source and job payloads already travel through computer-authenticated `/api/agent/*` requests. `server/workspace/remote-worker.ts` is the coding-task worker and uses a different workspace credential; it is not the app-container runtime.

The new relay uses the standalone agent's `x-deploy-node-id` and `x-deploy-node-secret`, matching its existing control channel. The deployment bearer is sent unchanged in `Authorization`. Redirects are rejected. The worker validates the token's syntax and the complete v1 batch shape; **SER verifies the token's authority asynchronously**. A local 204 acknowledges acceptance into the lossy relay, not successful authentication or storage on SER. Invalid but well-shaped tokens are dropped and counted when SER rejects them.

There is one outgoing request at a time. Defaults: 32 batches, 4 MiB total queued/in-flight serialized bytes, 512 KiB incoming body, at most 1,000 records per batch, 250 ms drain cadence, 3 s outgoing timeout, no retries. Overflow, forwarding failure, and shutdown discard records and increment `droppedRecords`; forwarding errors also increment `failedBatches`. The stats object includes queued bytes/batches and forwarded records. It is in memory and resets on worker restart. The app's request handler performs no coordinator network I/O.

Linux uses the Docker bridge gateway (`http://<gateway>:5358/__deploy`) and checks real TCP peers against discovered IPv4 bridge subnets. Subnets refresh every 30 s and on a rejected peer with a 1 s discovery throttle. The listener binds all IPv4 interfaces but rejects non-container subnet peers before reading their body. This does not use or change SER's port-80 edge collector.

On a Mac with a Colima context socket under `/.colima/`, the URL is `http://host.lima.internal:5358/__deploy`. Other Mac Docker contexts use `host.docker.internal`. The listener binds only `127.0.0.1` and admits loopback TCP peers, including IPv4-mapped loopback. Lima translates guest access to the host loopback: its default virtual host address is `192.168.5.2`, named `host.lima.internal`. See [Lima's host-loopback documentation](https://lima-vm.io/docs/config/network/user/). Colima/Lima must allow host loopback (`networkOpts.hostLoopback` must not be disabled). Local host processes share this loopback boundary; TCP does not distinguish those from Lima's forwarding. The deployment token and computer grant remain mandatory at SER. LAN callers and forwarded-IP spoofing do not pass the worker peer gate.

If worker listener startup/discovery fails, it logs the failure and leaves telemetry disabled without failing app supervision. Restart the worker after correcting Docker availability or a port conflict. Existing containers keep sending to the stable port through worker restarts; no local token cache is needed to forward their bearer.

## Regression results

These were written and run before implementation:

| Test name                                                                                        | Before                                                      | After  |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------ |
| remote container environment uses the local relay and SER-issued token without a local database  | Failed: remote provider did not exist                       | Passed |
| relay accepts only local container peers, bearer tokens and valid bounded v1 shape               | Failed: relay module absent                                 | Passed |
| relay forwards with the computer credential and original deployment bearer, refusing redirects   | Failed: relay module absent                                 | Passed |
| dead SER never blocks app responses or crashes the relay; queue and failures are counted         | Failed: relay module absent                                 | Passed |
| SER ingests relayed records by token only, scoped to computer and current app owner              | Failed: remote ingestion module absent                      | Passed |
| remote graph containers and jobs receive platform telemetry after user environment               | Failed: generated Docker command lacked the telemetry token | Passed |
| authenticated job claim provisions a SER telemetry token for remote deploy, recreate and release | Failed: token resolved to null                              | Passed |

An additional passing regression checks the byte cap while a batch is in flight and counts a SER 401 as a dropped batch without retry.

Final focused command (78 passed, 0 failed):

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 node --test --test-concurrency=4 \
  server/telemetry-relay.test.ts server/agent-graph-runtime.test.ts \
  server/agent-graph-payload.test.ts server/telemetry.test.ts \
  server/requests-db.test.ts server/v2/releases-remote.test.ts \
  server/computer-roles-api.test.ts bin/worker-supervisor.test.mjs \
  bin/agent-services.test.mjs
```

`DEPLOY_MDNS_ADDRESS=127.0.0.1 node --test server/telemetry-http.test.ts`: 10 passed, 0 failed. Its final run used 5350/5351. An earlier exclusion filter unexpectedly ran the pre-existing test on 5330/5331; that mistake was corrected in the test file.

`pnpm run typecheck`: passed. `pnpm run lint`: passed with repository warnings, no errors. `pnpm exec oxfmt --write` was run on all changed code and this note.

## Fixture and remaining physical verification

The fixture creates its own temp data directory, fake enrolled computer, deployment token, authenticated coordinator on loopback 5359, and relay on 5358. It never contacts SER or deploy.local. It removes the temporary database on exit. No screenshot is needed because there is no visible change.

Host-loopback checks actually run here:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 node scripts/telemetry-relay-fixture.mjs --host=host.lima.internal --check
DEPLOY_MDNS_ADDRESS=127.0.0.1 node scripts/telemetry-relay-fixture.mjs --host=host.lima.internal --check --dead
```

Measured HTTP acknowledgments: 9.38 ms with the coordinator alive and 9.31 ms with it stopped. Alive: one forwarded record, one stored `relay-fixture` server record, zero drops. Dead: zero stored records, one dropped record and one failed batch. These are host-loopback probes, **not container reachability measurements**. The timeout unit test holds the transport open for 25 ms per batch: five app submissions complete before any forwarding attempt, only two batches fit, and ultimately all five records are counted as dropped with two forwarding failures.

**Orchestrator: run on the iMac's actual Colima context, with an already-present app image containing Node.** Substitute that image below; `--pull=never` avoids a pull/build, and the disposable container has no mounts or published ports:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 node scripts/telemetry-relay-fixture.mjs --image=FORMA_IMAGE
DEPLOY_MDNS_ADDRESS=127.0.0.1 node scripts/telemetry-relay-fixture.mjs --image=FORMA_IMAGE --dead
```

Capture stdout: selected `host.lima.internal` URL, `container HTTP 204`, container acknowledgment ms, relay counters, and the stored server row (or one counted drop with dead coordinator). Run the same commands on a Linux worker to verify its real bridge gateway/subnet path. Add `--network=APP_PRIVATE_NETWORK` to test a container on the app's private Docker network. This environment has no Colima and its configured OrbStack daemon socket does not exist, so these container tests were not run.

## Rollout

The iMac **must update its standalone worker binary**; changing SER alone cannot create this listener in the old worker. Activate the server changes and publish matching CLI artifacts (`pnpm build:cli` at the released commit; atomically swap the built downloads into the persistent CLI directory per AGENTS.md). Those build/publish/activation steps were not run here.

Today's path is the 10-minute scheduler in `server/v2/fleet-updates.ts`, when automatic updates are enabled and a verified coordinator release has matching CLI manifest artifacts. It queues a durable `self-update` job for an online, supervised computer advertising `selfUpdate: 1` and a different agent version. `bin/deploy.js` sends `worker-update` IPC to `bin/worker-supervisor.mjs`; the supervisor downloads, verifies SHA-256/size/version through `bin/worker-update.mjs`, swaps the binary, seals the Mac app, restarts the child, waits for readiness, and can roll back. `server/workspace/worker-update.ts` reports version/tool inventory; it does not itself install the app update.

On a Mac the worker runs under launchd from the signed `deploy.local Worker.app`. Keep the existing bundle path/identity, re-sign and verify the bundle after replacement using the existing supervisor path, and confirm macOS Local Network permission for the Worker app. Bare launchd executables can be blocked by that privacy boundary; the relay does not bypass it when connecting to SER on the LAN. The supervisor/service tests passed with mocked Mac commands; a real signed app update and Local Network permission were not exercised.

After updating the worker, **recreate/redeploy Forma** (or activate a new project release). Existing containers have the old gateway/local-only token environment, which a worker update cannot change. A newly claimed recreate/deploy/release gets its SER-issued token. Confirm `RFR_TELEMETRY_URL`/legacy URL point to the iMac relay, then generate an app server request and confirm its records appear under Forma through the existing performance ingest. That end-to-end live rollout was not performed.

The full `pnpm test` runner was not run: it starts additional suites with fixed/listener ports outside 5350–5399, and includes Swift builds unavailable in this sandbox. Router Vitest, router worker-pool, web, remaining server/CLI suites, Swift, Chromium/Electron, SEA CLI builds, and physical Colima/Linux containers remain unverified. No commits, pushes, merges, live data mutations, or network advertisements were performed.
