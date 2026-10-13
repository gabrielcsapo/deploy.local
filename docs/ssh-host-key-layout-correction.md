# Groffee active SSH-key layout correction

This isolated correction extends the serving-preserving controller candidate
`08e1d6b705d30b36f01432832439df56566d5ee8` on branch
`fix/ser-groffee-host-key-layout`. The installed candidate and original dirty
checkout are retained untouched. Gabriel approved this targeted implementation,
review, testing and controller handoff, followed by the pending Groffee release.
No credentials or host trust are relocated, regenerated or weakened.

## Exact production evidence

Groffee source `packages/web/app/api/ssh-server.ts` uses
`/app/data/ssh_host_ed25519_key`. Existing production metadata confirms this is a
nonempty private regular file, mode 0600. The `/etc/ssh` bind contains client SSH
configuration rather than an active server key. The previous admission required
keys only in that latter directory, so it failed before building/stopping Groffee.

The key's public fingerprint equals both backend SSH 43055 and public SSH 2223:
`SHA256:jGv2RFYTp/j9qcV7TNXSEXKEvwjmzcgshrZHt8aaxRY`.
Strict known-host authenticated Git reads succeeded and returned Groffee main
`60c55f6b49a18c560002eaee51a456b485962f3d`. Only metadata/public fingerprints were
inspected; production private-key bytes were not exposed.

## Preservation and admission

Recognize the exact data-host-key path as primary when present; otherwise retain
the existing separate-key layout for modern OpenSSH host keys. Validate every
recognized key: nonempty regular file, no symlink, no group/other permissions,
and parseable cryptographic identity. An invalid recognized key cannot be hidden
by a valid fallback. All three durable roots remain mandatory and unchanged.

Inside the restricted helper, ssh-keygen derives public identities only; neither
key bytes nor ssh-keygen stdout/stderr are logged. The helper returns only a
public-identity digest. Admission requires it to match backend and public SSH.
Immediately after build, compare stored and active identity to the original
captured digest again, before preparing/stopping the old writer.

Full cold snapshots still archive data, uploads and the separate SSH directory
with numeric ownership and modes. The data key is included as opaque file bytes
in the complete inventory/content hash. Isolated extraction verifies all bytes
and metadata, and restored startup must match the original active public identity.
A key is never copied into a different production path or generated at admission.

## Verification

New synthetic tests cover data-key snapshot/restore, ownership/mode/public digest,
missing/empty/directory/symlink/insecure/malformed keys and invalid recognized
fallbacks. Real disposable Docker coverage exercises both layouts, successful
update/explicit rollback, automatic failed-health rollback, missing persisted
identity, active identity drift and build-time key drift before writer stop.
Existing authorization, crash recovery, orphan-helper fencing, writer admission,
TLS, cache and complete-data regressions remain required.

Full corrected suite: 433 tests, 422 passed, ten opt-in Docker cases skipped,
one previously reproduced and explicitly accepted SQLite reconciliation failure.
Typecheck and lint pass. Final runtime/build evidence is in
`/tmp/task3-key-docker-final.log`, `/tmp/task3-key-types.log`,
`/tmp/task3-key-lint.log`, `/tmp/task3-key-full.log`,
`/tmp/task3-key-core-api.log`, `/tmp/task3-key-build.log`,
`/tmp/task3-key-extras.log`, `/tmp/task3-key-cli.log`.
Independent review required and confirmed the final post-build identity fence.

## Controller handoff and pending application release

Administrator authentication remains required; `sudo -n` cannot install.
The private checkpoint is
`/home/gabrielcsapo/Documents/Codex/2026-10-11/task-3/ser-key-layout-controller-checkpoint`
(mode 0700). It retains the currently installed controller artifacts, base unit,
and prior drop-in, plus a verified consistent online controller backup
(SHA-256 `ca0c03cb68f0f6e2f0ff40e233e60191f47e67a2743db3c1631a30d1454b08af`). The
reviewed install script additionally takes a cold backup after stopping only the
controller, then changes only the owned drop-in to this immutable candidate and
pins the original data directory. It refuses unknown baseline/identity changes.
Failure restores the prior installed controller launch; it never restores live
application data and refuses old-controller reversal if an application journal
or recovery lock appears.

After successful handoff, confirm installed commit/artifact and pinned data path,
HTTPS health, authenticated compatibility status and unchanged Groffee
container/image/mounts/public identity. Then quiesce application jobs and host
writers and run the approved legacy update from clean Groffee release
`60c55f6b49a18c560002eaee51a456b485962f3d`. Verify cold archive/rehearsal, health,
existing projects/board/API/data/uploads, HTTPS trust and authenticated Git/LFS.
Record exact live source/image and snapshot evidence. Post-release restoration
that would overwrite later writes still requires separate approval.
