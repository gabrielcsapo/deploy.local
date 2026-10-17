# Divider clarity and native client verification

Pane dividers remain neutral, stationary boundaries. The old full-height accent bar has been replaced by a centered horizontal resize affordance on hover, keyboard focus and drag. The entire visible affordance accepts dragging. Keyboard resizing and pointer capture remain in the shared separator. Scrollable repository/source/diff focus uses a dashed inset boundary instead of a solid full-height accent outline that resembles a scrollbar.

## Native client

The installed native client was still using the retired pilot service `https://deploy.local:18459` as `devicepilot`, explaining its connection error. The Connection settings form is prepared for `https://deploy.local` and `gabrielcsapo`; account sign-in requires the user to enter their password. No credentials were injected into the app's Keychain or certificate checks bypassed.

Source review found two real native compatibility gaps with the deployed managed-worker architecture. New conversations kept the obsolete `local` default when that worker no longer existed; the model picker used the root coordinator's provider availability rather than the selected worker's connection. The client now selects an existing online computer when its default is missing, preserves explicit computer choices, and uses actual worker provider metadata. Unavailable or offline providers cannot start a new task. Three new regression tests cover this behavior and legacy worker compatibility.

Both macOS and iOS Simulator targets built successfully; both bundles passed strict signature verification. All 13 Swift tests passed. The newly signed Mac build was installed at the existing `~/Applications/Deploy.app` path and launched. The prior signed app is backed up at `/tmp/deploy-native-before-bef0d21/Deploy.app`. The build includes the user's pre-existing native working-tree changes; those edits were preserved and not included in these commits.

A temporary integration executable compiled the actual DeployCore sources and used the normal WorkspaceClient/WorkspaceStore API stack against trusted `https://deploy.local`. It connected, decoded the managed SER worker and selected it over the absent local default, read the real conversation and three-file diff, decoded the successful checkpoint job, and loaded hosted repository branches. Codex was available and Claude unavailable exactly as reported by the worker. It used an existing operator CLI credential in a private temporary file, made read-only requests, did not save native credentials, and removed the temporary credential afterward. `native-live-api.json` contains only the nonsecret results.

Interactive native sign-in and the authenticated app walkthrough remain pending the user's password entry. iOS was build/signature checked; no new simulator or physical-phone walkthrough is claimed.

## Server validation

The first clean SER preparation exposed a real concurrent-first-open SQLite race: one of four worker contenders failed while enabling WAL mode. A bounded retry now handles only `SQLITE_BUSY` during initial WAL promotion; other database errors remain visible. The existing concurrent-worker ownership regression passed after the fix, followed by the clean release suite and repeated SER startup contention checks. This changes neither database ownership nor worker lease authority.

Final deployed web revision: `cafe0481da983e470766980c240e653fae4c5769`. Clean SER validation passed **566 tests, 14 skipped, zero failures**. The corrected concurrent-worker test passed ten repeated SER runs. No deployment or coding run was active during activation.

Live browser verification confirmed the old full-height pseudo-track is absent, the resize affordance is 28 px tall, and pointer drag from its outer edge changes the sidebar from 224 to 256 px. Shift-Left restores 224 px. Pointer focus on source does not paint a full-pane accent border; keyboard focus uses a 1 px dashed inset outline. `divider-before.png` / `divider-after.png` show the visual correction; `source-keyboard-focus-after.png` shows the distinct keyboard state.
