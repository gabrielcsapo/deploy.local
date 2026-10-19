# iPhone native navigation and lists

Reviewed against `e6f9e71` on `codex/mobile-ios`, 2026-10-19. Changes are uncommitted. Only `native/Apple/**` and this note were edited; `app/`, dependencies and the generated token/icon contracts were not changed.

## Current-code findings

The capture findings were checked before implementation:

- Confirmed: no four-destination tab shell; task rows had only a title and an active dot; the project tree contained New task rows; the root used a custom deploy.local header and bottom compose button.
- Confirmed: the project sheet had Done plus an in-content Back button for work-item details. Repository folders/files used an in-content back action. Pipeline status and review file status were small secondary captions without per-file counts.
- Confirmed: conversation placement/status occupied a separate row; review had the iOS-only Controls segment; activity disclosure indicators were separated from their labels by spacers.
- Already absent in this revision: “Back to chat” pills and a conversation grid button. Settings was already a connection form with Done. The profile button was in the custom sidebar header, rather than a navigation toolbar.
- Already changed: the project hub used a split-view section list, not the four-way segmented control shown in older captures. The new compact hub provides the requested chips in place of that split navigation.
- Already present: file diffs scrolled horizontally, and the core diff parser removed `diff --git`, index and old/new path headers. The missing pieces were a scroll cue, optional wrapping, counts and a friendly new-file label.
- No explicit `.blue` declarations were present. Root/project/repository tint already used the shared accent. Tint remains global for the new shell and its presentations; pipeline job titles now explicitly use primary text on iOS, with semantic status badges.

## Screen changes and navigation

- **Tasks:** compact iOS `TabView` with Tasks, Repositories, Applications and Computers. Each tab owns a `NavigationStack`; roots use large system navigation titles. Tab icons are rendered from the existing `WorkspaceGlyph` vectors into template images for the native tab bar. Tasks has toolbar compose and a profile link to Settings, search across all tasks, Needs you and Recent sections, and a separate Projects section. Rows show semantic status dots, title, project, status and relative update time, with at least 44-point height. Titles can use two lines at accessibility sizes. There are no persistent New task/project-overview action rows.
- **Attention data:** review/ready/failed/error tasks are grouped into Needs you. Pending answers use the existing task-detail endpoint for running tasks because the workspace summary does not contain questions. Reads refresh when workspace state changes, respect cancellation/account changes and retain known pending state across transient read failures. No coordinator API or transport behavior changed.
- **Repositories:** lists the existing projects. Opening a project pushes the hub. Compact folder and file navigation uses native pushed destinations and swipe-back; branch selection uses the existing refs, and folder/file requests use the existing repository tree/blob endpoints. Folder destinations preserve the returned immutable commit. Files retain source selection and horizontal/vertical scrolling; folder lists support pull to refresh.
- **Project hub:** horizontally scrolling, accent-filled selected chips for Issues, Pull requests, Pipelines and Repository. Work-item details and create/edit forms push in the existing tab stack. Empty work lists use `ContentUnavailableView` with the existing create/run action. Pipeline/run/job state uses `StatusBadge`. There is no project-sheet Done or custom detail Back on this pushed compact path. Opening/starting a linked task switches to the Tasks stack.
- **Applications:** honest unavailable screen. `WorkspaceState` and the native store have no application collection or loading path, including the current macOS native app. No applications were invented and no new API was assumed. A connected coordinator can be opened in the browser.
- **Computers:** lists the same worker data used by macOS, including names, platforms and semantic status, with pushed details/provider usage. Computer control stays task-scoped and is available from the conversation Changes menu; the list explains that entry point.
- **Settings:** the Tasks profile button pushes account/provider usage and connection settings. The existing connection form supports pushed presentation without its sheet Done button. Login, disconnect, Keychain handling and provider data paths are unchanged.
- **Conversation:** system back button, title and computer/status subtitle with a semantic dot, and one Changes N menu/button. Tap opens review; the menu includes Computer control. The separate compact placement row is removed. At XX Large and above, the title/subtitle move into a growing header below the system bar, allowing two lines each instead of crowding its fixed height. Jobs/checkpoints/releases show eight identifying characters around a middle ellipsis, with full values available through Copy context menus. Unknown computer IDs receive the same abbreviation and copy action. Activity chevrons follow the label rather than a trailing spacer.
- **Review:** only Changes and Checks. Computer control uses its existing `BrowserPanel` in a separate presentation reached through the conversation menu, rather than a third review tab. File rows show +/− counts derived from the returned patch, and accessible labels announce those counts. Diff scrolling has a trailing fade plus visible indicators; Wrap diff lines offers an alternative. New-file metadata reads New file. Binary/missing text retains the existing unavailable-diff explanation. Review, computer control and expanded control each have one Done control; existing connection/project/custom-model sheets retain their single dismiss control.

The new shell/hub/repository layouts are gated to compact iOS. iOS-only presentation/readability helpers are compiled out on macOS. The macOS split view, utility rail, floating computer viewer, project sheet navigation, review layout and typography remain on their existing paths. Draft storage, send/retry transport, questions, provider selection and computer control commands were retained.

## Verification

Passed:

- `xcodegen generate` in `native/Apple` (project remains ignored).
- macOS `swift build` of DeployKit.
- `swift test` of DeployKit: **18 tests passed**, including session/draft/retry, worker/provider selection and review parsing tests.
- iOS simulator DeployKit build using `--triple arm64-apple-ios17.0-simulator` with the installed iPhoneSimulator SDK. Both DeployCore and DeployUI compile for the simulator, including the iOS-only views.
- `node scripts/check-design-literals.mjs`.
- `node scripts/check-native-token-parity.mjs`: **27 tokens in both appearances**.
- Swift source parsing, `git diff --check`, and a native-source check for `.system(size:)`/`.blue` (none).

SwiftPM initially failed writing `/Users/gabrielcsapo/.cache/clang/ModuleCache` (Operation not permitted). After redirecting caches, dependency fetches failed with `Could not resolve host: github.com`. Read-only copies of the three existing global dependency caches were placed under `/tmp`, allowing offline builds with the already pinned versions. No other checkout was used or modified.

Successful SwiftPM command shape (replace `build` with `test` for the tests):

```sh
CLANG_MODULE_CACHE_PATH=/tmp/deploy-ios-clang-cache \
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/deploy-ios-swift-cache \
swift build --package-path native/Apple/Packages/DeployKit \
  --scratch-path /tmp/deploy-ios-swift-build \
  --cache-path /tmp/deploy-ios-spm-cache \
  --config-path /tmp/deploy-ios-spm-config \
  --security-path /tmp/deploy-ios-spm-security \
  --disable-sandbox --skip-update
```

The simulator package build adds:

```sh
--triple arm64-apple-ios17.0-simulator \
--sdk /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk
```

The full app build was attempted from `native/Apple`:

```sh
xcodebuild -project Deploy.xcodeproj -scheme DeployIOS \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/deploy-ios-derived \
  -clonedSourcePackagesDirPath /tmp/deploy-ios-xcode-packages \
  CODE_SIGNING_ALLOWED=NO build
```

It first failed during package resolution because its manifest cache/module cache paths were outside the writable sandbox. Retrying with `CFFIXED_USER_HOME`, Clang/Swift module-cache overrides, `-packageCachePath /tmp/deploy-ios-xcode-cache` and `-skipPackageUpdates` reached the next sandbox restriction: **`sandbox-exec: sandbox_apply: Operation not permitted`**. Xcode also reported **CoreSimulatorService connection refused / no simulator runtimes discovered**. Logs are `/tmp/deploy-ios-xcodebuild.log` and `/tmp/deploy-ios-xcodebuild-retry.log`. The package simulator compilation succeeded separately with SwiftPM's nested sandbox disabled; the outer workspace sandbox remained in effect.

## Remaining verification and gaps

- The user subsequently reported successful full Xcode iOS and macOS app builds outside the sandbox, and a real-coordinator visual review on iPhone 18 Pro Max / iOS 27. The sandbox failures above describe the initial in-sandbox attempts, not the external build result.
- The external review confirmed the four-tab shell, large titles, native back/swipe, purple tint, Needs you grouping, conversation header, review controls/counts/wrapping/fade and hub chips. Narrow iPhones, both appearances, AX2/VoiceOver, and the follow-up fixes below still need visual verification.
- Live login, task creation/send/draft restoration, questions, pipeline actions, repository browsing, review/check refresh and computer interaction need connected end-to-end testing. Existing core regression tests pass, but they do not substitute for those UI flows.
- Applications intentionally remains unavailable until the native store has an application loading path.

## Follow-up from the external iPhone review

The user reviewed the original build against a real coordinator on iPhone 18 Pro Max / iOS 27 and reported successful full iOS and macOS Xcode app builds outside the sandbox. The following fixes preserve those reviewed layouts and are limited to compact iOS:

1. Tasks profile, compose and repository-add toolbar controls now use glyph-only content (`user`, `compose`, `plus`) with explicit accessibility labels and 44-point targets. Their labels contain no hidden `Text` for the iOS toolbar to promote into a text capsule. Shared macOS toolbar labels are unchanged.
2. Needs you, Recent and Projects render only when populated. When there are no matching tasks, the empty state sits in an unnamed section rather than beneath an empty Recent header.
3. Task timestamps now display a single compact unit (`12m`, `3h`, `2d`; `now` below one minute), updating every minute. Their accessibility labels use the full localized relative phrase.
4. Status color and fill now share a tone classification. Online/healthy/completed and active/running statuses use solid dots; only inactive tones are hollow. Audited the badge used by Computers and pipelines, task-list dots, the conversation subtitle, the legacy active-task indicator and computer-control session dots. Compact task/subtitle/control dots also use the shared rendering helper. macOS dot rendering is unchanged.
5. Pushed task/conversation and New task destinations hide the tab bar with a destination-scoped toolbar modifier. Returning to a tab root restores its default visible tab bar; no global tab-bar state or appearance setting is changed.
6. Processes across computers uses the same compact disclosure style as the Ran commands activity rows, placing its chevron immediately after the label. Nested process labels also drop their compact-only trailing spacer. macOS retains its original disclosure layout.
7. Added/untracked files suppress hunk-header rows in compact review, identified by the changed-file status or `new file mode` metadata. Modified files retain their hunk headers. This is a presentation filter: the shared parser, source line numbers and +/− counts are unchanged, as are macOS diffs.

Follow-up verification:

- `swift build --package-path native/Apple/Packages/DeployKit`: the plain invocation again failed writing the default Clang module cache (`Operation not permitted`). Retrying with the `/tmp` module/cache/config/security/scratch paths and `--disable-sandbox --skip-update` documented above **passed** for macOS.
- `swift test` with the same sandbox-compatible options: **18 tests passed**.
- Additional iOS simulator package build with the same options plus the simulator triple/SDK documented above: **passed**, compiling the new compact-only code.
- `node scripts/check-design-literals.mjs`: **passed**.
- `node scripts/check-native-token-parity.mjs`: **passed**, 27 tokens in both appearances.
- Swift source parsing and `git diff --check`: **passed**.

Follow-up logs are `/tmp/deploy-ios-followup-default-build.log`, `/tmp/deploy-ios-followup-build.log`, `/tmp/deploy-ios-followup-test.log` and `/tmp/deploy-ios-followup-simulator.log`. No new simulator captures or connected UI runs were produced in this sandbox, so glyph-only toolbar rendering, tab-bar restoration and the other follow-up visual fixes await the external simulator check. All changes remain uncommitted.

## Rendered review

Full Xcode builds of `DeployIOS` (iOS Simulator) and `DeployMac` succeeded outside the sandbox. The iOS build was run on the iPhone 18 Pro Max simulator (iOS 27) against an existing coordinator session:

- Tab bar with Tasks, Repositories, Applications and Computers; large root titles; system back and swipe-back; purple tint throughout.
- Tasks: "Needs you" group with status dot, project and compact age ("2d"); empty sections hidden; icon buttons for settings and compose.
- Conversation: two-line title with status, single "Changes N" button, tab bar hidden inside the task, activity chevrons beside their labels.
- Review: Changes and Checks only, per-file +/− counts, "New file" label, wrap toggle; hunk headers hidden for new files (confirmed in code).
- Computers: "Online" uses a solid dot. Applications shows an honest unavailable state.
- Not checked: Dynamic Type AX sizes, iPad, dark mode, and a physical device.
