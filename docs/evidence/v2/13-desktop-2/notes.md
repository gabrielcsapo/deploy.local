# Slice 13 part 2 — desktop

Implemented only in `desktop/` and this evidence directory, on `codex/v2-desktop-2`. No live
coordinator, installed application, service, worker or container was stopped or reconfigured.
No application was installed into `/Applications`. No schema, server, shared contract, web app,
design source, root manifest or lockfile changed. The tracked pnpm cache install side effect
was restored.

## Implemented, by task item

1. **Tray:** board-sized 340px popover, brand/coordinator/connection header, Waiting on you with
   the attention SVG, title, author, reason and elapsed time; Live summary plus failing and warning
   apps with state dots; this computer's reported activity; Take new tasks; New task, Open
   deploy.local and Quit with native shortcut labels. Cmd/Ctrl+N and Cmd/Ctrl+O are wired in the
   application menu; Quit uses the native quit command. App rows open their Live detail, decisions
   open Review, and the computer name opens roles. The transparent frameless window preserves
   the rounded popover. Long lists scroll rather than dropping decisions.
2. **Menu bar:** decisions alone determine the count. Failing, warning and offline are separate
   dot states; healthy has no dot. Live failures never increase Waiting on you. macOS renders
   the count with Electron's native tray title; Windows/Linux render the digits in the image,
   independently of the dot. Counts above 99 render as 99+; the tooltip keeps the exact count.
   The mark follows the OS light/dark theme. The generated count image was visually inspected;
   native tray-host sizing still needs Windows/Linux acceptance.
3. **Data and task switch:** the client retains the full Live response, including per-computer
   app health. Computer inventory supplies coordinator name, online count and this worker's
   activity. Take new tasks PATCHes that computer's existing roles, preserving all other roles.
   It uses the coordinator's admission checks; it does not stop/restart the worker or interrupt
   its current task. Missing inventory disables the switch; permission/API errors remain visible.
4. **Tokens:** each desktop build copies `app/design-tokens.css` into `desktop/assets/`. The shell
   reads only that packaged copy, including light/dark colors. Fonts remain bundled locally.
5. **Roles:** checked `server/v2/computers.ts` and the computers handoff. Run apps and Serve models
   are still refused with 409 because independent runtime reconfiguration is absent. A remote
   workspace worker does not advertise either capability. Both setup switches stay disabled with
   the reason. No runtime, model service or app is silently installed.
6. **Electron captures:** added `pnpm --dir desktop run capture:electron`, an isolated coordinator,
   a temporary profile/in-memory credential store and a worker double. It exercises password
   sign-in and real v2 endpoint shapes, simulates Linux setup through a platform flag, captures
   Setup, SetupLinux, Permissions, Tray, Offline and the exact native notification content, and
   checks the admission switch. It cannot enroll or start a real worker. Its origin must be
   `http://127.0.0.1:5184`; mDNS/hostname discovery is disabled. Both debugger listeners use port
   5185 on separate loopback families. Capture hooks reject packaged apps and persistent profiles;
   the fixture runtime is excluded from the application archive. No renderer capability was added.
7. **Packaging:** added `package:check` for an unsigned unpacked current-platform application,
   using the installed pinned Electron runtime and a writable build cache. The check extracts
   both preloads from the built `app.asar`, executes the exact six-capability audit, checks the
   nested method sets and forwarded IPC calls, rejects extra shell globals, verifies token equality
   and the bundled worker, and ensures the fixture runtime is excluded. README documents the
   exact macOS/Windows signing and three macOS notarization credential methods. Release credentials
   remain environment-driven; this check never publishes, signs, notarizes or installs.
8. **Tests:** added attention/no-literal-exclamation-marker, health/count independence, reason/time,
   unavailable data, admission preservation, full Live response, fixture isolation/enrollment
   refusal, v2 fixture envelopes, and packaged preload audit regression coverage. The opt-in real
   coordinator test now expects the existing Live API instead of its former absence.

## Visual evidence and deliberate differences

Read the brief, both design READMEs, the part-1 handoff including Visual review, all six board
sources and the 1440/700 renders. **Visual parity is not signed off.** Electron failed before
opening a window; headless Chromium failed at `bootstrap_check_in … Permission denied (1100)`.
No native screenshots, renderer screenshots or pairs were produced, so none could be inspected.
The user-requested fallback is committed: `fixture-server.mjs`, the Electron capture script and
`captures.md` with exact URLs, sizes, commands and pairing instructions. No computer-use fallback
or sandbox bypass was attempted. Both fixture listeners were stopped.

- **Tray:** uses the real inbox `text` for the reason; the contract does not have separate short
  tray and long notification copy. Long reasons ellipsize and retain the full text in a tooltip.
  The fixture's rollback reason therefore starts with the Notification board's full explanation
  rather than its separate “sync worker failing” caption. Computer activity has no start time,
  so no invented “12m” task duration. There is no battery pause implementation: the switch says
  “Current tasks keep running” instead. Its action preserves that promise through admission.
  Missing Live/inventory is Unavailable, not zero or healthy. Other warning causes read Warning;
  only a reported numeric memory warning reads High memory. The popover's computer-name action
  replaces the old extra Computer roles menu row while retaining access to setup.
- **Menu bar:** added warning/offline dots; the board only illustrates healthy, decisions and
  failing. Windows/Linux use raster digits because native tray titles are macOS-only; counts
  above 99 display 99+ with the exact count in the tooltip. Native OS sizing remains unverified.
- **Setup / SetupLinux:** retain part 1's structure and honest provider availability. Run apps /
  Serve models remain disabled because the API rejects them. Linux screen control is unsupported;
  macOS requires a built helper. Fixture hardware is simulated, and its Use the screen capability
  is simulated only for the Permissions capture. Production hardware/helper detection is unchanged.
  The simulated Linux run uses the host OS's native frame.
- **Permissions:** both rows open System Settings; no Allowed state is invented without proof of
  the actual helper's permission identity. No OS permission was granted during this work.
- **Offline:** retains part 1's truthful last-known session data and retry actions. It makes no
  checkpoint, durable snapshot or queued-draft guarantee. The fixture address is loopback, not
  the board's real deploy.local. Native window size remains the shell's 720×800; the renderer
  comparison uses the board's wider 880px frame.
- **Notification:** uses the exact native Notification title/subtitle/body/actions. Its content
  capture is an Electron content window plus JSON, not an OS notification-center screenshot or
  proof of delivery. Native typography/buttons/delivery still require each release OS. No terminal
  background or second notification is fabricated in the content comparison.
- Renderer previews center the relevant window on a neutral backdrop rather than rebuilding the
  board's unrelated desktop, Live page and Terminal. Native page captures exclude OS title bars.

## Validation

- Root `pnpm install --frozen-lockfile`: passed. Desktop frozen install: passed. The pinned
  Electron installer succeeded with a temporary writable cache after the default cache was denied.
- `pnpm typecheck`: passed. Root TypeScript does not type-check the desktop JS; focused tests and
  syntax checks cover the new modules.
- `pnpm lint`: passed, existing warnings and no errors.
- `pnpm format:check`: passed.
- `node --test desktop/test/main.test.mjs desktop/test/capture.test.mjs desktop/test/coordinator.test.mjs`:
  **18 passed, 0 failed, 1 skipped** (`unit-tests.log`). The opt-in real-coordinator integration
  test is skipped because this task uses a no-enrollment fixture, not a real coordinator.
- `pnpm --dir desktop run package:check`: passed on macOS arm64. Artifact:
  `desktop/dist/package-check/mac-arm64/deploy.local Desktop.app`. The control helper is unavailable
  in this checkout's build inputs; Use the screen stays unavailable in production. Earlier check
  attempts exposed the protected user cache and downloaded CommonJS icon tool under an ESM parent;
  the command now uses a local cache with the correct package boundary and passes without extra
  environment settings. No signing credentials were used.
- Final full `pnpm test`: **731 tests: 669 passed, 10 failed, 39 cancelled, 13 skipped**, exit 1
  (`full-suite.log`). All v2 API suites passed in this final run. Isolation uses temporary data, an unavailable
  Docker socket plus a fixture-only docker command, blocked UDP/mDNS and only ports 5184/5185.
  The root command runs with test-file concurrency reduced to one by the evidence preload.
  The initial strict guard rejected tests scanning from 5180, producing 696 tests: 604 passed,
  40 failed, 39 cancelled, 13 skipped. `full-suite-initial.log` preserves that run. The final guard
  treats unassigned scan ports as occupied, allowing those tests to reach 5184/5185, and releases
  reservations on server close. Remaining failures: two CA-profile assertions (system OpenSSL
  compatibility and an expected exception); the Linux `/proc/self/fd` fsync assumption on macOS;
  two legacy API socket failures; CI HTTP and transcription unable to acquire both test ports;
  compatible-agent, repositories and workspace test files exceeding the 90-second isolation
  watchdog. Legacy API/application/catalog startup socket failures also caused 39 cancellations.
  These files are outside the desktop scope; port/isolation failures are explicitly not claimed
  as product regressions or as passing. No broader server changes were made to suppress them.

## Next slice / remaining acceptance

- Run the committed native and renderer captures on an allowed host, inspect and pair them, and
  correct remaining visual differences before calling desktop parity complete or retiring DeployMac.
- Capture the numeric tray icon and state dot on Windows/Linux, where tray hosts can resize
  images differently. The fallback is implemented and unit-tested; native sizing is unverified.
- Verify native notification delivery/actions, keyboard navigation, native frames and permission
  prompts on each target OS. Package Windows and Linux on their own hosts; sign/notarize macOS
  using release credentials and supply the signed control helper.
- Keep Run apps and Serve models disabled until the computers API and real runtime support
  configuring them. No contract was changed to pretend they work.
- The computer activity contract has no task start time; a duration requires authoritative data.
  Battery pause, durable offline snapshots and provider availability remain part-1 follow-ups.

## Launch fix and native captures (added by the orchestrating session)

- **The app could not start.** In Electron 44, an ES-module main process that awaits at the top level (`await app.whenReady()`, or the fixture's `await import(...)` before it) never becomes ready. Minimal repro: `import { app } from 'electron'; await app.whenReady(); console.log('ready')` prints nothing, while `app.whenReady().then(...)` works. This affected the merged part-1 app in normal use, not only captures.
- **The fix:** `src/main.mjs` now runs its startup in `start()`, via `app.whenReady().then(start)`, and loads the fixture runtime inside it. `showTray` stays at module scope for `captureFixture`.
- **The capture script:**
  - No longer forces both debuggers onto port 5185 (that stalled the launch); Playwright picks the ports.
  - Calls `globalThis.deployCaptureFixture`, because `electron.evaluate` cannot `import()`.
- **The captures:** `pnpm --dir desktop run capture:electron` produced every image in `native/`. `requests.json` shows only login, reads and one fixture role PATCH, with no enrollment. Pairs are in `<Board>-native-pair.png`, board left.
- **Matches:** Tray, Setup, SetupLinux and Permissions match their boards.
- **Offline differences:** the page names the coordinator by its URL, and lacks the "Your task · Paused" row.
- **Tests:** desktop tests pass 18, skip 1; format and lint are clean.
