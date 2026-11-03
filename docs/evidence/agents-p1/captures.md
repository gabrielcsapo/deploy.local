# Agents phase 1 parity captures

Fixture: `docs/evidence/agents-p1/fixture-server.mjs`. Branch: `codex/agents-p1`.
The captures in `captures/` predate the parity fixes. Updated screenshots and visual parity are **unverified**: this session's fixture launch failed with `listen EPERM` on `127.0.0.1:5184`, and board rendering failed because Chromium could not register its Mach port (`Permission denied`). Recapture and inspect all 32 width/board combinations in an environment that permits both.

The fixture clock now uses Friday 30 October at 18:00 so History truthfully shows “Friday, 16:00”, “Last Friday, 16:00” and “Last run 2h ago”. Related sidebar and next-check timestamps were adjusted to preserve their board labels. History setup follows the real route; the fixture still does not replace product markup.

## Start

Run these commands in separate terminals from the repository root:

```sh
DEPLOY_DATA_DIR=/tmp/agents-p1-ui DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5184 pnpm exec vite --host 127.0.0.1 --port 5185 --strictPort
```

```sh
node docs/evidence/agents-p1/fixture-server.mjs
```

Open **5184**, not 5185. All `/api/` requests terminate in synthetic fixture responses, including unknown paths (404 with a diagnostic); only web assets/HTML go to Vite. The fixture imports only Node HTTP, never the coordinator or a database. `DEPLOY_DATA_DIR` is for Vite isolation, not a fixture database.

## URLs and dimensions

Heights below come from `design/canvas.json`; widths follow `design/README.md` → Parity.

| Board             | Exact URL                                                                                                       | Widths   | Height |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| NewAgentBlank     | `http://127.0.0.1:5184/dashboard/agents/new?board=NewAgentBlank`                                                | 1440,700 | 900    |
| NewAgent          | `http://127.0.0.1:5184/dashboard/agents/new?board=NewAgent`                                                     | 1440,700 | 900    |
| AgentAvatarPicker | `http://127.0.0.1:5184/dashboard/agents/new?board=AgentAvatarPicker`                                            | 1440,700 | 900    |
| AgentHello        | `http://127.0.0.1:5184/dashboard/agents/release-notes-writer?board=AgentHello`                                  | 1440,700 | 900    |
| AgentTaught       | `http://127.0.0.1:5184/dashboard/agents/release-notes-writer?board=AgentTaught`                                 | 1440,700 | 900    |
| AgentBeat         | `http://127.0.0.1:5184/dashboard/agents/code-reviewer?board=AgentBeat`                                          | 1440,700 | 900    |
| AgentPage         | `http://127.0.0.1:5184/dashboard/agents/release-notes-writer?board=AgentPage`                                   | 1440,700 | 900    |
| AgentSettings     | `http://127.0.0.1:5184/dashboard/agents/release-notes-writer/tune?board=AgentSettings`                          | 1440,700 | 1380   |
| AgentCareDetails  | `http://127.0.0.1:5184/dashboard/agents/code-reviewer/tune?board=AgentCareDetails`                              | 1440,700 | 900    |
| AgentSettingsNew  | `http://127.0.0.1:5184/dashboard/agents/release-notes-writer/tune?board=AgentSettingsNew`                       | 1440,700 | 900    |
| AgentRoutine      | `http://127.0.0.1:5184/dashboard/agents/release-notes-writer/tune?board=AgentRoutine`                           | 1440,700 | 900    |
| AgentBeatProjects | `http://127.0.0.1:5184/dashboard/agents/code-reviewer/tune?board=AgentBeatProjects`                             | 1440,700 | 900    |
| AgentRuns         | `http://127.0.0.1:5184/dashboard/agents/release-notes-writer/items/draft-release-notes/history?board=AgentRuns` | 1440,700 | 900    |
| AgentsEmpty       | `http://127.0.0.1:5184/dashboard/agents?board=AgentsEmpty`                                                      | 1440,700 | 1040   |
| SettingsAgents    | `http://127.0.0.1:5184/dashboard/settings/approvals?board=SettingsAgents`                                       | 1440,700 | 1000   |
| TaskMention       | `http://127.0.0.1:5184/dashboard/tasks/last-updated-time?board=TaskMention`                                     | 1440,700 | 900    |

## Fixture setup and API coverage

`?board=` is read only by the injected fixture script and the fixture server, never by application code. The script runs before app modules, tags API fetches with a scenario/session header, and uses real UI controls after hydration. Each explicit URL starts fresh in-memory state; ordinary in-tab navigation retains it. Separate capture pages do not share mutations. No product HTML/CSS or React internals are replaced.

- NewAgentBlank: empty name, variant07/red avatar, disabled Create. NewAgent: Release notes writer, variant28/violet, enabled Create. AgentAvatarPicker: the same filled draft with Choose avatar open. The script selects the glyph/color through the picker, so the random initial avatar cannot affect the capture.
- AgentHello: empty conversation, job and Looks after list. AgentSettingsNew: empty job/list/access and “Say hello” in the sidebar. Other boards use all five saved agents with the specified glyphs, colors and messages; AgentsEmpty alone returns none.
- AgentTaught: the Friday exchange, job receipt (“Saved to What it does · Edit”), and an **unconfirmed** item receipt with Confirm. AgentBeat similarly leaves the reviewer item unconfirmed. Confirm mutates that item in memory; the normal details/page states start confirmed.
- AgentRoutine and AgentBeatProjects: the script opens the existing Looks after row in agent details. AgentRoutine substitutes the board’s full instruction text into the item editor. AgentRuns uses its own item History route and waits for its two results. Details boards use the real `/tune` route. TaskMention fills the real composer with `@` and waits for five mention options.
- Baseline Looks after items: Draft release notes / home-gym / Fridays 16:00 / message; Code quality and updates / home-gym, tally, deploy.local / Mondays 08:40 / pull request. Coordinator timezone is America/New_York. Only Release notes writer’s start-task rule is Allowed; every other rule is Ask.
- Read APIs: user/account, nodes, workspace sidebar, live summary, agents/timezone, projects, approvals, waiting/answered inbox, conversations/tracking, item history, model choices/defaults, TaskMention task/diff/checks, releases, and empty design changes/canvas/proposals. All five projects are supplied. Computers are SER (`coordinator`) and bazzite.
- In-memory actions: agent create/edit/delete, approvals save, item confirm/run, and canned composer submissions. No model executes. Creation retains the five canonical identities by replacing the writer with the new empty draft. Message submissions to the writer/reviewer replay their teaching fixtures; other agents record the message only. Task messages are recorded and appear on the next task refresh. This is a capture fixture, not a provider/integration test.
- `/api/v2/events` answers the app’s JSON long poll with `{events: [], cursor, supportsWait: true}` after one second. `Accept: text/event-stream` on that route, plus `/api/events`, `/api/events/stream` and `/api/v2/events/stream`, return an idle SSE stream with comment heartbeats. There are no synthetic work/agent events. Disconnects clear timers.
- Browser time is frozen to 2026-10-30 18:00 America/New_York so relative sidebar/task timestamps do not age between captures. Ops watcher is timestamped 07:02 that day; Code reviewer on Thursday; Researcher on Monday; Designer on Tuesday. The app still owns time formatting. Browser-local clock/date strings depend on the orchestrator’s browser timezone/locale.

The script marks `document.documentElement.dataset.fixtureReady` with the board name after setup. A failure sets `dataset.fixtureError` and logs the timed-out control. The standard capture tool waits four seconds; if setup is slower on the capture machine, inspect these markers and resolve the delay before accepting screenshots. No capture was run here.

## Capture commands

```sh
mkdir -p docs/evidence/agents-p1/captures
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/new?board=NewAgentBlank' docs/evidence/agents-p1/captures/NewAgentBlank 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/new?board=NewAgent' docs/evidence/agents-p1/captures/NewAgent 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/new?board=AgentAvatarPicker' docs/evidence/agents-p1/captures/AgentAvatarPicker 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/release-notes-writer?board=AgentHello' docs/evidence/agents-p1/captures/AgentHello 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/release-notes-writer?board=AgentTaught' docs/evidence/agents-p1/captures/AgentTaught 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/code-reviewer?board=AgentBeat' docs/evidence/agents-p1/captures/AgentBeat 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/release-notes-writer?board=AgentPage' docs/evidence/agents-p1/captures/AgentPage 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/release-notes-writer/tune?board=AgentSettings' docs/evidence/agents-p1/captures/AgentSettings 1440,700 1380
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/code-reviewer/tune?board=AgentCareDetails' docs/evidence/agents-p1/captures/AgentCareDetails 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/release-notes-writer/tune?board=AgentSettingsNew' docs/evidence/agents-p1/captures/AgentSettingsNew 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/release-notes-writer/tune?board=AgentRoutine' docs/evidence/agents-p1/captures/AgentRoutine 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/code-reviewer/tune?board=AgentBeatProjects' docs/evidence/agents-p1/captures/AgentBeatProjects 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/release-notes-writer/items/draft-release-notes/history?board=AgentRuns' docs/evidence/agents-p1/captures/AgentRuns 1440,700 900
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents?board=AgentsEmpty' docs/evidence/agents-p1/captures/AgentsEmpty 1440,700 1040
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/settings/approvals?board=SettingsAgents' docs/evidence/agents-p1/captures/SettingsAgents 1440,700 1000
node design/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/tasks/last-updated-time?board=TaskMention' docs/evidence/agents-p1/captures/TaskMention 1440,700 900
```

## Board render and pair commands

Render current approved boards first; each command produces both required widths. Pairs put the board on the left and the implementation on the right.

```sh
node design/tools/render.mjs NewAgentBlank
node design/tools/render.mjs NewAgent
node design/tools/render.mjs AgentAvatarPicker
node design/tools/render.mjs AgentHello
node design/tools/render.mjs AgentTaught
node design/tools/render.mjs AgentBeat
node design/tools/render.mjs AgentPage
node design/tools/render.mjs AgentSettings
node design/tools/render.mjs AgentCareDetails
node design/tools/render.mjs AgentSettingsNew
node design/tools/render.mjs AgentRoutine
node design/tools/render.mjs AgentBeatProjects
node design/tools/render.mjs AgentRuns
node design/tools/render.mjs AgentsEmpty
node design/tools/render.mjs SettingsAgents
node design/tools/render.mjs TaskMention
```

```sh
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/NewAgentBlank-1440.png output/design/NewAgentBlank-1440.png docs/evidence/agents-p1/captures/NewAgentBlank-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/NewAgentBlank-700.png output/design/NewAgentBlank-700.png docs/evidence/agents-p1/captures/NewAgentBlank-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/NewAgent-1440.png output/design/NewAgent-1440.png docs/evidence/agents-p1/captures/NewAgent-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/NewAgent-700.png output/design/NewAgent-700.png docs/evidence/agents-p1/captures/NewAgent-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentAvatarPicker-1440.png output/design/AgentAvatarPicker-1440.png docs/evidence/agents-p1/captures/AgentAvatarPicker-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentAvatarPicker-700.png output/design/AgentAvatarPicker-700.png docs/evidence/agents-p1/captures/AgentAvatarPicker-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentHello-1440.png output/design/AgentHello-1440.png docs/evidence/agents-p1/captures/AgentHello-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentHello-700.png output/design/AgentHello-700.png docs/evidence/agents-p1/captures/AgentHello-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentTaught-1440.png output/design/AgentTaught-1440.png docs/evidence/agents-p1/captures/AgentTaught-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentTaught-700.png output/design/AgentTaught-700.png docs/evidence/agents-p1/captures/AgentTaught-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentBeat-1440.png output/design/AgentBeat-1440.png docs/evidence/agents-p1/captures/AgentBeat-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentBeat-700.png output/design/AgentBeat-700.png docs/evidence/agents-p1/captures/AgentBeat-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentPage-1440.png output/design/AgentPage-1440.png docs/evidence/agents-p1/captures/AgentPage-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentPage-700.png output/design/AgentPage-700.png docs/evidence/agents-p1/captures/AgentPage-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentSettings-1440.png output/design/AgentSettings-1440.png docs/evidence/agents-p1/captures/AgentSettings-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentSettings-700.png output/design/AgentSettings-700.png docs/evidence/agents-p1/captures/AgentSettings-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentCareDetails-1440.png output/design/AgentCareDetails-1440.png docs/evidence/agents-p1/captures/AgentCareDetails-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentCareDetails-700.png output/design/AgentCareDetails-700.png docs/evidence/agents-p1/captures/AgentCareDetails-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentSettingsNew-1440.png output/design/AgentSettingsNew-1440.png docs/evidence/agents-p1/captures/AgentSettingsNew-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentSettingsNew-700.png output/design/AgentSettingsNew-700.png docs/evidence/agents-p1/captures/AgentSettingsNew-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentRoutine-1440.png output/design/AgentRoutine-1440.png docs/evidence/agents-p1/captures/AgentRoutine-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentRoutine-700.png output/design/AgentRoutine-700.png docs/evidence/agents-p1/captures/AgentRoutine-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentBeatProjects-1440.png output/design/AgentBeatProjects-1440.png docs/evidence/agents-p1/captures/AgentBeatProjects-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentBeatProjects-700.png output/design/AgentBeatProjects-700.png docs/evidence/agents-p1/captures/AgentBeatProjects-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentRuns-1440.png output/design/AgentRuns-1440.png docs/evidence/agents-p1/captures/AgentRuns-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentRuns-700.png output/design/AgentRuns-700.png docs/evidence/agents-p1/captures/AgentRuns-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentsEmpty-1440.png output/design/AgentsEmpty-1440.png docs/evidence/agents-p1/captures/AgentsEmpty-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/AgentsEmpty-700.png output/design/AgentsEmpty-700.png docs/evidence/agents-p1/captures/AgentsEmpty-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/SettingsAgents-1440.png output/design/SettingsAgents-1440.png docs/evidence/agents-p1/captures/SettingsAgents-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/SettingsAgents-700.png output/design/SettingsAgents-700.png docs/evidence/agents-p1/captures/SettingsAgents-700.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/TaskMention-1440.png output/design/TaskMention-1440.png docs/evidence/agents-p1/captures/TaskMention-1440.png
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/agents-p1/TaskMention-700.png output/design/TaskMention-700.png docs/evidence/agents-p1/captures/TaskMention-700.png
```

## Gaps the fixture cannot supply

These are source-inspected limitations, not an approved design deviation or a claim of visual parity. Record additional differences after inspecting both widths.

| Boards                                         | What still needs application support or additional fixture data                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All                                            | The sidebar still renders a Live running count. Timestamp labels now use the board formatter.                                                                                                                                                                                                                                                                                                                             |
| All                                            | Boards show “3 computers online”; the requested named computers are only SER and bazzite, so the fixture truthfully reports 2. A third computer needs an identity before adding it.                                                                                                                                                                                                                                       |
| AgentBeat, AgentCareDetails, AgentBeatProjects | Boards show a waiting count of 7 without defining seven inbox decisions. Inbox stays empty; adding seven invented rows would change the sidebar. Exact parity needs the seven decision records and/or a separate count UI.                                                                                                                                                                                                |
| AgentSettings, AgentCareDetails                | Phase 1 always shows “Nothing learned yet.” Persisted lessons, removal/Undo, stopped suggestions and reallow feedback cannot be represented by the current UI/contracts.                                                                                                                                                                                                                                                  |
| AgentCareDetails, AgentBeatProjects            | Agent access has only one optional projectId: one project, or unrestricted. The reviewer’s Looks after scope contains the three required projects, but its four-project access grant (including immich while excluding recipes) is not representable. With no projectId the app labels all five projects Access granted. The fixture cannot make recipes Needs access without incorrectly restricting the other projects. |
| AgentRoutine, AgentBeatProjects                | Project stages and size limits remain out of phase 1. Inaccessible choices are now disabled using the existing single-project access rule; stage labels and the Done-project footnote are deliberately omitted.                                                                                                                                                                                                           |
| AgentTaught, AgentBeat                         | Initial captures show Confirm; pressing it shows the confirmed state. AgentBeat’s item is “Code quality and updates” as requested, while its board receipt abbreviates it to “Code quality.” The Review access link is not a supported reply element (its surrounding prose is present).                                                                                                                                  |
| SettingsAgents                                 | Team limits stays out until phase 2. Always yours rows are unchanged from the phase-1 implementation. Failed-release rollback controls and short agent summaries are restored.                                                                                                                                                                                                                                            |
| TaskMention                                    | All five choices are supplied. Rich inline code in reply paragraphs and the board’s computer explanatory sentence are not supported by the current plain paragraph/task panel renderers.                                                                                                                                                                                                                                  |

The other three agent jobs are not written on these boards: their fixture jobs use the shown responsibilities/suggestions, rather than claiming an unseen approved job description. Uploads, screenshot capture, external provider work, merges and releases are outside this fixture and return explicit unavailable responses if attempted. No real operations are proxied. The fixture does not supply authenticated deployment WebSockets; use the capture tool’s fresh browser contexts (no saved real-account credentials). Vite handles its own development connection.

## Validation

```sh
node --check docs/evidence/agents-p1/fixture-server.mjs
```

Syntax check passes. The injected setup script was also syntax-checked independently without executing it. Offline probes called the handler with in-memory request/response doubles: all boards’ shared read APIs, empty/new/teaching data, item confirmation, TaskMention resources, and idle SSE/JSON polling passed. The HTTP server factory was replaced with an inert function for those probes. No ports, browsers, renders or screenshot pairs were run during preparation. Stop both fixture processes after the orchestrator has inspected the 32 pairs.
