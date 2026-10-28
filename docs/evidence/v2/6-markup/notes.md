# Slice 6 · Composer, screenshots and markup

Implementation is committed on `codex/v2-markup`. **One integration change remains
unapplied, and visual/runtime capture acceptance is not complete.**

## Done

1. The shared Composer works on Home, task and agent URLs without editing those
   page modules. It uses browser file/camera pickers, uploads files, shows removable
   chips, browses saved project files, reads Computers › Models, and sends the
   selected model only with this chat's request. Auto reads the job default; no
   default-setting endpoint is called. Selection lasts for the mounted chat.
   Home creates a scratch task; task replies retain the existing task. Other
   Composer consumers retain their supplied callback (with an optional rich message).
2. Uploads use raw bytes at `POST /api/v2/attachments`, `Content-Type` and a
   percent-encoded `X-File-Name`. There is a 10 MiB per-file limit, an eight-file /
   20 MiB per-message limit, a MIME allowlist and signature/UTF-8 checks. Owner
   records refer to the existing content store. Download responses are private,
   no-store and nosniff; non-images download as files. SVG/HTML are not accepted.
3. Screenshot requests queue on the task's assigned worker. Local and remote
   workers poll, claim with a single-use lease, capture, and return image bytes.
   Completion stores screenshots and raw `v2.conversation` screenshot events.
   Owner, worker assignment, expiry and desktop permission are checked. Requests
   expire after 60 seconds rather than capturing unexpectedly later.
4. Worker capture code uses isolated headless Chromium contexts for web widths
   (320–2560, up to three), `xcrun simctl` with an explicitly booted simulator UUID
   on macOS, or the existing desktop helper's `inspect` action. Desktop requires
   the exact task/window's active, unexpired Use the screen session plus its role.
   No physical-device command, personal browser profile or live embed is used.
5. Screenshots open the Markup dialog. Pen, Arrow, Text, Undo and red/yellow/blue
   annotations use original-image pixel coordinates. Send uploads a flattened PNG,
   PATCHes the source screenshot with both Markup and that image reference, and
   submits the image as a task follow-up. Failures retain the draft. The original
   image remains unchanged. Authenticated image loading supports header credentials.
6. Task workers materialize attachment bytes under a private, Git-ignored directory
   in the task checkout. The prompt includes paths and the full structured marks.
   Codex receives image paths through `--image`, including on resumed runs.
   Compatible agent chats receive image inputs directly. See the provider table.
7. Eight focused server tests cover upload limits/types, ownership, worker request
   → event, markup round trip, desktop permission/revocation, message attachment
   binding, model overrides/default preservation, actual provider request bodies,
   and private/Git-ignored file fallback. Four existing conversation tests also pass.

## Required integration outside this task's file boundary

`server/v2/events.ts` currently drops every screenshot event and replaces user
attachments with an empty array. The allowed server files did not include this
mapper. An asynchronous scope question was sent; no answer was received. Therefore
`integration.patch` is prepared but **not applied**. It adds the screenshot mapper
and preserves stored message attachments (one import and four small line changes).

Until this patch is applied, production task snapshots and the shared event feed
omit new screenshot events and user attachment chips. The capture/storage APIs,
markup editor and provider inputs work independently, and the fixture supplies
explicit typed events, but the complete production gallery flow is **not done**.
Apply the patch, then run the event and task snapshot tests plus an end-to-end
request → event-feed → gallery check. No page-handler changes are needed: Composer
uses the new scoped endpoints itself. Agent pages currently pick up replies on
their existing 10-second refresh; task pages retain their existing polling.

## Provider inputs

| Context                     | Image handling                                                                                                  | Other files and marks                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Codex task, local or remote | Native CLI `--image` for PNG/JPEG/WebP/GIF; verified with this machine's `exec --help` and `exec resume --help` | Private files plus full Markup JSON and text descriptions in the prompt            |
| Claude task                 | File fallback through its existing Read/file tooling                                                            | Private files plus Markup JSON/text; the existing text-stream wrapper is unchanged |
| Compatible task             | File fallback; no vision capability is assumed for the endpoint                                                 | Private files plus Markup JSON/text                                                |
| Agent chat                  | Compatible `/chat/completions` image_url data input                                                             | Text/JSON files as text and Markup JSON; PDF/ZIP/Office files require a task       |

Agent chats retain the earlier slice's no-tools compatible endpoint behavior.
Claude/Codex selections for that context return an explicit unsupported-context
error instead of silently substituting a model. Endpoints without image support
can reject images; the error retains the composer draft. Tests use a local fake
provider and do not call paid or live models.

## API / iPhone handoff

- `POST /api/v2/tasks/:id/screenshots` takes `{ target, widths }` and waits for
  `{ screenshots }`. Web target has `url`; simulator/desktop has `device` (the UUID
  or approved helper target ID). Optional `text` records the user's request.
- `GET /api/v2/tasks/:id/screenshots` and `GET /api/v2/screenshots/:id` are owner-scoped.
- Stored screenshot records also contain `width`, `height`, `workerId` and
  `requestedAt`; these are additive JSON metadata, not contract type changes.
- `PATCH /api/v2/screenshots/:id` accepts `{ markup, renderedImage? }`. `renderedImage`
  is the ref from uploading the flattened image. Include it when sending markup:
  its attachment record carries the full strokes/texts to workers and providers.
  Merely PATCHing marks stores editable annotations but does not flatten the image.
- Points/text positions use original pixels, colors 0 red, 1 yellow, 2 blue.
  `strokes` supports pen and arrow; `texts` supports x/y/text/color. Undo is local.
- `POST /api/v2/composer/messages` accepts text, attachments, optional taskId,
  model choice ID (e.g. `codex:<model>`), and optional revision. With no taskId it
  creates a scratch task. `model: null` follows the writing-code default.
- `POST /api/v2/composer/agents/:id/messages` uses the answering-questions default
  and returns the agent conversation. Neither endpoint changes global defaults.
- Project-file browsing is a saved repository snapshot, not a live worker file
  browser. The existing repository reader limits selected files to UTF-8 / 256 KiB.
- Workers need these new bundles before capture is available. Existing running
  workers were not restarted or modified. The native agent should use the owner
  APIs; `/screenshots/worker/*` is reserved for worker credentials.

## Board review and deliberate differences

Read the brief, design README, design-system README, named board markup and CSS,
Home/MarkupDesktop/NewProduct at 1440 and 700, and all seven read-only phone boards.
No design source, native code, database schema or other worktree was changed.

- **Home:** same shared composer structure. Attach/model controls now work; model
  labels come from the API, with Auto when unavailable. Voice remains disabled
  because this slice did not add dictation. Attachment chips and native file pickers
  appear when used. The foundation's static project/computer chips and surrounding
  Home content remain; this slice does not add project/computer selection.
- **NewProduct:** preserves the existing aspect-ratio gallery and horizontal overflow.
  Images open markup rather than a new browser tab. Production labels use actual
  target/width metadata, without claiming Safari or a capture computer's display
  name. Existing work logs remain initially folded. Screenshots are never live apps.
- **MarkupDesktop:** follows the 760px dialog, compact toolbar, centered 260px phone
  image, annotation colors and composer footer. No Box tool: the settled contract
  specifies Pen/Arrow/Text. Arrow and Undo use available symbols. File glyphs stand
  in for the board's eye icon, which the shared v2 icon set lacks. Count includes
  every stroke and text, rather than the board's two conceptual changes. The
  follow-up starts empty; the implementation never invents a message for the user.
  It omits carousel numbering/browser attribution without corresponding metadata.
  Text uses an explicit input/Add text row and a click placement, with a default
  position available to keyboard users. The dialog scrolls on short windows.
- **Screenshot request:** the initial dialog needs the app URL, simulator UUID or
  approved window ID because the task API has no authoritative running-app target.
  Later requests reuse the last target. The quoted “Show me what it looks like…”
  request and explicit “take/show me screenshots” phrases are recognized in the
  web composer; this is not a general natural-language agent tool. A known target
  captures directly; an unknown target asks for the missing address. Legacy CLI
  and native text-message endpoints are not changed.
- **Phone references:** read for contracts and flow only; the native agent owns them.

## Verification and capture limitation

- `pnpm install --frozen-lockfile`: passed, lockfile unchanged.
- `pnpm typecheck`: passed; `typecheck.log`.
- `pnpm lint`: passed with warnings, no errors; `lint.log`.
- `pnpm format:check`: passed; `format.log`.
- `pnpm build`: passed, including worker bundles; `build.log`.
- Focused `node --test --test-concurrency=1 server/v2/attachments.test.ts
server/v2/screenshots.test.ts app/routes/dashboard/v2/conversation/render.test.ts
app/routes/dashboard/v2/conversation/model.test.ts`: 12 passed; `focused-tests.log`.
- Final `pnpm test`: **744 tests, 726 passed, 5 failed, 13 skipped, 0 cancelled**;
  `full-suite.log`. Four failures were recorded by previous slices: two strict CA /
  same-key SKI assertions with system LibreSSL, Home Assistant readiness with Docker
  unavailable, and the Linux `/proc/self/fd` assertion on macOS. The fifth is
  `server/ci-http.test.ts`: its fixture needs three simultaneous servers (a fake app,
  HTTP and HTTPS), exceeding this task's two permitted ports. No new slice test failed.
  The first run (`full-suite-first.log`) additionally had ten application API socket
  failures because the two-port harness reused HTTP's port for HTTPS after a restart;
  the harness correction removed all ten on both subsequent runs.
- Suite isolation uses temporary
  data, a fake Docker executable, an unavailable Docker socket and `test-guard.mjs`.
  Only 5192/5193 are allowed; test-file concurrency is one. The harness also avoids
  reusing the same closed probe for HTTP and HTTPS when an API test restarts.
- Headless Chromium failed before opening a page (`bootstrap_check_in … Permission
denied (1100)`), so no implementation screenshots, pairs or browser interaction
  verification exist. `captures.md` has exact fixture URLs, dimensions and commands.
  Actual Chromium, simctl and desktop-helper captures were not exercised on live
  apps or simulators. Protocol tests use supplied image bytes, not real capture.

The fixture and Vite processes were stopped. No live service, worker or container
was stopped, restarted or reconfigured. No app was installed, updated or removed.

## Commits

- `3b0533f` — Add owner-scoped attachments and worker screenshot requests.
- `2f1bcbe` — Pass task images to Codex and keep attachments out of Git.
- `e75e2b9` — Add composer uploads, chat models and screenshot markup editor.
- The final evidence commit contains this note, the fixture, capture instructions,
  unapplied integration patch and validation logs.

## Integration and visual review (added by the orchestrating session)

- Applied `integration.patch` (`server/v2/events.ts`), so conversations show screenshot events and message attachments.
- `attachments.test.ts` and `screenshots.test.ts` both listened on fixed port 5192 and failed when run in parallel. They now use OS-assigned ports. All 115 `server/v2` tests pass, twice in a row.
- Captured with the fixture and Vite on 5193/5192, and paired (`Home`, `NewProduct` and `MarkupDesktop` at 1440 and 700; board left):
  - **MarkupDesktop** matches: toolbar (Pen, Arrow, Aa, Undo, three colors), the strokes and texts, and the "Screenshot with N marks" chip.
  - **NewProduct** matches. It also shows the sign-in slice's "Your first task" hint, because the fixture account hasn't dismissed it. The hint should only appear on a user's actual first task.
