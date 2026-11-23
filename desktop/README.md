# deploy.local Desktop

The Electron client loads the coordinator's `/dashboard`. This directory has its own dependency
lock and is not part of the root workspace. It is the desktop app on Mac, Windows and Linux; the earlier Swift Mac target is retired.
Take tasks runs as a child: closing a window keeps it running; Quit stops it. On macOS, Run apps
installs a persistent login service that keeps running after Quit (see below).

## Develop and package

From the repository root, install the server dependencies with `pnpm install --frozen-lockfile`.
Then, in `desktop/`:

```sh
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
pnpm build
pnpm start
pnpm test
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:mac
```

The explicit Electron installer downloads the pinned official Electron runtime, not a system app.
If the normal cache is not writable, set `electron_config_cache` to a writable temporary directory.
The JS bundler uses its platform package; no native server database dependency is bundled.
The built app is `dist/mac-arm64/deploy.local Desktop.app` on Apple Silicon. It stays in this folder.
`pnpm package -- --mac`, `--win`, or `--linux` selects dmg, nsis, or AppImage/deb on a suitable host.
Run packaging on the destination OS for release acceptance.

`assets/design-tokens.css` is generated at build time from `../app/design-tokens.css` and is not tracked. Desktop tests do not require it or a prior build.

The build reads and bundles `../server/workspace/remote-worker.ts`, the app-worker install modules
from `../bin/`, and their dependencies. The
local `worker.ts` shares a coordinator database and therefore must not run on a desktop client.
The remote worker uses Electron's bundled Node runtime, its own directory inside app user data,
and the existing `/api/workers/enroll` API. Git and provider CLIs must already be
available on PATH. It does not install them. Provider accounts are discovered by the existing
worker; setup does not claim an account is signed in before that check.

Set `DEPLOY_DESKTOP_HELPER` during **build** to a previously built macOS control helper, or build
`native/ControlHelper/main.swift` into `desktop/build/helpers/deploy-control-helper`. The default
Xcode DerivedData helper is also detected. It is copied into Resources/helpers, then supplied to
the worker only when Use the screen is selected. A release build needs a stable signing identity
and real OS permission acceptance. Windows and Linux screen control are explicitly unavailable.

When no signer is configured, the Mac download build reuses the certificate of a signed copy in Applications and verifies the update against that app’s designated requirement. This preserves the identity Keychain uses across updates.

Signing uses electron-builder's environment variables (`CSC_LINK`, `CSC_KEY_PASSWORD`, optionally
`CSC_NAME`). For notarization, use `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, or
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. No identity or secret is in the config.
See the [electron-builder macOS configuration](https://www.electron.build/mac/).

## Trust, credentials and preload

Onboarding discovers `https://deploy.local` through normal OS mDNS resolution or accepts an
entered origin. Plain HTTP is restricted to loopback development. The first TLS probe sends
no HTTP request or credentials. The user must compare and confirm the SHA-256 certificate
fingerprint. Main-process and worker HTTPS verify that exact certificate and its validity before
sending credentials. Electron's isolated coordinator session uses the same pin. Certificates
are not added to the operating system trust store, and TLS verification is never disabled globally.
Git receives the coordinator CA fetched over the pinned connection, scoped to that origin;
Git still performs CA and hostname validation. Provider traffic keeps normal TLS validation.

Password sign-in uses `/api/login`. Login and enrollment tokens are encrypted with `safeStorage`.
An unavailable keychain or Linux `basic_text` backend blocks persistent sign-in. Only main adds
the real `X-Deploy-Username` and `X-Deploy-Token` headers, and only for the coordinator origin.
The existing web UI receives a non-secret localStorage sign-in marker. Old server actions that
validate explicit token arguments instead of request headers will need the web auth migration;
the marker is deliberately not an authentication token.

The remote preload exposes exactly:

```js
deployDesktop.notify(inboxItemId);
deployDesktop.setBadge(waitingCount);
deployDesktop.worker.status();
deployDesktop.worker.setRoles({ takeTasks, runApps, serveModels, useScreen });
deployDesktop.control.request(controlInboxItemId);
deployDesktop.openExternal(webAddress);
// Mac only:
deployDesktop.update.status();
deployDesktop.update.onChange(callback); // returns an unsubscribe function; callback receives status only
deployDesktop.update.start();
deployDesktop.update.cancel();
deployDesktop.update.restart();
```

`notify` only accepts existing decisions; `setBadge` must match the inbox. Role changes open a
native review and setup. `control.request` opens the existing per-task decision, never grants
blanket capture. External URLs get a native review and only HTTP(S) can open. IPC checks the
exact originating webContents, main frame, and coordinator origin. Internal setup uses a
separate sandboxed preload, which exposes no page API. All windows keep context isolation,
web security, and renderer sandboxing enabled and Node integration disabled.

## Tests and evidence

`node --test desktop/test/main.test.mjs` from the root tests client policy, inbox replay, tray
state, the exact preload surface, safeStorage handling, managed-child lifecycle, and control
commands. The opt-in integration test requires a disposable coordinator:

```sh
DESKTOP_TEST_ORIGIN=https://127.0.0.1:5198 node --test desktop/test/coordinator.test.mjs
```

It refuses non-loopback addresses and ports outside 5180–5199. It creates a disposable account
and enrolls only against that coordinator, then stops its worker. Set `DESKTOP_TEST_EXECUTABLE`
to the packaged Electron executable to verify the bundled runtime. The default uses Node.
Start the real coordinator with `PORT`, `HTTPS_PORT`, `VITE_PORT`, and a temporary `DEPLOY_DATA_DIR`;
block Docker access and mDNS during isolation. Never aim this test at your installed coordinator.

`node desktop/scripts/evidence.mjs` writes fixtures using the real shell renderer. On a host that
allows Chromium, `node desktop/scripts/capture.mjs` captures at 1440/700 and runs the design's
pairing tool. These are explicitly labeled renderer fixtures, not native-window acceptance.
See [the evidence notes](../docs/evidence/v2/13-desktop/notes.md) for current verification limits.

## Signing and notarization variables

Release packaging reads credentials only from the environment. Supply these through your release
secret store; do not put them in package.json or commit a certificate/key.

| Purpose                                    | Exact variables                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| macOS Developer ID certificate             | `CSC_LINK` (path, HTTPS URL or base64 PKCS#12), `CSC_KEY_PASSWORD` (its password)    |
| Existing macOS keychain identity           | `CSC_NAME` (identity name), optionally `CSC_KEYCHAIN` (keychain path)                |
| macOS notarization with App Store Connect  | `APPLE_API_KEY` (path to the `.p8` key), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`      |
| macOS notarization with Apple ID           | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`                           |
| macOS notarization with stored credentials | `APPLE_KEYCHAIN_PROFILE`, optionally `APPLE_KEYCHAIN`                                |
| Windows certificate                        | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (fall back to `CSC_LINK`, `CSC_KEY_PASSWORD`) |
| Unsigned local build                       | `CSC_IDENTITY_AUTO_DISCOVERY=false`                                                  |
| Writable download caches                   | `electron_config_cache`, `ELECTRON_BUILDER_CACHE`                                    |

Choose one notarization credential method. Hardened runtime stays enabled for macOS release
builds; electron-builder notarizes when credentials are supplied. No credentials are required for
Linux packaging. Signing, notarization, platform-specific native notification delivery and the
helper's OS permission identity still require release-machine acceptance.

From the repository root:

```sh
pnpm --dir desktop run package:check
```

This builds the worker and shell, copies `app/design-tokens.css` into desktop assets, and builds an
**unsigned unpacked application for the current OS/architecture** under `desktop/dist/package-check/`.
It uses the installed Electron distribution and a writable cache under `desktop/build/`.
It never installs into `/Applications`, publishes, signs or notarizes. It extracts both preloads
from the packaged `app.asar`, executes their capability audit, checks the six base calls and five Mac update methods and
nested keys, rejects extra globals, checks that the copied tokens match, and confirms the worker
is bundled. Run on each destination OS for cross-platform packaging acceptance.

## Isolated Electron captures

```sh
pnpm --dir desktop run capture:electron
```

The harness uses Playwright `_electron.launch` and the fixture coordinator on `127.0.0.1:5184`.
Its two debugger listeners share port 5185 on separate loopback families (Node on `::1`, Chromium
on `127.0.0.1`). Do not run the renderer preview server at the same time. The explicit environment
is `DEPLOY_COORDINATOR_URL=http://127.0.0.1:5184`, `DEPLOY_DESKTOP_DISABLE_MDNS=1`,
`DEPLOY_DESKTOP_FIXTURE=1`, and a freshly created `DEPLOY_DESKTOP_DATA_DIR`. The harness runs again
with `DEPLOY_DESKTOP_FIXTURE_PLATFORM=linux` for SetupLinux. It uses an in-memory credential store
and worker double, never a real enrollment or worker process. The fixture module is excluded from
packaged apps, and the hook refuses packaged use, other origins, enabled discovery or a persistent
profile. Normal launches continue to use safeStorage and the real worker.

Captured files go under `docs/evidence/v2/13-desktop-2/native/`. The notification content screenshot
is an Electron window built from the exact native Notification options, with the same JSON saved
beside it. It verifies content, not OS notification-center appearance or delivery. The simulated
Linux run uses the host OS's native frame. See that directory's `captures.md` for renderer URLs,
board dimensions, pairing commands and any sandbox launch limitation.

## Mac app updates

Packaged Mac apps read `build/build-info.json` from their own app archive. The desktop build
uses `computeBuildInfo`; `build-desktop-download.mjs` supplies that exact stamp to packaging
through `DEPLOY_DESKTOP_BUILD_INFO`, so the published manifest and installed app agree.
Unpackaged development apps do not download or replace Electron itself.

On sign-in/launch and every four hours, main checks the connected coordinator's `/desktop/version`
with its existing certificate pin. Only a different commit with a newer build time is offered.
The archive comes from `/desktop?os=darwin&arch=<arch>&version=<version>`; redirects are refused.
Downloads live in `userData/updates`, are cancellable, and must pass manifest size/SHA-256,
`ditto -x -k`, and `codesign --verify --deep --strict` before Restart becomes available.
Failures checking in the background retain the last known status. Retry fetches the manifest again.

The status object has `phase` (`idle`, `available`, `downloading`, `checking`, `ready`, `installing`,
`failed`), published `version`/`commit`, progress `bytes`/`total`/`percent`, and a failure `error`
(`verification` or `network`). All four update IPC requests use the existing sender, main-frame
and coordinator-origin checks. Only the Mac preload exposes `update`; `onChange` removes its
listener when unsubscribed. No page receives filesystem paths or controls a download URL.

Restart copies the verified app beside the installed bundle and verifies it again before quitting.
A detached `/bin/sh` helper, copied out of ASAR into user data, waits for this PID to exit (up to
120 seconds), renames the old bundle aside, then renames the candidate into place. Both renames
are on the same volume. It runs `open -n` with an opaque handoff ID and the existing data directory.
The new app validates its build and bundle against the private receipt, restores only a dashboard
URL on its saved coordinator, and acknowledges startup. It then removes the old bundle. Startup
and rollback claim the same directory, so a late startup cannot acknowledge over rollback.
If launch fails or startup is not acknowledged within 60 seconds, the helper stops the new PID,
restores the previous app and reopens the saved page. Recovery logs and receipts remain in
`userData/updates/<id>.json*`. A failure to remove the old bundle keeps it and logs the failure.

An unwritable installation (including a disk image) keeps the verified update Ready and logs the
handoff error; no elevation or extra dialog is introduced. The previous app reopens after rollback
with its normal update check. The approved boards do not define installation-error UI. Native
LaunchServices, signing, filesystem permissions and first-window acceptance still need the Mac
checks in the repository-root `captures.md`; filesystem helper tests use disposable fake launchers.

For isolated manual update states, `scripts/update-fixture.mjs` serves manifest/archive responses
on `127.0.0.1:5194` and proxies the remaining requests to a disposable coordinator on 5190–5193.
Its JSON config names `manifest`, `archive` and `mode` (`normal`, `slow`, `corrupt`, `network`).
It rereads the config on each request. It is excluded from packaged apps.

## Run apps on a Mac

Run apps is separate from Take tasks. On macOS, setup detects Docker through the login's
service PATH (including Intel Homebrew and Docker Desktop's CLI directory). The switch is
available when the Docker CLI is installed, even if its daemon is stopped. Turning it on
immediately enrolls and installs the execution agent. The Add button applies the other roles.
Turning Run apps off changes coordinator admission only; existing apps and enrollment stay.

`src/app-worker.mjs` bundles the shared `bin/agent-install.mjs`, enrollment and service helpers
into `build/app-worker.mjs`. It never invokes a `deploy` executable from PATH. Its external
commands all use `runBounded`, including version probes, codesign, launchctl, Docker, Colima
and the optional administrator prompt. GUI-launched commands receive the service PATH.
The shared repair transaction accepts asynchronous manifest, version and sealing hooks;
the CLI retains its existing defaults and commands.

Fresh installation uses the signed-in owner's pinned `CoordinatorClient`:

1. `POST /api/computers/enrollment` with `{ name }` creates the join code (owner/admin API).
2. Shared `joinAgent` redeems it with `POST /api/agent/enroll`, carrying `code`, `name`,
   platform, architecture and `{ deploy: true, tasks: false, computer: false, browser: false }`.
3. `GET /cli/version` selects `darwin-arm64` or `darwin-x64`.
   `GET /cli?os=darwin&arch=<arch>&version=<version>` downloads through the pinned client.
   Size and SHA-256 are checked before signing/probing or executing any downloaded code.
4. A fresh service obtains `/ca.crt` through the pinned client and uses that private file as
   `NODE_EXTRA_CA_CERTS`. No certificate is installed in the system trust store.

The app maintains `~/Library/LaunchAgents/sh.deploy.agent.plist`, running
`~/Applications/deploy.local Worker.app/Contents/MacOS/deploy-worker-supervisor agent run`.
Enrollment remains in `~/Library/Application Support/deploy.local/agent.json`; the original
`data` directory, `relays.json` and relay ports are preserved. `desktop-worker.json` beside
`agent.json` is the desktop ownership marker, bound to the coordinator and node id.
A different coordinator's enrollment is never overwritten. A failed fresh install keeps
its enrollment; the next Move/Repair can finish without creating another computer.

A command-line install opens the take-over page. Leave it as it is persists until the next
password sign-in. Move it to this app never enrolls again. A current build with a running
service already pointing at its supervisor is left running. Replacement programs restart
immediately; failed repairs restore the previous bundle and plist and attempt its restart.
Quit waits for an in-flight repair/restart, then stops only the task child. The launchd app
worker continues after closing or quitting the desktop and starts at the next login.

An unused `/Library/LaunchDaemons/sh.deploy.agent.plist` is shown by path. After take-over,
Remove older copy on that row asks macOS once for administrator privileges to boot out and
remove that plist only. An actively running all-users service is not a leftover: take-over
refuses to create a second running service. No operation here removes enrollment or data.
Removing the primary worker is not exposed by these boards; CLI removal is unchanged.

Menu status reads `/api/live` and `/api/computers`, matches this computer by node id,
and combines them with bounded service/Docker probes cached for 15 seconds. The four states
are `running`, `docker-not-answering`, `service-stopped`, and `cannot-reach-coordinator`.
Previously read apps remain visible on connection failure. `deployDesktop.worker.status()`
adds `appWorker` with this state, detection, apps and computer health; it contains no agent
secret. Shell repair, take-over, Docker restart and leftover actions use the existing local
trusted-sender checks; the remote preload adds no new callable capabilities.

Restart Docker supports Colima: stop (60 seconds), start (180 seconds), then one more start
after 5 seconds if the first fails, including a timeout. A timed-out stop still attempts start.
Docker Desktop, OrbStack and other runtimes need manual restart. Linux and Windows retain
Take tasks and their current screen-control limitations; Run apps says “Not supported here yet”
and does not install or inspect services. Serve models remains unavailable on every platform.

## Local Intel Mac package

Install desktop dependencies as described above, then on a Mac run:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir desktop package:mac:x64
```

This explicitly selects Electron x64 and produces `desktop/dist/mac/deploy.local Desktop.app`.
It does not publish a download. `scripts/build-desktop-download.mjs` still publishes arm64 only.
Intel builds disable Use the screen with an explicit message, even if an ARM helper is present;
Take tasks and Run apps remain available. No native helper compilation is needed for this build.
The coordinator must already offer a verified `darwin-x64` worker in `/cli/version`.
Actual macOS 13 compatibility, signing/LaunchServices acceptance, Docker and Colima recovery
must be verified on the Intel iMac; no Electron or service was run by the sandbox tests.

The new fake-only suite is `node --test desktop/test/app-worker.test.mjs`. It covers detection,
owner enrollment, byte-preserving take-over, repair rollback, timed-out commands, Colima retry,
status caching, privilege scope and both setup/tray variants. Run all desktop tests with
`node --test desktop/test`; the existing capture coordinator test also needs a loopback listener.

Board differences to verify on the iMac: enrollment dates are not supplied by the Computers API,
so take-over shows “In Computers · runs apps” without a date; actual runtime names, unavailable
Docker, service/coordinator failures and progress use factual dynamic text. The older-copy path
and its post-move removal button make the required removal action explicit. Serve models remains
disabled with its existing explanation; Intel screen control is disabled. When both jobs are
selected, the tray also retains the existing task row. The approved Run apps quit sentence wraps
to stay readable. Screenshots and visual comparison at 1440/700 remain required outside this sandbox.

### Intel iMac acceptance (fresh command-line take-over, forma running)

1. On the iMac, record the existing node id/name, forma's address and response, and a private
   backup/hash of `agent.json` and `data/relays.json`. Do not paste the secret into the task.
   Confirm which login LaunchAgent is active and whether the system plist is unused. Keep
   continuously requesting forma from another computer throughout take-over.
2. Verify the coordinator serves a `darwin-x64` worker manifest. Package the x64 desktop app,
   copy it to the iMac and open it normally on macOS 13. Complete any OS launch acceptance,
   coordinator fingerprint confirmation and owner sign-in. Do not run the CLI installer.
3. Confirm SetupTakeOver names the existing iMac and forma, shows the old all-users plist if
   present, and has made no service/enrollment changes. Choose Leave it as it is; relaunch
   without signing out and confirm it does not ask again. Sign in again to offer the move.
4. Choose Move it to this app. Confirm the node id/name, enrollment file and relay ports have
   not changed and there is no duplicate computer. For a current supervisor install, verify
   its PID is unchanged and continuous requests have no gap. If the program needed repair,
   measure the brief restart and verify forma immediately answers at the same address/port.
5. Confirm `desktop-worker.json` exists for that node and there is one running login service.
   The unused system copy must remain until explicitly selected. Choose Remove older copy,
   cancel the administrator prompt once, check it remains, then retry and approve. Verify
   only that plist/service is removed and the app, agent config and relays remain intact.
6. Confirm the menu shows Running 1 app, forma · healthy, Run apps / Docker is answering,
   and the approved Quit sentence. Turn Run apps off/on and confirm it changes admission
   without stopping forma. Enable Take tasks separately if wanted; its row should coexist.
7. In a planned interruption, make Colima stop answering and wait for the next status probe.
   Check the failing dot, elapsed sentence and Restart Docker / Repair the worker actions.
   Choose Restart Docker, observe progress and verify forma recovers at the original port.
   Exercise first-start retry if the network-helper race occurs. The app must stay responsive.
8. Stop only the login service in a controlled test. Confirm service-stopped offers Repair
   without Restart Docker. Repair it, check it returns to Running and compare config/relays.
   Interrupt coordinator connectivity separately: expect cannot-reach-coordinator, retain
   known app names, restore connectivity, and confirm recovery without another enrollment.
9. Quit the desktop and keep checking forma. Relaunch, then restart/log in to the Mac; verify
   the background worker returns and the tray recovers. Quit during a controlled repair too:
   it must wait for that operation rather than abandon a stopped service.
10. Capture setup/take-over and both tray states at the board widths (1440/700) and compare
    with the approved HTML using the design capture/pair tools. Verify wrapping, keyboard
    focus, scrolling, the disabled Intel screen control, and the documented differences.
    Do not remove the CLI surface or publish this app until this acceptance is complete.
