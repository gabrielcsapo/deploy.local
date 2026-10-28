# Slice 13 — Electron desktop

Implemented only in `desktop/` and this evidence directory. The root workspace, lockfile, web app,
server, shared contracts and CLI are unchanged. Existing Deploy.app and live services were not
installed, replaced, stopped or reconfigured. This slice does **not** yet reach native visual parity;
retain DeployMac until the remaining acceptance below is completed.

## Implemented

- A sandboxed, context-isolated Electron window loads the coordinator's `/dashboard`. The default
  address is `https://deploy.local`, resolved by the OS, and setup accepts another HTTPS origin.
  HTTP is restricted to loopback development.
- Password login calls `/api/login`. The SHA-256 fingerprint must be explicitly compared and
  confirmed before the first HTTPS login. Main, worker, and the isolated Chromium session use
  that certificate pin. Validity dates are checked and changed certificates fail closed. No OS
  certificate installation or global TLS bypass is used. Worker Git gets the CA only through
  the pinned connection, with CA/hostname checking scoped to the coordinator origin.
- `safeStorage` encrypts login and worker credentials, refusing the Linux plaintext backend.
  Coordinator requests receive the existing username/token headers from main. A non-secret
  localStorage marker bridges the existing web UI's signed-in check; the real token stays in main.
- Tray popover: Waiting on you, Live summary, this computer's actual worker state, roles, web
  shortcuts and Quit. Missing `/api/v2/live` reads Unavailable. Typed inbox events update the
  model with cursor continuation; replay does not duplicate notifications. Decisions use the
  v2 answer endpoint with `on: 'desktop'`, including 409 conflicts. Native notifications open
  Review, with supported macOS action buttons. Other platforms retain click-to-review.
- Role setup enrolls the existing HTTP workspace worker, bundles its source and dependencies,
  and manages its process with restart backoff, heartbeat state, and shutdown on Quit/IPC loss.
  Closing the window leaves it running. The coordinator-local database worker is intentionally
  not used on a remote computer. Take tasks and macOS Use the screen are wired.
- The existing macOS control helper is bundled when available and selected with
  `DEPLOY_DESKTOP_HELPER`. It was compiled from the unchanged native source for this package.
  OS settings links do not grant permission. Screen requests use the existing per-task inbox;
  active sessions on this worker get an always-on-top bar with elapsed time, Pause (takeover)
  and Stop. The helper and server remain responsible for target scope, leases and expiry.
- The remote preload exposes exactly the six requested capabilities, with nested worker/control
  methods. Main validates the webContents, frame and coordinator origin. Internal shell pages
  have a separate preload that exposes no page global. External links are limited to HTTP(S).
- Offline state retries every ten seconds, keeps last-known session data distinct from current
  health, and offers another coordinator. It does not queue or replay decisions.
- electron-builder config includes dmg, nsis and AppImage/deb. Signing/notarization credentials
  are environment-only. An unsigned Apple Silicon app successfully packaged with the worker,
  helper, fonts, icons and preloads under `desktop/dist/mac-arm64/deploy.local Desktop.app`.

## Visual evidence and differences

All eight requested board renders and their source markup were inspected. Native screenshot
acceptance could not be completed in this environment:

1. Electron GUI launch from the shell terminated with SIGABRT.
2. Automatic Computer Use approval rejected opening the built app: “Computer Use was not
   approved to use deploy.local Desktop.” No confirmation override was requested.
3. Chrome native access returned `cgWindowNotFound`, and its browser surface was unavailable.
4. Headless Chromium failed at `bootstrap_check_in … Permission denied` in the sandbox.

Consequently there are **no native screenshots and no paired PNGs**. `previews/*.html` are
reproducible fixtures rendered by the actual `desktop/src/views.mjs`, using the board names
SER, MacBook Pro, bazzite, Scout and Warden. They are explicitly labeled as renderer fixtures.
They are useful for review, but are not a claim that the native window/tray/notification has
been visually verified. `desktop/scripts/capture.mjs` captures these at 1440 and 700 and invokes
`design/v2/tools/pair.py` on a capable host. Native acceptance must then capture the running app,
tray and OS notifications separately. The new app icon was inspected as a PNG.

Deliberate differences from each board:

- **Setup / SetupLinux:** same step order, heading, computer/provider group, four role rows and
  footer choices. Hardware is discovered, not hard-coded. Provider rows say availability will
  be checked after joining, because the current worker probes it after startup. Run apps and
  Serve models are disabled with an explanation: the workspace worker has no corresponding
  role or hosting/enrollment API. No app runtime or model service is installed silently.
  Linux/Windows explicitly say screen control is unsupported; the Linux board's enabled
  screen-control toggle would be incorrect. There is no battery-aware pause rule yet.
- **Permissions:** same two OS permissions and per-task explanation. Both link to System
  Settings rather than showing “Allowed” without proof of the helper's permission identity.
- **Tray:** same groups and ordering. It uses the real summary and inbox rather than inventing
  per-app failure detail absent from the summary. No fabricated task count, queue statistics,
  computer count or paused-on-low-battery claim. Roles opens setup; Take tasks can be stopped
  there. The popover has an ordinary native context-menu fallback.
- **Notification:** native OS delivery, typography and available buttons govern the layout.
  macOS offers Review plus an available defer/deny action; consequential actions are reviewed
  through the same inbox flow. Delivery/action behavior is not verified on any OS here.
- **ScreenAsk:** the desktop's review dialog shows server-provided title, reason and actions,
  rather than reimplementing the out-of-scope task conversation. It does not offer Whole screen
  or a larger scope than the server request. The server currently grants its existing session
  lifetime; the desktop never invents a 15-minute limit. The preview fixture describes the board's
  scope, but live UI renders the actual request text.
- **ScreenWatch:** the floating status bar is implemented; the task transcript and target window
  remain owned by the coordinator web UI and macOS. Pause transfers control to the user; Stop
  invalidates the session. No fake Simulator contents, pointer label or window border are drawn.
- **Offline:** the same hierarchy and recovery actions are present. Last known is session memory,
  not a persistent offline snapshot. The current worker stops interactive control when disconnected;
  other tasks are not claimed to be paused at a checkpoint. The shell does not promise unsent
  drafts are queued or that nothing can be lost, since that requires web/worker guarantees.
- The local chrome uses Hanken Grotesk bundled with the app, the board's light neutral hierarchy,
  a corresponding dark palette, native focus/keyboard form controls, and responsive insets.
  Real window decorations and OS notification chrome replace the boards' simulated desktop.

No design/v2 files were changed, as required by the task boundary.

## Validation

- Root `pnpm install --frozen-lockfile`: passed. Only the tracked pnpm cache database changed as
  an install side effect and it was restored; root workspace/lock contents are unchanged.
- Desktop `pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts`: passed. The
  pinned official Electron runtime was downloaded using its installer and a temporary cache.
  Early installer attempts used a non-writable user cache, then were corrected. An initial
  Electron 45.1 selection was rejected by the package manager's release-age policy; the lock
  now uses Electron 44.9.0, which passes the policy.
- `pnpm typecheck`: passed. Root TypeScript checks do not type-check the desktop's JS modules;
  the focused runtime tests exercise them.
- `pnpm lint`: passed with existing root warnings, no errors; desktop code has no lint findings.
- `pnpm format:check`: passed.
- `node --test desktop/test/main.test.mjs`: **10 passed**. Covers origin restrictions, replay and
  external answers, unknown Live state, exact preload surface, secure storage, role restrictions,
  worker lifecycle, control generation, escaping, feature detection and desktop provenance.
- `DESKTOP_TEST_ORIGIN=https://127.0.0.1:5198 node --test desktop/test/coordinator.test.mjs`:
  **1 passed** against the actual `pnpm server`, including self-signed TLS rejection, changed-pin
  rejection, confirmed-pin password login, absent Live, enrollment and bundled worker heartbeat.
  Repeated with the Electron executable as the worker runtime: **1 passed**. The server used a
  temporary `DEPLOY_DATA_DIR`, disabled Docker access and a test preload blocking mDNS/ports
  outside 5180–5199. No app deployment or live enrollment was performed. An initial IPv4 port collision failed
  during the credential-free TLS probe; the isolated coordinator moved to 5197/5198.
  All coordinator and Vite servers started here were stopped after validation.
- Full `pnpm test`: **636 tests, 619 passed, 4 failed, 13 skipped, 0 cancelled**. Failures match
  the preceding slices: two CA-profile tests (system OpenSSL compatibility/expected correction),
  Home Assistant readiness with Docker unavailable, and `/proc/self/fd` in the legacy update
  fsync test on macOS. See `full-suite.log`. Tests used the existing slice 1 isolation guard.
- Unsigned macOS packaging: passed, with bundled helper and branded icon; see `package.log`.
  The helper compiled without source changes; compiler output contained sandbox helper warnings
  but produced the arm64 Mach-O executable. The app was not installed or copied to Applications.

## Remaining acceptance and next slice

- Enable independent Run apps / Serve models only when their real enrollment/runtime contracts
  exist. Their present disabled state is an explicit gap against the task, not working roles.
- Confirm native window, tray placement, notification delivery/actions, keyboard navigation,
  permission prompts and the screen status bar on an allowed Mac; capture and pair evidence.
  Also test Windows/Linux packaging and runtime. Do not retire DeployMac before this parity.
- Sign and notarize with release credentials. Verify a stable helper identity and OS permission
  grants on real hardware; no screen capture/input permission was granted in this session.
- Integrate with the parallel Live slice's summary `{ running, failing }` fields. Until that API
  exists, Unavailable is intentional. Inbox event/answer integration is already real.
- Migrate old web server actions that authenticate explicit token arguments to the existing
  request headers/cookie. The secure desktop marker satisfies UI checks but is not a real token;
  an old action using it as credentials may reject the action. Web files were outside scope.
- Add persistent offline snapshots, battery-aware pause and provider status in setup only with
  reliable data. Existing local drafts remain the web app's responsibility.

## Visual review (added by the orchestrating session)

The renderer previews in `previews/` were captured with `design/v2/tools/capture.mjs` (headless Playwright Chromium) and paired with their boards (board left, implementation right): `Tray`, `Setup`, `SetupLinux`, `Permissions`, `ScreenWatch` and `Offline` at 1440. Raw captures are in `captures/`. These are the window and tray renderer pages, not the native Electron frame.

- **Setup, SetupLinux and Permissions** match their boards closely. The intended differences are the honest provider availability and the disabled Run apps / Serve models roles.
- **The tray popover does not match yet.** Decisions show a literal `!` instead of the attention glyph, and the rows lack their icons, status dots, timestamps, the Live app rows and the Take new tasks toggle. It reads as a text menu, while the board shows a popover. This is listed for desktop part 2.
- **Still unverified:** the native launch with real screenshots, notifications on each OS, and signing.
