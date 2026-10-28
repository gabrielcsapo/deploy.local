# Slice 7 · agents and Approvals

This branch implements the agent records/API, a real model-backed draft flow, the Approvals editor, agent conversation/tuning surfaces, and Settings navigation. It does **not** claim complete visual parity or an autonomous standing-agent scheduler. No schema, design source, other worktree, live service, worker, container or installed app was changed.

## Implemented

- `GET /api/v2/agents` returns `{ agents: Agent[] }`, including owner-scoped Scout and Warden defaults. Custom agents use the existing `records` table with kind `agent`. POST creates, PATCH edits name/instructions/computers. IDs and creator cannot be overwritten; DELETE refuses built-ins, and custom deletion is not exposed.
- Creation atomically persists all eight ApprovalAction rules as Ask me. The existing sidebar consumes the envelope and picks up new agents on reload or its normal polling interval.
- POST `/api/v2/agents/draft` calls a real configured compatible model endpoint through the existing owner-scoped `providerConnections` plumbing, including encrypted-key lookup. There is no canned production draft. No endpoint gives HTTP 503 with a Computers › Models recovery instruction; unreachable/rejected/malformed output gives HTTP 502. Requests time out and output/body sizes are bounded. Only explicit name, job and computers fields survive validation; no provider-created permissions are accepted.
- `/dashboard/agents/new` describes a job, requests and edits Scout's draft, then creates the agent. Scout/Warden tuning saves instructions/computers; Approvals and Models are links to their single shared homes. Info opens an accessible shared Dialog; the ⋯ menu links to Tune, Approvals and Models.
- The local `agents/conversation.tsx` adapter renders typed ConversationEvents and uses the existing InboxDecision component for live, shared decisions. It includes folded earlier days, search, filters, work logs, replies, reports and links. Decisions stay visible through filtering, and a day containing a waiting decision does not fold automatically. GET/POST `/agents/:id/conversation` supplies owner-scoped stored messages, explicitly agent-attributed task run events, and inbox decisions. Replies use the configured endpoint with recent conversation context and no tools. Failed sends retain the input. This adapter is deliberately replaceable by the parallel task/conversation slice.
- Approvals uses the existing GET/PUT API. All eight contract actions appear; the table stacks into a group per agent at the existing 900 px breakpoint. Every cell opens a rule editor, including agent/action, Ask/Allowed/Never, project scope and limit. Project rules/limits are also individually listed and editable. Saving errors remain in the dialog. Duplicate IDs/scopes, unknown actions/modes, malformed or oversized fields are rejected atomically. Shipping cannot be set to Allow.
- `isAllowed(owner, agent, action, projectId)` is the common unattended-action gate. It defaults to false, resolves project rules ahead of global rules, honors Never, and does not automatically authorize a free-text limit. Ship always returns false. Both automatic rollback selection and execution admission call it. The inbox rollback handler also checks a later Never rule before honoring an older pending decision.
- Settings links to Approvals, Backups, Account, Devices and the design system. Its theme selector changes the document theme and remembers the choice; full application-wide preference bootstrap remains a shell integration item.

## Deliberate board differences and remaining work

Read all eleven named board sources and both-width renders, plus the supplied design rules. The source boards are unchanged as requested. Differences below are explicit limitations, not claims that missing behavior is implemented.

- **Main / LongChat / KeeperPage:** the typed event contract has no tracking summary, live disk-growth projection, agent subtitle, scheduled next-run time or creation timestamp. The right panel shows real waiting decisions and configured computers instead. Task/release/screenshot events use their available IDs; screenshot display and richer task/release cards should come from the shared conversation renderer. The global Composer uses the brief's “Ask, build, or follow up…” and has disabled attachment/voice/model selection until its owning slice supplies them. No model name or health measurement is invented. Dates are local dates from real timestamps; earlier days show actual event counts. Generic InboxDecision adds provenance/answer handling and uses its attention glyph. Fixture-only data carries the board's named prose and decisions.
- **Configure / TuneWarden:** instruction editing and the shared Approvals/Models links work. Schedule/trigger toggles, learned preferences/Forget, pause/archive and live watching counts are omitted: the settled Agent contract has none of these fields, and there is no standing-agent scheduler/archive lifecycle to connect them to. Built-in Warden is deliberately not archivable/deletable. Existing health monitoring continues independently of these textual agent records. Computers is an editable ID list.
- **NewAgent / NewAgentDraft:** draft name/instructions/computers are editable native fields. There is no separate Rename affordance or unbacked schedule, trigger, per-app coverage or model-cost claim. The draft starts every permission on Ask me, including all eight actions in the brief. Creating an agent does not install a worker job or start scheduled monitoring. A scheduler/trigger integration remains necessary for standing jobs to execute independently.
- **SettingsAgents / SettingsAgentsNew:** the board includes Start a task/Open a pull request, which are absent from the settled ApprovalAction union, and omits install/change-secrets/use-screen/spend, which are required. The implementation follows the eight-action contract. Ship remains person initiated, even if a legacy record says Allow. Built-ins default to Ask me rather than inheriting the board's sample privileges. The fixture alone shows Warden's allowed restart. There is no invented “four approved rollbacks” suggestion or new-agent timestamp. Project rules and limits are explicitly listed under the matrix so scoped overrides are visible.
- **RuleEdit:** the contract supports a project and a free-text limit, but not “When”, app exclusions, notification policy or usage counters. The editor uses project selection, a permission selector and a limit field; it explains that an unchecked limit continues to ask. No rate counter or expression evaluator is claimed. The design's unsupported condition/usage prose is omitted.
- **Settings:** account/device/SSH-key ownership stays with those slices. This page links to them instead of fabricating account identity, device counts, key fingerprints or nonfunctional removal/sign-out controls. Text-size and notifications preferences have no application-wide persistence contract here and are omitted. Theme persistence is local to this surface until the shell reads the stored preference.
- **Provider scope:** drafting and these conversational replies support configured compatible HTTP model endpoints. They do not launch Codex/Claude worker sessions or borrow local CLI credentials. Those runtimes currently run task/tool sessions; integrating a tool-free draft job through their worker protocol remains open. A subscription-only install therefore gets the explicit compatible-provider setup error, not a fake draft.
- **Shared behavior:** loading/error/empty states are real; unsupported board controls are omitted. The sidebar remains owned by its earlier slice. Account/Devices links target the future slice routes; those routes may still be absent on this base branch.

## Enforcement integration for the next slices

Only rollback previously consulted rules, and only that execution path is changed in this scope. **This is not system-wide authorization coverage for legacy actions.** Before adding an agent execution path for the other actions, resolve the authenticated owner, agent identity and actual project ID, then:

1. Resolve `approvalRule(...)`; Never refuses the agent action, including an older pending approval.
2. Call `isAllowed(...)` at execution admission. True permits unattended execution. False requires a matching answered inbox decision; false alone is not permission to execute.
3. Recheck on execution, not only when proposing a decision. Preserve the underlying resource ownership and task/app boundaries. A free-text limit is not an executable policy; it must continue asking until a real evaluator/counter exists.
4. Ship is always initiated by a person. Never route an agent through a human credential to bypass this rule.

Call-site owners: merge/retry-merge in `server/workspace/project-tools.ts` and project collaboration; agent restart and install entry points in the coordinator/catalog paths; secret mutation in project settings/configuration; `server/workspace/interactive.ts` for Use the screen, retaining its task/app decision; and provider paid-run admission for Spend. These files are outside this slice's write boundary. Person-initiated commands retain their existing owner/auth checks.

The generic records schema and shared contracts were not changed. Merge the five route imports and the agentsApi import/dispatch with the parallel slices. Reuse the shared task conversation component when it lands. The local agent endpoint supplies `ConversationEvent[]`; task-run events currently require explicit matching `agentId`/`agent` attribution rather than guessing which adapter is Scout.

## Visual evidence

**Blocked, not verified.** Headless Playwright Chromium aborted with `bootstrap_check_in … Permission denied (1100)` / SIGTRAP. Per the task's fallback, no browser retry, desktop browser or computer use was attempted. There are no implementation captures or side-by-side pairs to review. `captures.md` lists each board's exact URL, 1440/700 widths and original height, with all commands. `fixture-server.mjs` serves real application routes against synthetic API fixtures on 5184, with Vite assets on 5185. Its browser-only setup code fills the new job, requests the draft and opens RuleEdit. Finish all 22 captures/pairs and keyboard/scrolling review in a session where Chromium can launch.

The two preview processes were stopped through their own exec sessions. No other listener was stopped. A read-only HTTP check confirmed the fixture HTML/setup script; Vite reports the already-recorded `workspace-icons.json?ssr` parse issue and falls back to client rendering. Production build succeeds.

## Validation

- `pnpm install --frozen-lockfile`: passed. The tracked pnpm cache database was restored after installation.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with warnings, no errors.
- `pnpm format:check`: passed.
- `pnpm build`: passed.
- `node --test server/v2/agents.test.ts server/v2/releases.test.ts server/v2/api.test.ts`: **37 passed, 0 failed**, see `focused-tests.log`. Includes no-provider/real-provider fixture responses, owner isolation, protected built-ins, creation defaults, atomic matrix validation, rule precedence/limits and a later Never rule blocking an existing inbox rollback.
- Final `pnpm test`: **684 tests; 667 passed, 4 failed, 0 cancelled, 13 skipped**, exit 1. The four failures are the same unchanged tests recorded by earlier slices: two `ca-profile.test.ts` assertions under system LibreSSL; Home Assistant readiness in `catalog-api.test.ts` with Docker unavailable; and the Linux `/proc/self/fd` assumption in `legacy-preserving-update.test.ts`. The parallel run cancelled 11 application graph/configuration HTTP tests after a test-port collision triggered an EACCES retry loop and exhausted the spawned test coordinator’s heap. `parallel-suite.log` retains that run with identical repeated lines explicitly condensed. All 11 passed in the final serialized run. No v2 test failed. `full-suite.log` preserves the final serialized output. The temporary preload changes only the test runner’s `--test-concurrency=4` argument to `--test-concurrency=1`; it imports the same listener guard. Tests use a temporary data directory, an unavailable Docker socket/executable, and the earlier slice's `test-guard.mjs` to restrict listeners to 5180–5199. No real model endpoint or coordinator was contacted.

## Visual review (added by the orchestrating session)

All 11 boards were captured with the fixture and Vite on 5184/5185, and paired at 1440 and 700 (`<Board>-<width>.png`, board left). The matrix stacks per agent below 900 px, as designed.

Differences to polish:

- **Approvals matrix:**
  - Lists "Release to a computer" as an approvable agent action. Agents never ship, so remove that row: it is an "Always yours" item, not a matrix action. The brief's `ApprovalAction` list wrongly included `ship`.
  - Lacks the board's Start a task and Open a pull request rows, and the row subtexts.
  - The "Suggested from your answers" card is missing.
- **Agent conversation:** decision cards show a raw timestamp and no agent glyph. The Tracking panel lacks Running, Watching and Shipped this week.
- **New agent draft:** renders as a plain form. The board shows the agent header, "When Keeper works" switches (scheduling isn't implemented) and Covers.
