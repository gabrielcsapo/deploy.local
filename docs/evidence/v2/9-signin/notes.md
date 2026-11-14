# Slice 9 · getting started and sign-in

## Continuation completed

The approved `integration.patch` has been applied to `app/routes.ts` and
`bin/deploy.js`; it is retained as historical evidence and must not be reapplied.
All requested continuation wiring and legacy fixture fixes are committed on
`codex/v2-signin`. Browser visual verification remains blocked by the sandbox.

1. **Dashboard wiring:** Home and Welcome mount PasskeyOffer; Settings › Account
   shares its once-per-account preference and retains an explicit Add a passkey
   action after dismissal. Eligibility requires `isSecureContext`, HTTPS and a
   successful trust resource fetch. An unsuccessful trust check never consumes
   the offer. Home waits for the welcome decision before mounting the offer, so
   switching to Welcome cannot accidentally consume it. Home's banner follows
   its header. `/dashboard/settings/devices` opens the pairing/list/removal page.
   Welcome, New project and Discover routes from the approved patch are wired.
   The new Home/layout route entries have server wrappers, as required by the
   router; the initial unapplied patch incorrectly marked those routes as clients.
2. **FirstTask:** mounted on `/dashboard/tasks/:id` (including Changes/Checks).
   The first display records `firstTaskSeen` per account. Got it hides the hints;
   subsequent navigation and sign-in do not show them again. No task implementation
   from another branch was modified. See the placement difference below.
3. **SessionExpired:** the dashboard layout hosts the dialog, probes every 30 s,
   and responds to unauthorized authenticated fetches. It verifies that the session
   is actually invalid before opening, so a wrong current password does not open
   an expiry dialog. Successful reauthentication updates credentials without
   navigation, preserving the current URL and mounted drafts. Unauthorized render
   errors have a fallback dialog host and retry the router's server tree after
   sign-in, replacing the previous full-page reload. A render error has already
   unmounted its failed subtree; unsaved state inside that failed subtree cannot
   be recovered by this boundary. Ordinary fetch/session expiry keeps it mounted.
4. **CLI:** `deploy login` launches the approval URL, waits for explicit approval,
   and saves the resulting session with mode 0600. `deploy login --password`
   remains functional. `deploy register` makes no registration request and prints
   the `/setup` path, installer-code instructions, and the option to ask an admin.
5. **Legacy fixtures:** `server/test-auth.ts` issues a local setup code through the
   production installer helper in a subprocess, then creates the owner over HTTP
   `/api/v2/setup`. All three legacy HTTP suites use it, and additional accounts
   are registered with the existing admin's credentials. Anonymous registration
   stays closed; a negative HTTP assertion covers it. No production registration
   gate or database schema was changed in this continuation.
6. **Integration:** the real HTTP coordinator flow covers setup-created ownership,
   password sign-in, secure/insecure/HTTP/failed-trust policy cases, a fresh passkey
   registration challenge with SimpleWebAuthn's upstream `none` attestation vector,
   passkey-first policy after registration, password fallback and persistent hints.
   The vector's unsigned client-data challenge is bound to the fresh HTTP options;
   its RP, credential and attestation bytes are retained. Real CLI child processes
   run browser approval and password login against an isolated HTTP coordinator
   within 5180–5199. Browser-launch executables are test stubs that record the URL;
   the test then approves that exact code through the authenticated production API.
   No desktop browser or real coordinator is contacted. This is HTTP/client-policy
   integration, not a successful browser DOM/WebAuthn UI run.
7. **Captures:** the fixture and every capture URL now use **5197**. The fixture's
   Home banner uses the same header slot as production. The capture helper was
   attempted again and Chromium still aborts before opening a page; `capture.log`
   records `bootstrap_check_in … Permission denied (1100)`. The fixture was stopped.

## Earlier slice implementation retained

- Local, expiring single-use setup codes; password-first ownership; recovery status;
  SimpleWebAuthn registration/authentication with challenge, origin, RP, verification,
  signature and counter validation. Migration `0038_v2_auth.sql` and dedicated
  grant/passkey/device/preferences tables were already committed before this work.
- QR device pairing, owner-scoped listing/removal and immediate session revocation.
  Native payload and certificate/APNs integration are documented in `pairing.md`.
- Apps at home lists only discoverable apps and sends signed-in users to Home.
  The existing visibility setting controls discovery, not proxy authorization.
- Welcome/NewProject/Discover/InstallApp use existing project, task and catalog APIs.
  Installer finish/restore helpers exist, but automatic invocation from the real
  coordinator installer remains outside this continuation.

## Design review and differences

Read all assigned board markup, design rules and reference renders at both web
widths and the two 390px phone renders. `design/v2` was not changed.

- **FirstAccount:** uses actual computer name and omits invented release/install
  timestamps. The setup code has 64 bits of entropy (four hex groups), longer than
  the board's eight-character illustration. Real form validation/error/loading
  states replace the sample values. Account name is persisted.
- **RecoverWeb:** real restore status is a marker from the clean-directory recovery
  helper, readable only after authentication. Existing recovery cannot report the
  board's per-app bytes, percentage, ETA or automatic restarts; none are fabricated
  in production. The fixture alone shows the reference's progress data. Recovery
  does not switch or restart an active coordinator and cannot restore in place.
- **WebSignIn:** password fields appear when HTTPS trust or passkeys are absent.
  CLI approval adds explicit matching-code approval/denial. The desktop SignIn
  shell and iPhone scanner UI belong to later clients; only web/native server
  authentication is implemented here.
- **PasskeyOffer / SessionExpired:** built from shared Banner/Dialog/Field/Action.
  The first eligible display persists the offer preference across Home and
  Account; Settings Account also lets a person request a passkey later. Session reauthentication occurs inside the
  dialog without navigation; protected standalone sign-in return URLs keep the
  dashboard path, query and fragment and reject offsite targets. Browser execution
  and focus behavior are not verified due to the Chromium launch failure.
- **Welcome:** does not invent an available model. The composer says Default and
  starts a real task using the configured server default. New-project/app/computer
  actions target their own flows. Existing shell agent/empty-state behavior is
  inherited from slice 0; full first-run sidebar noun suppression is not changed.
- **NewProject:** no fake repository discovery, local-Mac SSH access, automatic
  deploy.yaml PR, placement or address promise. Existing API queues repository
  preparation on SER; the browser cannot inspect a folder on a different computer.
  The unsupported pre-creation discovery/switch controls are omitted.
- **FirstTask:** the three hints match the wording and persist dismissal. The shell now mounts them on task routes, at the top of the task pane.
  This branch's task route is still a placeholder, so the task slice should move
  this single mount below its tabs into the conversation column to match the board.
  The fixture shows that intended location. The three hint cells currently share
  the surface treatment, whereas the board highlights only the first cell.
- **InstallApp:** follows real catalog release/target/questions. The API cannot
  generically set the board's memory, storage-folder and nightly-backup switches;
  unsupported controls and invented capacity claims are omitted. The address comes
  from the actual app name. Installation remains explicitly person initiated.
- **AppsHome / AppsHomePhone:** reuses actual app names; no separate display titles,
  upstream branding, New badges or invented computer placement. Real app addresses
  are `<name>.local` in this repo, unlike the board's `<name>.deploy.local`. Narrow
  layout stacks into the phone's list. The certificate hint downloads the existing
  CA; it does not falsely claim to install trust automatically.
- **InstallSer / CliLogin:** no terminal screenshot parity is claimed. The local
  helper does not install system services, discover recovery media or manage
  per-app restore progress. The browser login helper has no new certificate
  approval prompt. Browser launch is wired; certificate trust remains with the existing transport.

## Verification and evidence

- `pnpm install --frozen-lockfile`: passed; no dependency changes.
- `pnpm typecheck`, `pnpm lint` (existing warnings, no errors),
  `pnpm format:check`: passed before each commit. Logs are adjacent to this note.
- `pnpm build`: passed after correcting the two route wrappers. See `build.log`.
- Focused `node --test --test-concurrency=1 server/api.test.ts
  server/application-api.test.ts server/catalog-api.test.ts server/cli-v2.test.ts
  server/v2/auth.test.ts`: **62 tests, 61 passed, 1 failed, 0 cancelled, 0 skipped**.
  The sole failure is the known Home Assistant readiness assertion. All newly
  added tests and all migrated registration/session tests pass. `focused-tests.log`
  records the result. An initial run left the password CLI test's stdin open after
  successful login; the test now closes its input after sending the password.
- Final `pnpm test`: **714 tests, 697 passed, 4 failed, 0 cancelled, 13 skipped**,
  exit 1. `full-suite.log` includes all output. Exactly the four known failures remain:
  two `ca-profile.test.ts` LibreSSL/profile assertions, `catalog-api.test.ts` Home
  Assistant readiness with Docker unavailable, and `legacy-preserving-update.test.ts`
  reading Linux `/proc/self/fd` on macOS. No new failure or cancellation remains.
- Full-suite isolation: temporary `DEPLOY_DATA_DIR`, unavailable `DOCKER_HOST`,
  test-only failing Docker executable, and the existing
  `docs/evidence/v2/1-inbox-api/test-guard.mjs` preload restrict listeners to 5180–5199.
  As in the agents slice, a temporary preload changes the runner's concurrency
  argument from 4 to 1 to avoid test-port collisions. No test-runner source was
  changed. Temporary databases and all processes started here were removed/stopped.
- `captures.md` lists every exact fixture URL, width and height for the orchestrator.
  **No captures or pairs exist; visual parity, keyboard focus and browser draft
  restoration remain unverified.** The boards were inspected at 1440 and 700;
  no design source, live service, worker, container or other worktree was changed.

## Next slice / orchestrator

1. Run and inspect the captures from `captures.md` on a machine that can launch
   Chromium. Include Account/Devices and the CLI approval web state. Confirm
   dismissal, keyboard focus, secure-context gating and retained drafts in a browser.
2. When integrating the task page, move the existing single FirstTask mount from
   `v2-layout.client.tsx` into its conversation column below the tabs. Do not add a
   second mount. Its preference is already shared and persistent.
3. Wire the real coordinator installer to `finishInstall`; ownership codes must
   still be issued locally, never through public HTTP.
4. Native clients should follow `pairing.md` and bind APNs registrations to paired
   device IDs so revocation also stops push delivery.

## Visual review (added by the orchestrating session)

Captured with the fixture on 5197, and paired at 1440 and 700, plus AppsHomePhone at 390 (`<Board>-<width>.png`, board left).

**Matches:** FirstAccount, RecoverWeb, Welcome and FirstTask match in structure and wording.

**Intended differences:**

- WebSignIn and SessionExpired show the password form, because the fixture account has no passkey. Per decision 14, the passkey is offered first only when the account has one.
- PasskeyOffer does not appear over plain http. That is correct (no secure context), but it means the banner is unverified visually.

**Differences to polish:**

- AppsHome tiles are grey letter squares, not the board's colored app icons.
- NewProject lacks "Found in the repository" and the runs-on/address fields.
- InstallApp lacks the board's where-it-runs, data and first-account sections.
