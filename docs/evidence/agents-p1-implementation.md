# Agents foundation — phase 1 implementation handoff

Branch: `codex/agents-p1`. No design files changed, screenshots rendered, commits made, pushes or releases performed.

## Implementation

- Shared/server: avatar identity and deterministic, persisted first-read migration; optional Looks after contracts and per-item run attribution; name-only creation; validated structured teaching through the existing compatible-model conversation path (including attachments/model selection); atomic job/item receipts; explicit, idempotent confirmation; weekly/daily timezone-aware scheduling and project-change items; current project-access intersection; preservation of legacy apps/triggers; agent-change events.
- Web/Mac web shell: shared DiceBear avatar, picker and colors; name-only creation dialog with retained failure state; empty chat and composer suggestions; receipts with Confirm/Edit; shared item editor/history/Run now; details page; grouped settings/rule rows; saved-agent sidebar, mention and approval identity; avatar credits.
- iPhone: generated Swift glyph paths and SwiftUI avatar; optional older-server model fields; chat-first creation and actual agent-conversation requests; receipt decoding/rendering; details, item editor/history and rules sheets; shared settings groups/rows; Work and mention identities. Existing Settings typography is preserved by opting the new lists into the list variant.
- New shared-list specimens are included in the existing live design-system page.

## Tests

- Added `server/v2/agent-foundation.test.ts`: identity, lazy migration, legacy field preservation, validation, atomic teaching, clarification/no-save, replay idempotency, confirmation/reconfirmation, owner isolation, DST/week schedules, access intersection, item attribution, change triggers and compatible-model structured output.
- Extended `server/v2/agents.test.ts` with name-only creation, avatar retention/validation and owner-scoped item confirmation/history API coverage.
- Updated the attachment provider fixture for structured output and kept its image/model-default assertions.
- Extended the cross-language contract fixture with both receipt kinds.
- Added five Swift tests in `V2Tests.swift` for older-server decoding, scope round trips, receipts, name/avatar creation encoding, and preservation of scoped approval rules/limits.

## Commands and results

- `node scripts/build-agent-glyphs.mjs`: succeeded; a second generation produced identical Swift source.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: attempted; each hung without output and a bounded retry timed out after 20 seconds. Even `pnpm --version` hung.
- Installed `node_modules/.bin/tsc --noEmit`: fails in untouched `packages/node-app` because Electron types are missing (and consequent implicit-any errors). No diagnostics in changed app/server/shared files.
- Installed `node_modules/.bin/oxlint .`: succeeds, with repository warnings.
- `node scripts/check-design-literals.mjs`, `node scripts/check-motion-tokens.mjs`, `node scripts/check-native-token-parity.mjs`: all pass.
- Installed `oxfmt --write` and `oxfmt --check` on changed TS/TSX/CSS/MJS files: pass.
- `node --test server/v2/agent-foundation.test.ts server/v2/agent-runs.test.ts server/v2/contracts.test.ts`: **12 passed**, including compiling/running the Swift Codable contract fixture with teaching receipts.
- `node --test server/v2/agents.test.ts server/v2/attachments.test.ts`: blocked before cases run by sandbox `listen EPERM` on `127.0.0.1`.
- `swift build` in DeployKit: blocked by module-cache write restrictions; writable-cache retry hit SwiftPM sandbox restrictions; a retry with writable cache and SwiftPM's sandbox disabled reached dependency resolution but failed because `github.com` cannot resolve. Full package build and Swift Testing suite remain unverified.
- `swiftc -frontend -parse` on all changed Swift files: passes.
- Direct Swift model/client typecheck (excluding the Observation store files and their dependent `VideoAttachments.swift`): passes, with an existing Keychain deprecation warning. Full direct typecheck is blocked by the Observation plugin sandbox.
- `git diff --check`: passes.

## Review still required

The orchestrator must run the full Apple build/tests and the localhost HTTP tests, and compare the real web app at 1440/700 and iPhone at 390 against the approved boards. No visual-parity claim is made without those captures. No intentional design departures were introduced; phase-1 scope deliberately omits Team limits and renders the empty learning state.

Project stages/Care, proposals, limits, archive, weekly summaries, and learning remain for later phases. Both broad item scopes currently resolve to all projects within the agent's access. The legacy draft API/client method remains for backward compatibility; neither new-agent UI uses it.

## Files touched

- `app/components/ui/v2/AgentAvatar.tsx`
- `app/components/ui/v2/Composer.tsx`
- `app/components/ui/v2/SettingsList.tsx`
- `app/components/ui/v2/agent-avatar.css`
- `app/routes.ts`
- `app/routes/dashboard/design-system.client.tsx`
- `app/routes/dashboard/v2-layout.client.tsx`
- `app/routes/dashboard/v2/agents/conversation.tsx`
- `app/routes/dashboard/v2/agents/identity.tsx`
- `app/routes/dashboard/v2/agents/item.tsx`
- `app/routes/dashboard/v2/agents/page.client.tsx`
- `app/routes/dashboard/v2/conversation/Conversation.tsx`
- `app/routes/dashboard/v2/data/hooks.tsx`
- `app/routes/dashboard/v2/data/inbox-store.ts`
- `app/routes/dashboard/v2/data/sidebar.ts`
- `app/routes/dashboard/v2/inbox/InboxDecision.tsx`
- `app/routes/dashboard/v2/inbox/QuestionDecision.tsx`
- `app/routes/dashboard/v2/inbox/page.client.tsx`
- `app/routes/dashboard/v2/settings/approvals.tsx`
- `app/routes/dashboard/v2/settings/page.client.tsx`
- `native/Apple/Packages/DeployKit/Sources/DeployCore/V2/V2AgentFoundation.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployCore/V2/V2Approvals.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployCore/V2/V2Client.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployCore/V2/V2Store.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployCore/V2Contracts.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/AgentAvatar.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/AgentGlyphs.generated.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2AgentDetails.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2Components.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2Composer.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2Conversation.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2NewAgent.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2Places.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2QuestionDecision.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2Root.swift`
- `native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2SettingsApprovals.swift`
- `native/Apple/Packages/DeployKit/Tests/DeployCoreTests/V2Tests.swift`
- `scripts/build-agent-glyphs.mjs`
- `server/v2/agent-foundation.test.ts`
- `server/v2/agent-foundation.ts`
- `server/v2/agent-runs.ts`
- `server/v2/agents.test.ts`
- `server/v2/agents.ts`
- `server/v2/attachments.test.ts`
- `server/v2/attachments.ts`
- `server/v2/contracts.test.ts`
- `server/v2/events.ts`
- `shared/v2/agents.ts`
- `shared/v2/api.ts`
- `shared/v2/contracts.ts`
