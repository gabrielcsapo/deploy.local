# deploy.local Desktop

The Electron client loads the coordinator's `/dashboard`. This directory has its own dependency
lock and is not part of the root workspace. It does not install a service or replace Deploy.app.
Closing a window keeps its child worker running; Quit stops that worker.

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

The build reads and bundles `../server/workspace/remote-worker.ts` and its dependencies. The
local `worker.ts` shares a coordinator database and therefore must not run on a desktop client.
The remote worker uses Electron's bundled Node runtime, its own directory inside app user data,
and the existing `/api/workspace/workers/enroll` API. Git and provider CLIs must already be
available on PATH. It does not install them. Provider accounts are discovered by the existing
worker; setup does not claim an account is signed in before that check.

Set `DEPLOY_DESKTOP_HELPER` during **build** to a previously built macOS control helper, or build
`native/ControlHelper/main.swift` into `desktop/build/helpers/deploy-control-helper`. The default
Xcode DerivedData helper is also detected. It is copied into Resources/helpers, then supplied to
the worker only when Use the screen is selected. A release build needs a stable signing identity
and real OS permission acceptance. Windows and Linux screen control are explicitly unavailable.

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
from the packaged `app.asar`, executes their capability audit, checks all six allowed calls and
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
