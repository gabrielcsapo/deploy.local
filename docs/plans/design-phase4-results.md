# Design phase 4 implementation and verification

Implemented locally on `codex/phase4`. No server changes, push or deployment.

## Changes by file

Paths in the web section are relative to `app/`; native paths are relative to
`native/Apple/Packages/DeployKit/`.

| Files                                                                                                                                                        | Change                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ui/Skeleton.tsx`, `skeleton.css`, `index.tsx`, `components/LoadingState.tsx`                                                                     | Shared row/sidebar/conversation/detail placeholders and accessible first-load feedback. Existing LoadingState callers now use the shared skeleton. |
| `routes/dashboard/task-loading.css`                                                                                                                          | Removes the replaced conversation-specific placeholder styling.                                                                                    |
| `routes/dashboard/design-system.client.tsx`                                                                                                                  | Row, sidebar and conversation loading specimens in Feedback.                                                                                       |
| `design-tokens.json`, `design-tokens.css`, `design-system.css`, `motion.css`, `native-workspace.css`                                                         | Shared skeleton height, shimmer/spin durations and linear easing; token-based motion and immediate reduced-motion behavior.                        |
| `Sources/DeployCore/SidebarPreferences.swift`, `TaskTree.swift`, `WorkspaceStore.swift`                                                                      | Device-local coordinator/account pins, idle/running helpers, turn extraction and close/reopen with timed Undo.                                     |
| `Sources/DeployUI/TaskTreeViews.swift`, `WorkspaceView.swift`                                                                                                | Mac/iPad row actions, iPhone swipes, Pinned/Recents, spacing, idle ink, Undo announcement, skeleton call sites and transcript minimap integration. |
| `Sources/DeployUI/TurnMinimap.swift`                                                                                                                         | Visible-target tick highlights, prompt previews, one keyboard focus target and anchored jumps; hidden on iPhone.                                   |
| `Sources/DeployUI/WorkspaceSkeleton.swift`, `WorkspaceStyle.swift`                                                                                           | Shared native placeholders, static reduced-motion rendering, spacing and motion tokens.                                                            |
| `Sources/DeployUI/ProjectHubView.swift`, `RepositoryBrowserView.swift`, `ReviewDetailView.swift`, `ReviewWorkspaceView.swift`, `TaskActivityInspector.swift` | First-load repository, review, Changes and Activity skeletons.                                                                                     |
| `Tests/DeployCoreTests/TaskTreeTests.swift`                                                                                                                  | Pin isolation/persistence, exact idle boundary and user-turn extraction tests.                                                                     |
| `scripts/check-motion-tokens.mjs`, `package.json`                                                                                                            | Adds workspace motion checks to lint and lint:design, alongside palette/icon parity.                                                               |
| `docs/design-system.md`                                                                                                                                      | Documents sidebar behavior, skeletons, minimap, motion values and usage.                                                                           |
| `docs/plans/design-phase4-results.md`                                                                                                                        | This implementation and verification record.                                                                                                       |

## Checks run

The pinned pnpm 11.1.3 could not be downloaded/verified because the registry is inaccessible.
Checks use the installed pnpm 11.25.0 with `--pm-on-fail=ignore`, without changing the package-manager
pin or lockfile. Swift uses existing cached dependencies, `/tmp` module caches and `--disable-sandbox`
(the surrounding execution sandbox remains in effect).

| Check                                                                                                                | Result                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsc --noEmit -p .`                                                                                        | Passed.                                                                                                               |
| `pnpm typecheck`                                                                                                     | Passed.                                                                                                               |
| `pnpm lint`                                                                                                          | Passed; existing warnings remain. Design literals, motion, native palette and icon-action parity all pass.            |
| `pnpm exec oxfmt --check .`                                                                                          | Passed.                                                                                                               |
| `pnpm run build`                                                                                                     | Passed.                                                                                                               |
| `node --import tsx --test app/routes/dashboard/*.test.ts app/routes/dashboard/*.test.mjs app/components/ui/*.test.*` | 139 passed, 0 failed.                                                                                                 |
| Focused `node --import tsx --test` on every added/changed web test file                                              | 20 passed, 0 failed.                                                                                                  |
| `node --test` on task-tree, sidebar behavior and minimap model tests                                                 | 14 passed, 0 failed.                                                                                                  |
| `swift build --package-path native/Apple/Packages/DeployKit` with cache flags                                        | Passed for macOS.                                                                                                     |
| `swift test --package-path native/Apple/Packages/DeployKit` with cache flags                                         | 64 passed, 0 failed.                                                                                                  |
| DeployKit iOS simulator cross-build (`arm64-apple-ios17.0-simulator`)                                                | Passed, including iPhone/iPad conditional code.                                                                       |
| `xcodegen generate`                                                                                                  | Passed.                                                                                                               |
| iOS `xcodebuild`, DerivedData `/tmp/dd-ios-phase4`                                                                   | Blocked resolving packages: user module/manifest cache writes are denied; CoreSimulator is also unavailable.          |
| Mac `xcodebuild`, `CODE_SIGNING_ALLOWED=NO`, DerivedData `/tmp/dd-mac-phase4`                                        | Blocked resolving packages by the same cache permissions.                                                             |
| `pnpm test`                                                                                                          | Attempted; multiple environment failures and stalled HTTP suites. Interrupted after several minutes without progress. |
| Focused server API test with timeout/force-exit                                                                      | Confirms `listen EPERM: operation not permitted 0.0.0.0`.                                                             |
| Playwright Chromium launch                                                                                           | Blocked: macOS MachPortRendezvous bootstrap registration is denied by the sandbox.                                    |
| `git diff --check`                                                                                                   | Passed.                                                                                                               |

## Not verified

- The full server suite cannot be certified green in this sandbox, nor reduced to the four known
  macOS failures: local HTTP listeners are denied.
- Full signed/unsigned application integration builds did not reach compilation through Xcode.
  Both macOS and iOS DeployKit source paths do compile separately.
- Live web/Mac side-by-side screenshots, pointer/keyboard interactions, VoiceOver and iPhone swipe
  behavior could not be exercised visually. Web interaction tests cover models, API behavior and
  rendering contracts; they are not a substitute for browser end-to-end verification.
- On macOS 14/iOS 17, minimap highlighting uses the existing top-anchor signal; full visible-target
  highlighting uses macOS 15/iOS 18 APIs.
