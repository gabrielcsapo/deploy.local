# Slice 9 · getting started and sign-in

This is a partial slice, with the backend and scoped UI implementation ready for
integration. Two explicit file-boundary questions remain unanswered: production
CLI/dashboard wiring, and updating the three legacy HTTP test fixtures that use
anonymous registration. `integration.patch` is a concrete, unapplied patch for
the first question, validated with `git apply --check`. Do not report this as a
complete working onboarding flow until those integrations are applied and tested.

## Implemented per task

1. **Setup:** 30-minute, single-use local setup codes; atomic first-owner creation
   with username/password (12-character minimum); existing accounts refuse setup.
   Password storage and normal sessions reuse existing scrypt/auth functions.
   `/setup` is registered. Anonymous `/api/register` is closed; existing admins
   can create additional users. Migration `0037_v2_auth.sql` adds dedicated auth
   grant/passkey/device/preferences tables to the main recovery-backed database.
   `setup-installer.ts` is a local finish-install entry point: fresh creates the CA
   through existing helpers and prints the code, expiry, URL and full SHA-256 CA
   fingerprint; recover invokes the existing clean-directory bundle restore.
   The existing public `/install` only installs the CLI. Its next-step wording is
   updated, but it cannot mint remote ownership codes. No coordinator bootstrap
   installer exists in this checkout; automatically calling the new local entry
   point from the real installer remains an integration task.
2. **Passkeys:** all four options/verify endpoints use SimpleWebAuthn 14. Challenges
   expire in five minutes and are consumed on every verification attempt. Origin,
   RP ID, user presence/verification, signature and counter are verified. Password
   sign-in remains available. `/signin` supports passkey-first sign-in when a
   passkey exists and HTTPS trust succeeds. Registration banners and Account
   controls are built. SessionExpired preserves the mounted page and drafts,
   opens a modal over a blurred backdrop, and probes session validity every 30 s.
   The dashboard mount and Home/Account routes await the wiring patch. Existing
   AuthErrorBoundary still reloads on unauthorized server-action errors: its owner
   should dispatch `deploy:session-expired` instead to preserve that error path.
3. **Pairing:** authenticated QR issuance, five-minute token exchange, owner-scoped
   listing/removal, immediate session revocation. The Devices page generates a
   real QR locally with qrcode; route wiring is pending. Native payload, certificate
   pinning, 30-day token lifetime and APNs handoff are in `pairing.md`.
4. **CLI:** browser-login orchestration, same-origin approval URL validation,
   polling/timeout/denial, and save callback are implemented and tested in
   `bin/cli-v2.mjs`. Browser approval is available at `/signin?cli=<userCode>`.
   `bin/deploy.js` is outside the explicit boundary: `deploy login` still invokes
   its existing password flow. The unapplied patch adds browser launch, persistence
   with mode 0600, and `--password` compatibility. Certificate trust remains owned
   by the existing CLI transport; this slice does not implement a new trust prompt.
5. **Apps at home:** `/` now uses the public launcher, lists only existing
   `discoverable=true` apps, links their real `.local` addresses, shows the CA hint,
   and sends authenticated users to Home. `/discover` already redirects to `/`.
   No new visibility schema field was necessary. Existing visibility is launcher
   discovery, not an app-proxy authorization boundary; this slice does not add
   proxy access enforcement.
6. **First run:** Welcome, NewProject, FirstTask hints and Discover/InstallApp
   components use real project/task/catalog APIs. Project creation supports a
   remote repository, a folder on SER or an empty repository. Install uses actual
   catalog releases, targets and configuration questions. FirstTask dismissal is
   persisted per account. The route patch mounts Welcome/NewProject/Discover;
   the task-page agent must mount FirstTask in its owned conversation page.
7. **Tests:** setup expiry/replay/owner refusal, upstream registration vector,
   real P-256 signed authentication with bad origin/RP/UV/counter/replay rejection,
   device exchange/isolation/expiry/revocation, CLI approval/poll/expiry/denial and
   client persistence, launcher visibility, safe return destinations, and HTTP
   public/protected routing and cross-origin mutation rejection.

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
  Dismissal/success persists the offer preference; Settings Account also lets a
  person request a passkey later. Session reauthentication occurs inside the
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
- **FirstTask:** the three hints match the wording and persist dismissal. Component
  is ready for the task agent; this branch's task route is still a placeholder.
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
  approval prompt. See integration limitations above.

## Verification and evidence

- `pnpm install --frozen-lockfile` passed; added SimpleWebAuthn server/browser and
  qrcode with pnpm, updating the lockfile. The tracked pnpm cache was restored.
- Typecheck, lint (warnings only), formatting and production build pass.
- Focused `node --test server/v2/auth.test.ts server/v2/api.test.ts server/cli-v2.test.ts`:
  **33 passed, 0 failed**. All test listeners use 5180–5199 and all data is temporary.
- Full `pnpm test`: **709 tests; 662 passed, 19 failed, 15 cancelled, 13 skipped**,
  exit 1. **This change causes legacy auth fixture failures**, because anonymous
  `/api/register` correctly returns 401 now. `api.test.ts` has 16 failed cases;
  `application-api.test.ts` and `catalog-api.test.ts` cancel 15 cases when their
  registration setup fails. Those three files are outside the explicit scope;
  permission to update only their auth setup/assertions remains pending. The other
  three failures are the two unchanged LibreSSL CA-profile assertions and the
  unchanged Linux `/proc/self/fd` assumption on macOS, recorded in earlier slices.
  No fresh baseline run was done. No v2 auth test failed.
- Full suite used temporary `DEPLOY_DATA_DIR`, an unavailable Docker socket and
  the existing `1-inbox-api/test-guard.mjs` to restrict listeners to 5180–5199.
- `fixture-server.mjs` and the transformed page modules return successfully via
  read-only loopback requests. Chromium aborts before opening a page; `capture.log`
  preserves the error. **No captures or paired images exist.** `captures.md` lists
  exact URLs, dimensions and commands. Visual parity remains unverified.
- No live service, worker, container, installed app, other worktree or design source
  was modified. The only fixture process was stopped. No push/merge/rebase.

## Next slice / orchestrator

1. Resolve the pending boundary approval and apply `integration.patch` (router and
   CLI only), format it, then rerun static checks and real command/browser tests.
2. Migrate the three old HTTP test fixtures to local setup-code provisioning and
   admin-authorized secondary registration. Keep a negative anonymous-registration
   assertion. Do not reopen public registration just to satisfy old tests.
3. Mount FirstTask in the task page; change the shared unauthorized error boundary
   to trigger the session dialog. After restore, refresh failed server-rendered
   resources without discarding unsent content.
4. Wire the actual coordinator installer to the local `finishInstall` entry point;
   preserve the rule that ownership codes are never issued through public HTTP.
5. Pair native clients as documented, bind APNs registrations to paired device IDs,
   and revoke push delivery along with the session. Existing APNs records currently
   have no such relationship.
6. Run all captures and inspect the pairs before marking visual parity complete.
