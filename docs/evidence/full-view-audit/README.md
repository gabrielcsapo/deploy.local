# Full view design audit · 2026-10-16

The earlier verification was incomplete. This pass inspected every primary routed view family in the isolated application preview, checked the actual rendered design against the shared tokens, and corrected the defects listed below. It is a visual and interaction audit, not a claim that every possible state or production operation has been executed.

The evidence directory contains 82 indexed captures in `coverage.json`, plus sign-in/registration and recovery evidence. A capture is a view/state/viewport observation, not a separate route. `*-after.png` files show corrections; earlier captures preserve the findings. All viewport/document width pairs in the captured samples match. Screenshots use the system dark appearance; light palette values were checked in the shared token source but were not visually reviewed in this pass.

## Coverage

| View family              | Verified in browser                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing                  | Shared lavender/plum palette, service disclosure, floating Dashboard launcher; prior launcher interaction evidence is in `../workspace-polish`.                                                                                                                   |
| Sign-in and registration | Single sign-in form; registration mode switch without submitting a registration; real sign-in with a disposable local fixture account; command palette available immediately afterward.                                                                           |
| Tasks and chat           | Task list, selected row, existing conversation, new task editor, retained unsent draft, offline worker state, compact contextual drawer, code review and source diff.                                                                                             |
| Repository               | Repository and branch controls, full file table, source viewer, issues/list/detail/composition, pull requests/list/detail/composition. No merge or issue mutation was submitted in this pass.                                                                     |
| Application              | Full resource overview; compact service/storage rows; service/storage chooser and forms without saving; deployment history and output; runtime logs and unavailable/retry state; request activity; runtime settings.                                              |
| Analytics                | Measurement mapping, percentile line patterns, compact summary layout, data-transfer dialog, endpoint dialog, initial focus, Escape and return to trigger.                                                                                                        |
| Fleet                    | Applications table/search, computer inventory/search, separate task worker state, event list, log stream toolbar/filter/pause.                                                                                                                                    |
| Catalog                  | Browse, template detail, computer loading/selection, disabled install pending requirements, Compose import source form. No installation was executed.                                                                                                             |
| Shared applications      | Workspace and public empty states; removed references to an unavailable discovery toggle.                                                                                                                                                                         |
| Settings                 | Account, Security, Deployment admission, Backups, Maintenance, Design system. No passwords, backup policy, destinations or maintenance operations were changed.                                                                                                   |
| Design system            | Foundations, components, patterns, metrics, React/Tailwind recipes and update instructions; same components imported into application views.                                                                                                                      |
| Public reference         | Documentation index, deploying, configuration, nodes, managing, CLI, architecture, roadmap, troubleshooting; changelog; public discovery. Existing uncommitted documentation-index changes were present in the local preview and were not included in this patch. |
| Overlays                 | Project creation dialog, model/effort popover, account/provider usage, compact navigation drawer, service/storage creation menu/forms, analytics dialogs, computer-use empty viewer.                                                                              |
| Recovery                 | Missing page; root error details and Reload recovery encountered during a development hot refresh; actual unavailable runtime logs and Retry. Shared loading/empty/error specimens were verified in the preceding design-system reference pass.                   |

Compact checks at 390 × 844 covered tasks/chat/review, repository/issues/pull requests, applications/overview/deployments/activity/settings/logs, computers, catalog and documentation. Desktop checks used 1280 × 720. `/dashboard/projects` is an alias of the same task component and was reviewed through the registered route mapping, not a separate browser capture.

## Corrections made

- Removed duplicate signed-out forms from the palette-only data provider, and made it react to sign-in so keyboard commands work without a reload.
- Applied metric signal colors to statistics; latency percentiles use silver with solid/dashed/dotted patterns instead of warning/error colors. Added shared `StatCard` export and recipes.
- Made analytics summaries/charts respond to the available pane width. Improved database-count spacing and compact service rows.
- Kept log search visible at phone width; moved runtime scope into a disclosure and secondary tools into a locally scrolling toolbar. Log searches and toolbar buttons use shared React primitives.
- Replaced the oversized service/storage creation sheet with a compact dialog; applied shared fields/buttons, accessible titles and a Cancel action.
- Applied shared surfaces and insets to project creation, and removed the model picker's remaining blue accent.
- Used plain-entry focus for the task editor; selected tasks highlight the resource row. Review labels distinguish the working tree from its unchanged HEAD revision.
- Added explicit loading/empty/error/retry behavior to catalog computer selection. Removed the invented “Home” label for a coordinator target.
- Added activity and endpoint failure recovery; obsolete endpoint responses are ignored. Analytics dialogs share focus trapping and restore focus to the initiating control.
- Removed unrelated default-placement prompts from reading/settings surfaces. Runtime settings no longer present hardcoded managed-volume paths as universal application facts.
- Aligned public discovery and operations documentation with the current application sections; removed duplicate CLI upgrade documentation.
- Replaced large/raw route failure views with compact recovery actions.

## Validation and limits

Scoped formatting/lint, TypeScript and production build pass. A final clean browser run had no console errors. Server/runtime sources and production dependencies are unchanged by this patch; the obsolete static docs site, GitHub Pages workflow, docs build scripts and docs-only react-router development dependency were removed; no new claim is made that the server suite verifies browser presentation. The previous clean SER release passed 559 server tests with 14 skipped.

The candidate is separate from live SER. The user activated the preceding 2072ee7 release at 20:01 EDT; systemd and TLS HTTP checks confirmed that revision. These additional audit fixes still require activation with sudo authentication for the root-owned systemd service, followed by a live walkthrough. No live application data, credentials, database permissions, services or deployments were changed during this audit.

Coding execution remains unverified because the live task worker is offline. Runtime log data for the isolated fixture is unavailable because no matching graph instance is materialized; the unavailable and retry flow was checked. Install/apply/deploy/merge/delete, password changes, backup/restore, and real computer-control execution were not exercised. Multi-file review, nested-folder browsing and light-mode visual coverage are also outside this pass. These limits prevent a claim that every end-to-end operation or possible UI state is verified.

## Dropdowns and sidebar follow-up

All 24 single-value select usages now import the shared React `Select`. Trigger, menu, options, selected and disabled colors resolve to the same tokens. Chromium customizable-select support was verified in the actual preview; other browsers retain native picker behavior with a themed trigger. Repository branch selection was tested using Down/Enter, with the actual commit and file size changing from main (52 B) to review-layout (103 B). `repository-select-resize.png` captures the open tokenized menu.

The shared context divider resizes the outer workspace and nested repository grid together. Browser checks covered keyboard adjustment (224→240), pointer drag (240→322), route switching, reload persistence (322), Home (180), End (420), and double-click reset (224). Width constraints reserve 360 px for work. Compact layouts hide the divider and preserve their existing drawer/inline navigation. A short-window scroll test moved repository context to scrollTop 33.5 while the work pane stayed at 0. Context panes scroll locally.

## Native build verification

Xcode 27.1 built both DeployMac Debug (development team PYQ4EQ49YL) and DeployIOS Debug for generic iOS Simulator successfully. `codesign --verify --deep --strict` passed for both app bundles, including the embedded macOS control helper. Swift package tests passed: 10 tests, no failures. Builds used isolated DerivedData in `/tmp/deploy-native-audit-20261016`. This verifies the current local native working tree, including the user's existing native edits; those edits are not part of this web release. No physical-device build, fresh native UI walkthrough, provisioning change or installed-app replacement is claimed.

The display-awake timer expires around 04:01:58 EDT on October 17 (eight hours from the request). It is owned by a one-shot launchd job with KeepAlive disabled, so it survives the shell and does not restart after expiry.
