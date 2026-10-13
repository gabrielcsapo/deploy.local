# Scoped CI source-release contract

This isolated branch targets remote `improvements` at b561c209. No production
controller/application, credentials, trust or repository policies are changed.

## Pipeline-facing contract

Runner image includes a checksum-pinned matching deploy CLI and the independently
verified public deploy.local CA in its OS trust store. A protected explicit job
secret supplies `DEPLOY_AUTH_JSON` with:

```json
{ "version": 1, "url": "https://deploy.local", "username": "issuer", "token": "scoped-ci-token" }
```

Alternatively `DEPLOY_AUTH_FILE` selects an owner-only regular auth file; supplying
both is rejected. No password or token argv. Scoped credentials are restricted to
publish/status for one application, expire, and can be individually revoked.
They cannot use ordinary account/admin/secret/controller APIs. Issuance and
revocation require existing owner authentication and are separate operator actions.
Tests use synthetic principals exclusively.

Protected job has successful test dependencies, immutable image and explicit
secret declaration. Existing Groffee runner variables are `GROFFEE_COMMIT`,
`GROFFEE_RUN_ID`, and `GROFFEE_REPO`. Command:

```sh
deploy publish -a wander --url https://deploy.local \
  --source-commit "$GROFFEE_COMMIT" \
  --source-archive-sha256 "$TESTED_SOURCE_SHA256" \
  --idempotency-key "$STABLE_RELEASE_INTENT_KEY" \
  --expected-release "$EXPECTED_RELEASE_ID" --wait --json
```

`EXPECTED_RELEASE_ID` is the predecessor captured for this release intent, not
silently refreshed on retry. Initial bootstrap and release ordering must be
explicitly resolved. CI must not turn stale/conflicting admission into a fresh
request automatically.

Publisher requires clean exact checkout, bundles source deterministically and
records its content digest. This is remote source building, not promotion of an
already-tested image. The pipeline establishes test/dependency provenance; the
controller does not independently prove tests succeeded merely from a commit
label. Build inputs outside the bundle still need separate reproducibility policy.

Receipt fields: `releaseId`, `application`, `sourceCommit`, `sourceDigest`,
`sourceArchiveDigest`, `imageDigest`, `predecessorReleaseId`, `status`, timestamps and bounded failure
reason. Status transitions include accepted/building/starting/healthy/failed;
healthy requires the actual runtime health gate and artifact match. Secrets are
never included. Receipt commands:

```sh
deploy release status -a wander --release "$RELEASE_ID" --json
deploy release wait -a wander --release "$RELEASE_ID" --json
```

Identical key/request returns/resumes the same receipt. Reusing a key with a
changed commit/digest/predecessor fails. App CAS and exclusive execution reject
concurrent or stale predecessors. Timeout/interruption means unknown/pending,
not permission to replay under a different key. Credential expiry does not erase
receipts or cancel a controller-owned accepted operation. Revocation removes
future credential access. Data-loss rollback is never automatic CLI policy.

## Current target blocker

Read-only production inspection found Wander is `deploy-sh-wander` with
`active_spec_digest=null`, although a desired repository digest exists. This
contract must reject implicit legacy adoption. The existing preserving update
path is deliberately Groffee-only. Safe Wander adoption/compatibility requires a
separately reviewed plan; it is not silently generalized here. A pipeline draft
can use the proposed commands but must remain disabled/unconfigured until this
prerequisite and operator approvals are satisfied.

The stable intent key hashes application, exact commit, tested uncompressed Git
archive SHA256 and approved predecessor. A new Groffee run ID does not create a
new release intent. Produce the tested artifact using `git archive --format=tar`
from the exact commit. The CLI reproduces this archive, verifies the supplied
bare hexadecimal SHA256 and uploads deterministic `gzip -n` bytes. The server
verifies both byte digests. `sourceArchiveDigest` describes the tar;
`sourceDigest` describes the compressed uploaded bytes.

Only an existing healthy coordinator graph with one built web instance, explicit
HTTP health check, unchanged declaration and managed resources is supported.
Legacy deployments, host bind mounts, remote replicas, placement changes,
privileged runtimes, profiles and jobs fail closed. The temporary Wander bind
adoption plan therefore does not make Wander eligible for this CI contract;
a separately approved managed-resource transition is still required.

Failed and interrupted intents retain the application fence. An owner may POST
`/api/ci/owner/releases/:id/recover` after inspecting build logs. Recovery verifies
the actual container image, source metadata and HTTP health before rearming the
same intent or attesting the completed new runtime. Cancellation at
`/api/ci/owner/releases/:id/cancel` requires the verified original runtime and
unchanged original source. Neither action restores or rewinds data. Live owning
processes cannot be recovered from another API worker; verified worker exit
clears only that worker's mutation leases. Uncertain process liveness fails
closed. Controller restart is the conservative recovery for a lost, unregistered
worker owner. Terminal receipts can become `superseded` when runtime/configuration
changes; `cancelled`, `failed`, `interrupted` and timeouts are never publication
success. Resolve stale predecessors explicitly instead of refreshing on retry.

Issuing production credentials, installing this controller, configuring secrets,
and enabling pipeline publication remain separate approved operator steps.

## Validation

The scoped store/CLI/HTTP suite passes 13 tests, including revoked/expired
credentials, exact byte hashes, CAS/idempotency, fenced mutation, interrupted
recovery, live cross-worker rejection and verified worker-exit cleanup. The
native Linux CLI passes the same executable HTTP/TLS boundary test with a
conflicting synthetic account config and no explicit URL override.

The opt-in `CI_DOCKER_TEST=1 node --test server/ci-docker.test.ts` passes against
uniquely named disposable resources: unchanged graph plus changed source yields
a new immutable image/container and new served content; retry returns the same
receipt; failed activation retains the fence. This test is skipped in the default
suite to avoid requiring Docker for every checkout.

Typecheck, lint (warnings only), application build, server-extra packaging and all
five native CLI builds pass. The full suite reports 414 tests: 412 pass, one
Docker opt-in skip, and one pre-existing SQLite changeset reconciliation failure
at `server/data-reconciliation.test.ts:207`, independently reproduced on the
unchanged base with the same dependency runtime. Global format-check flags two
unchanged dashboard files; changed files are formatted and `git diff --check`
passes. These baseline failures are disclosed rather than repaired in this scope.
