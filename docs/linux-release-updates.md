# Linux release updates without repeated sudo

The existing server is a system service, starts at boot and binds 80/443. Updates should not need to edit its unit or authenticate as an administrator each time.

`scripts/linux-release.mjs` installs a stable `current` symlink and a Polkit rule for exactly one account, action, service and verb: the designated deployer may restart `deploy-server.service`. It does not authorize stopping other services, changing units, reloading systemd, installing packages or arbitrary privileged commands. The rule applies to SSH sessions as well as interactive sessions.

This preserves the existing service identity and data directory. On SER the service currently runs as root and already executes code from user-owned releases; the deployer remains trusted to choose that code. This workflow does not convert the runtime into an unprivileged service. Moving the runtime to another account is a separate migration involving existing data and Docker access.

## One-time administrative setup

First build a clean, detached checkout under the deployer's `~/.local/share/deploy.local/releases/`. Keep the deployment data directory outside the release. As the ordinary user:

```sh
node scripts/linux-release.mjs prepare /absolute/path/to/releases/new-release
```

Preparation runs a frozen dependency install, typecheck, production build and server tests. It records the Git revision and SHA-256 hashes of every build artifact in `.deploy-release.json`. Modified tracked files, missing entry points, symlinked artifacts and changed build output fail verification.

An administrator then runs this once, using the existing Node binary and existing data path:

```sh
sudo /absolute/path/to/node scripts/linux-release.mjs install \
  deployer /absolute/path/to/releases/new-release /absolute/path/to/existing-data
```

Setup installs:

- `/usr/local/bin/deploy-update` and its root-owned implementation under `/usr/local/lib/deploy.local/`.
- `/etc/deploy-local-release.json`, recording the deploy account, Node binary, release root and existing data directory.
- `/etc/systemd/system/deploy-server.service.d/99-user-releases.conf`, pointing both the working directory and entry point at the stable symlink.
- `/etc/polkit-1/rules.d/49-deploy-local-release.rules`, granting only the designated service restart.

Setup verifies Polkit authorization from the ordinary user's process, then activates the prepared release as that user. It restores the previous systemd configuration if installation fails. It refuses to overwrite an existing setup; upgrades to this host-level deployment tool require explicit administrator maintenance. No data ownership, certificates, service account, Docker permissions or sudoers rules are changed.

The current readiness probe is configured for SER: trusted TLS at `https://deploy.local/`, resolved to loopback, using the existing data directory's `certs/ca.crt`. Adapt this probe before using the tool on a differently configured host.

## Every later update

Create or fetch the next clean release checkout under the configured release root. Then run, without sudo:

```sh
deploy-update prepare /absolute/path/to/releases/next-release
deploy-update activate /absolute/path/to/releases/next-release
deploy-update status
```

The activator validates the revision and artifact hashes before changing anything, takes an update lock and atomically replaces the `current` symlink. It invokes `systemctl --no-ask-password restart deploy-server.service`; no password prompt or authentication fallback is used. It checks the active service, a changed supervisor PID, the selected working directory and trusted HTTPS readiness. If restart or readiness fails, it restores the previous pointer and restarts the previous release. A failed rollback is reported explicitly.

The lock is removed on normal success and failure. If the updater is forcibly killed, inspect the service and current pointer before manually removing `~/.local/share/deploy.local/.release-update.lock`; do not bypass a running update.

## Rollback and verification

Keep previous prepared releases. Rollback uses the same command:

```sh
deploy-update activate /absolute/path/to/releases/previous-release
```

Existing releases predating this workflow need `deploy-update prepare` before they can be selected manually. Automatic failure recovery can return to the original active release during the one-time setup.

Run the updater tests with:

```sh
node --test scripts/linux-release.test.mjs
```

Tests cover the exact authorization boundary, path confinement, artifact integrity, atomic pointer replacement, validation before mutation, successful activation, failed readiness and failed rollback. Host installation and actual passwordless restart must also be verified on the target after the one-time setup.

References: [Polkit rules](https://polkit.pages.freedesktop.org/polkit/polkit.8.html), [systemd authorization](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html).
