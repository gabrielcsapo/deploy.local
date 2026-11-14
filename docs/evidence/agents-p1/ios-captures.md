# Agents phase 1 — iPhone capture handoff

Branch: `codex/agents-p1`. The fixture and launch hooks are ready; simulator captures have **not** been run. The orchestrator owns launching the simulator and inspecting every image against `design/boards/<Board>.html` at 390 points. No visual-parity claim is made from compilation or fixture tests.

## Run

Use a booted **390-point-wide iPhone** with the branch's **Debug simulator app** installed (`local.deploy.workspace.ios` by default). Set the app/simulator to light appearance, English, and standard text size for comparison with these boards. Stop the older fixture if it occupies port 5186.

From the repository root, keep this process running:

```sh
node docs/evidence/agents-p1/ios-fixture-server.mjs
```

In another terminal:

```sh
SIMULATOR_UDID='<booted-390-point-iPhone-UDID>' \
  bash docs/evidence/agents-p1/capture-ios.sh
```

To repeat a subset or allow more settling time:

```sh
SIMULATOR_UDID='<UDID>' CAPTURE_WAIT_SECONDS=8 \
  bash docs/evidence/agents-p1/capture-ios.sh AgentAvatarPickerPhone TaskMentionPhone
```

`BUNDLE_ID` can override the installed app's bundle identifier. The script verifies the fixture identity, validates board names, terminates the app before switching scenarios, posts `{"board":"<Board>"}` to `/fixture/board`, launches with `--v2-fixture http://127.0.0.1:5186 --v2-board <Board>`, waits five seconds by default, takes the screenshot, and terminates the app again. It also terminates on exit. It does not install, boot, build, or select a simulator for you.

Each output is `docs/evidence/agents-p1/ios/<Board>-390.png`. The command is the unmodified `xcrun simctl io "$SIMULATOR_UDID" screenshot ...`; **390 is the logical viewport width**, not a claim that the native PNG is 390 physical pixels wide. Preserve native captures and scale copies if needed for side-by-side board comparison. A successful screenshot command does not verify sheet presentation or network completion: inspect each image and repeat with a longer wait if it caught loading or animation.

## Board routes

All rows are configured but still await simulator capture. The expected topmost native surface is listed here; existing implementation gaps follow the table.

| Board                  | Fixture and opened state                                                                                          | Known gap                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| WorkNoAgentsPhone      | Work; no saved agents, no tasks, empty waiting list                                                               | None identified in state setup                                                                                           |
| WorkAgentsPhone        | Work; five named avatars and last messages; draft-release-notes task in Today                                     | No Team summary or seven-decision/proposal summary; waiting is 0                                                         |
| NewAgentBlankPhone     | New-agent sheet; empty name, variant07/red; Create disabled                                                       | Native sheet layout still needs capture review                                                                           |
| NewAgentPhone          | New-agent sheet; Release notes writer, variant28/violet; Create enabled                                           | Native sheet layout still needs capture review                                                                           |
| AgentAvatarPickerPhone | New-agent sheet with Choose avatar sheet already open; variant28/violet selected                                  | Native grid and sheet chrome need capture review                                                                         |
| AgentHelloPhone        | Writer's empty chat, no job/items/project/computers, suggestion buttons                                           | Composer is a separate sheet when tapped                                                                                 |
| AgentTaughtPhone       | Writer's teaching exchange with saved-job and unconfirmed Looks after receipts                                    | Confirmed receipt appears only after Confirm, not alongside the unconfirmed state                                        |
| AgentBeatPhone         | Reviewer's teaching exchange and unconfirmed code-quality receipt                                                 | No Review access action or stage-aware access model                                                                      |
| AgentPhone             | Writer's four-message exchange and running task link                                                              | No Looks after/History strip; task card lacks the board's run/computer detail                                            |
| AgentMenuPhone         | Writer chat with native conversation menu sheet open                                                              | Existing menu differs from board: search, Agent info, mute/pause, Done; no History/Approvals shortcuts                   |
| AgentInfoPhone         | Writer chat with Agent details sheet open; learned job, confirmed Friday item, home-gym/SER                       | Learned lesson is not implemented; displays empty learning state                                                         |
| AgentInfoNewPhone      | Empty writer chat with Agent details open; empty job/items/access and all rules Ask                               | Native computer text field is blank rather than a No computer selector                                                   |
| AgentCareDetailsPhone  | Reviewer chat with Agent details open; job, confirmed Monday item, SER/bazzite                                    | No learned lessons, removal/undo, stopped suggestions or multi-project access                                            |
| AgentRoutinePhone      | Writer's Looks after editor open; full routine instruction, home-gym selected, Friday 16:00, message, unconfirmed | No project stages or Done-project exclusion text; lower controls require scrolling                                       |
| AgentBeatProjectsPhone | Reviewer's Looks after editor open; home-gym/tally/deploy.local selected, Monday 08:40, pull request, unconfirmed | Single-project access model treats all projects as accessible when projectId is absent; cannot mark recipes Needs access |
| AgentRunsPhone         | Writer's native item History sheet open; two Finished runs and Run now enabled                                    | No board-style schedule/last-run summary or Edit item link                                                               |
| SettingsApprovalsPhone | Settings → What agents may do sheet; five identities and rules summaries                                          | Team limits and archive policy absent; no board read-only note                                                           |
| AgentRulesPhone        | Settings → What agents may do → writer's rules sheet; Start a task Allowed, other four Ask                        | Native rules are editable Pickers; board says rules are edited on a computer                                             |
| TaskMentionPhone       | Fix the sync worker task → large composer sheet; text `@`, all five mention choices open; keyboard unfocused      | Board has inline mention picker over chat; native composer sheet covers most of the task                                 |

## Fixture scope and differences

- Transport follows `../v2/12-ios-2/fixture-server.mjs`: local HTTP, fake credentials, mutable in-memory scenario selection, typed workspace/task responses, and long-poll events. It binds **only 127.0.0.1:5186** and rejects other `PORT` values. It makes no outbound requests, imports no coordinator/database modules, uses no Vite server, and writes no data to disk. Unknown operations fail rather than invoking real work.
- The five agent identities, avatars, jobs, Looks after items, rules, last messages, teaching exchanges, writer conversation, history, projects, computers, and Tally TaskMention payload mirror `fixture-server.mjs`. Every POST to `/fixture/board` resets mutations. Unconfirmed boards remove `confirmedAt`/`nextAt`; the new-agent boards have no learned job or access and all rules Ask.
- Native response envelopes add the fields Swift's decoders require (workspace cursor/workers, live warning/checkedAt, task revisions/workspace paths, diff files/checks). `/api/approvals` exposes the five actions the native `V2ApprovalAction` enum can decode. The full 45-rule set is retained in memory and can be inspected at `/fixture/state` with `X-Deploy-Token: fixture-only`; native edits retain the unsupported rules. Returning all nine actions to that decoder would prevent every approvals screen from loading.
- The web TaskMention is Tally's `last-updated-time`; the approved phone board still depicts `sync`, “Fix the sync worker.” Both are served. The iPhone route opens `sync`, using the request and worklog from its phone board. Task conversations arrive through `/api/activity-events`; native `TaskDetail.events` is a different schema and remains empty.
- The fixture retains the web reference date, **30 October 2026, 18:00 America/New_York**. Evidence-only grouping and date labels use that reference, so messages stay expanded as Today and the active task stays in Today. Native date formatting still shows e.g. `6:00` rather than `now`, and `Oct 26` rather than `Mon`; it is not replaced with board-specific text.
- Evidence routing requires a Debug simulator build, a validated loopback fixture argument, port 5186, and one of these board names. On devices, in Release, or without valid fixture arguments, these routes and seed values are unavailable. Existing app launch connection handling is unchanged. Overlapping older evidence names (AgentInfoPhone, AgentMenuPhone, NewAgentPhone, SettingsApprovalsPhone) now select phase-1 states on 5186.
- Each phase-1 app launch uses a fresh temporary V2 cache, leaving normal saved drafts and event cursors untouched. Saved notification navigation is ignored for the capture. No persistent appearance preference is changed.

The fixture deliberately does not invent future-phase proposals, Team limits, learned lessons, stopped suggestions, or project stages. Native details, item editors and the avatar picker are scrollable; one initial screenshot cannot show every lower control. Do not interpret an offscreen section as missing without scrolling. Any product/design correction belongs in a separate approved implementation change; this work changes only evidence setup and routing.

## Validation

- `node --check docs/evidence/agents-p1/ios-fixture-server.mjs`: passed.
- `node --test docs/evidence/agents-p1/ios-fixture.test.mjs`: four socket-free contract tests passed, covering all 19 boards, reset/auth behavior, teaching/confirmation/history, native rules adaptation, and both TaskMention tasks.
- `bash -n docs/evidence/agents-p1/capture-ios.sh`: passed.
- Plain `swift build` and `swift test` in DeployKit initially failed because the sandbox denied the default Clang module-cache directory. Retrying with writable caches and SwiftPM's nested sandbox disabled succeeded:

```sh
cd native/Apple/Packages/DeployKit
CLANG_MODULE_CACHE_PATH=/tmp/agents-p1-module-cache \
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/agents-p1-module-cache \
  swift build --disable-sandbox --cache-path /tmp/agents-p1-swift-cache
CLANG_MODULE_CACHE_PATH=/tmp/agents-p1-module-cache \
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/agents-p1-module-cache \
  swift test --disable-sandbox --cache-path /tmp/agents-p1-swift-cache
```

The host build passed; tests passed (15 XCTest cases plus 140 Swift Testing tests). This host build alone does not compile `#if os(iOS)` bodies. No simulator was launched and no screenshots were created in this task.

The **iOS simulator-target package build also passed**, without running a simulator:

```sh
CLANG_MODULE_CACHE_PATH=/tmp/agents-p1-module-cache \
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/agents-p1-module-cache \
  swift build --disable-sandbox --cache-path /tmp/agents-p1-swift-cache \
  --triple arm64-apple-ios17.0-simulator \
  --sdk /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator27.2.sdk
```

Use the installed SDK path on the orchestrator's machine. The build emitted existing actor-isolation warnings in `MessageContent.swift` and `V2Design.swift`; it reported no errors in the evidence changes.
