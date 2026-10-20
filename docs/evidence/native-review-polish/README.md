# Native review polish: pull requests, issues and the task → merge → deploy flow

Date: 2026-10-19. Branch `claude/keen-margulis-546a94`, based on `codex/app-icon` (a09a1ea, the build
running on the dogfood devices). Native only; no server API changes. Nothing here was deployed to SER.

## What changed

- **One review flow.** Task review links to its pull request (or offers “Open a pull request” with the task
  pre-linked). A pull request has Overview / Changes / Checks. Changes reuses the task review's diff
  components (file index with +/− counts, per-file diffs, iPhone wrap toggle). Checks list each pipeline
  run with every job and **the computer that ran it**. After a merge, the PR shows the push pipeline it
  started and the deployment it produced, live, plus View pipeline.
- **Clear state.** Open / Merging / Merged / Closed / Merge failed badges on semantic tones; a merge panel
  with the check result (“Ran on Gabriels-MacBook-Pro-422, SER”), mergeability (fast-forward, diverged with
  rebase guidance, no new commits) and actions. Merge asks for confirmation that states its consequence.
- **No more stale “Open” after merging.** Merging shows the moment Merge is confirmed and stays until the
  coordinator records the merge (`pullPhase`); polling speeds up only while something is moving. Close /
  reopen and comments update optimistically; refresh errors clear on the next successful refresh.
- **Custom composers** replace stock `Form`s (New PR, New issue, Edit, Run pipeline): Linear-style borderless
  title, description and metadata chips in one surface, GitHub-style compare bar with a real
  ahead/behind verdict and the actual diff, commit list and suggested title before anything is created.
- **Issues** use the same header, panel and activity timeline; the panel lists linked tasks and Start task.
- **Project modal** rebuilt: a context rail matching the main sidebar and a 56 pt location header with the
  title, one solid create action and a close button (no stock Done/prominent buttons, no bottom bar).
- **In the conversation.** `#3`, `PR #3`, `issue #2` mentions become live cards under the latest mention
  (same width as the composer) with Run checks / Merge / Start task / Open; the task's linked PR is pinned
  above the composer and expands in place.
- Design system: `docs/design-system.md` → _Composers and forms_, _Review: tasks, pull requests and issues_
  (including _In the conversation_), _Project workspace modal_. Native button variants mirror the web
  `Button` (`.workspacePrimary/.workspaceSecondary/.workspaceQuiet/.workspaceDanger`).

Code: `DeployCore/PullReview.swift` (pure, tested: changed files from a PR patch, check summary, merge
phase, mergeability, resulting pipeline, branch comparison, mention parsing), additive optional fields in
`ProjectModels.swift`, `WorkspaceStore.linkedPull/projectPulls/projectIssues`; `DeployUI/ProjectReviewModel`,
`ReviewComponents`, `ReviewDetailView`, `ReviewComposeView`, `ConversationReviewCard`, `WorkspaceControls`,
and a rebuilt `ProjectHubView`.

## Before → after

| Screen       | macOS before                                                               | macOS after                                                                                               | iOS before                        | iOS after                                                                                 |
| ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| PR list      | `before/mac-pr-list.png`                                                   | `after/mac-pr-list.png`                                                                                   | `before/ios-pr-list.png`          | `after/ios-pr-list.png`                                                                   |
| PR detail    | `before/mac-pr-detail-merged.png`, `before/mac-pr-detail-diff.png`         | `after/mac-pr-detail-merged.png`, `after/mac-pr-changes.png`, `after/mac-pr-ready-to-merge.png`           | `before/ios-pr-detail-merged.png` | `after/ios-pr-detail-merged-released.png`, `after/ios-pr-ready-to-merge.png`              |
| Checks       | one-line “Check … · succeeded”                                             | `after/mac-pr-checks-running.png`, `after/mac-pr-checks-history.png`                                      | same                              | `after/ios-pr-checks-running.png`                                                         |
| New PR       | `before/mac-new-pr.png`                                                    | `after/mac-new-pr.png`, `after/mac-new-pr-diverged-linked-task.png`                                       | `before/ios-new-pr.png`           | `after/ios-new-pr.png`                                                                    |
| Issue detail | `before/mac-issue-detail.png`                                              | `after/mac-issue-detail.png`, `after/mac-new-issue.png`                                                   | `before/ios-issue-detail.png`     | `after/ios-issue-detail.png`, `after/ios-issue-list.png`, `after/ios-new-issue.png`       |
| Merge        | stayed “Open” for seconds (`../dogfood-cross-device/11-mac-pr-merged.png`) | `after/mac-merge-confirm.png` → `after/mac-merged-pipeline-running.png` → `after/mac-merged-released.png` | —                                 | `after/ios-merge-confirm.png` → `after/ios-merging.png` → `after/ios-merged-released.png` |
| Task → PR    | none                                                                       | `after/mac-task-review-pr-link.png`                                                                       | none                              | `after/ios-task-review-pr-link.png`                                                       |
| Conversation | none                                                                       | `after/mac-conversation-mention-cards.png`, `after/mac-conversation-linked-pr.png`                        | none                              | `after/ios-conversation-mention-cards.png`                                                |

`mac-pr-checks-running.png`, `mac-pr-checks-history.png` and `mac-new-pr-diverged-linked-task.png` were
captured before the project modal chrome was rebuilt (they still show the old sidebar and bottom bar).

## Live run on SER (Tally test project), with the owner's approval

- Created issue #2 (and a comment), PR #3 `task-updated-time → main` linked to the “last-updated time” task.
- First checks on PR #3: `node-test` passed on SER; `xcode-test` failed on the Mac worker with
  `Could not resolve host: deploy.local` (transient DNS on this Mac). The UI showed “Checks failed” with the
  exact job error. Re-run passed on both computers.
- Rebased `task-updated-time` onto main (conflicts resolved; Tally's 5 tests pass) and force-pushed it.
  The UI correctly switched to “Checks are for an earlier commit” → re-ran → passed → merged from the Mac.
  Merging appeared instantly, Merged about 3 s later, then the push pipeline passed on both computers and
  `Deploy tally` released `43fc11e8`.
- Pushed `docs-last-updated`; created PR #4 on iPhone, ran checks, merged; released `2b244937`.
- Sent one approved message mentioning PR #4 and issue #2. The agent answered that it could not verify them
  (its sandbox `fetch failed`); the cards below its reply showed the real state.

## Verification

```
swift test --package-path native/Apple/Packages/DeployKit        # 28 tests passed
xcodebuild … -scheme DeployMac … build                           # succeeded
xcodebuild … -scheme DeployIOS -destination 'generic/platform=iOS Simulator' … build   # succeeded
node scripts/check-native-token-parity.mjs                       # 27 tokens
node scripts/build-workspace-icons.mjs --check                   # 33 icons
```

Checked live on macOS (signed Debug build, Local Network allowed by the owner) and the iOS 27 iPhone 18 Pro
Max simulator against SER.

## Notes and limits

- Found and fixed a latent transcript bug: on iPhone, when content changed height without a new message,
  the scroll position kept the tracked message's leading edge (at the 16 pt gutter) aligned and shifted
  the transcript 16 pt sideways. Horizontal drift now snaps back to 0.
- Tasks still have no task → branch path (the dogfood's read-only `.git` finding), so a PR's source branch
  must already exist. The composer links the task so the flow stays connected.
- Mention cards resolve only numbered pull requests and issues of the task's project; pipelines appear
  through PR checks and merge results, not by mention.
