# deploy.local for macOS and iOS

Two SwiftUI application targets share `DeployCore` (protocol, credentials, drafts, connection
and session state) and `DeployUI` (project navigation, conversation, composer, review and preview).
The independent server worker owns execution. Closing or backgrounding either client does not
stop the agent. The browser uses the same workspace API and durable task records.

## Build

From this directory, with Xcode and XcodeGen installed:

```sh
xcodegen generate
swift test --package-path Packages/DeployKit
xcodebuild -project Deploy.xcodeproj -scheme DeployMac -configuration Debug -derivedDataPath DerivedData DEVELOPMENT_TEAM=YOUR_TEAM_ID -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcodebuild -project Deploy.xcodeproj -scheme DeployIOS -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData build
```

The Mac target also builds and embeds `Contents/Helpers/deploy-control-helper`. To enable desktop
control on an independent macOS worker, explicitly set `DEPLOY_DESKTOP_HELPER` to that executable
inside the installed app (for example `/Applications/Deploy.app/Contents/Helpers/deploy-control-helper`).
The helper inherits the selected Xcode signing identity; use the same identity across updates.
Use a registered Mac and a consistent development team for the private Keychain entitlement.
Ad hoc signing cannot validate saved login. OS permissions and per-task window approval are still required;
bundling the helper does not enable capture/input.

The macOS application is `DerivedData/Build/Products/Debug/Deploy.app`; the simulator application
is `DerivedData/Build/Products/Debug-iphonesimulator/Deploy.app`. The generated project and build
outputs are ignored. Open `Deploy.xcodeproj` for Xcode Run and physical-device signing.

Simulator builds include a simulator-only application identifier and Keychain access group.
Do not disable simulator code signing: the Keychain entitlement is needed for saved login.
For physical devices, select your own development team in Xcode; distribution signing and
provisioning are not configured by this pilot.

## Connect and use

Start the workspace coordinator and independent worker using the root README. Connect with the
coordinator's HTTPS origin and an existing deploy.local account. HTTP is accepted only for
loopback development (the local pilot API is `http://127.0.0.1:17843`). LAN devices require a
trusted HTTPS coordinator; the client does not bypass certificate trust. API credentials never
follow redirects to another origin or a downgraded transport.

Create or import a repository, create a task on an execution computer, and send a message.
The model field accepts the worker provider's exact model identifier; an empty field uses its
configured default. Available adapters come from the coordinator. A compatible endpoint is
available only after explicit server configuration; no paid fallback is selected automatically.

On macOS, Command-N creates a task, Command-Return sends, Command-R refreshes, and
Command-Shift-I toggles the review pane. On iPhone, use the compose button in the project list
and the tools button beside the task status. Drafts and the selected task are retained locally.
The client polls compact event cursors and loads updated task data when events arrive, with a
periodic worker-status refresh. iOS suspends polling in the background and refreshes on return.
macOS saves the draft before sleep and restarts polling on wake; real sleep/wake acceptance remains pending.

Login tokens use the app's private, device-only Keychain access group. macOS explicitly uses the
data-protection Keychain. Older prototype items in the legacy Keychain are left untouched; sign in
once with the signed app to save a new item. Install the app at a stable path (such as
`~/Applications/Deploy.app`) and keep the same team and bundle identifier for updates. This avoids
cycling temporary/ad hoc app identities through macOS privacy permissions. If a stale development
installation reports Local Network prohibited despite an enabled switch, quit the app, refresh its
existing Local Network permission in System Settings, then reopen the stable signed installation.
Never bypass TLS trust or alter Keychain access rules to work around this.

Mac login, LAN HTTPS, selected task and draft retention passed quit/relaunch and replacement with
a newly built, consistently signed app. Expired sessions stop polling and offer Sign in again while
preserving conversation/draft state; network failures continue reconnecting. The original send ID
survives reauthentication so a retry cannot dispatch a second copy of an acknowledged command.

## Verification and limits

Built on Xcode 27 / Swift 6.4, tested on this arm64 Mac and the iOS 27 iPhone 18 Pro Max simulator.
The live disposable pilot verified native sign-in, repository/task creation, Command-N and
Command-Return, a real coding run, iOS continuation of that same session, browser observation,
and reviewing generated files in the compact iPhone tools sheet. Keychain login survived the
iOS app reinstall/relaunch. Later physical iPhone checks passed trusted home HTTPS, Codex and Claude
cross-surface continuation, coordinator outage/recovery, signed update retention, and a user-operated
Wi-Fi interruption with the draft intact. See the latest implementation evidence for remaining gates.

Task browser and computer sessions run on explicitly enabled workers. Clients share the same
session, can take over or return control to the agent, and can stop it. On macOS, the selected
window appears as a draggable overlay inside the conversation; hover or focus reveals controls.
The agent discovers and requests an exact target through tools; clients show Allow / Not now
for that target, with no target dropdown or manual setup form. Drag the preview while the agent
owns it, or use the move handle after takeover. The web client uses the same contained presentation;
iOS uses a sheet. The request tool waits for approval and resumes the same agent turn automatically;
stopping the run cancels the pending grant. Worker restart remains an explicit recovery case.

The Mac helper uses window capture and background accessibility actions. Disposable TextEdit
acceptance verified caret placement, a toolbar click, scrollbar movement, and typing without a
before/after foreground-app or pointer change. Unsupported controls fail instead of activating
the app. This is not general application compatibility or continuous focus-monitoring coverage.
Codex and Claude subscription acceptance completed inspect, scroll, click, verify and stop with
one prompt and one approval per task, without another message. Both reported the observed changes. Qwen3-8B trials were
inconsistent; release acceptance now focuses on Codex and Claude while the compatible endpoint
remains available for larger models. Evidence: `docs/evidence/workspace/codex-automatic-continuation.json` and
`docs/evidence/workspace/claude-automatic-continuation.json`.
The Mac app and embedded helper pass development-signature verification. Distribution/notarization,
provider-native permission/question round trips, steering and broader acceptance remain tracked in
`docs/plans/workspace-implementation.md`.

## Agent questions

The shared `deploy_ask_user` tool displays a compact question card with choices, a custom answer,
Skip and Continue. Command-Return submits the answer. The ordinary message draft stays intact;
unsubmitted answers survive reopening. Resolved questions appear in a collapsed conversation history.
The same provider turn continues after answering, and an answer never grants computer access.
Real Codex continuation through `WorkspaceStore` over LAN HTTPS is verified. Native card layout and continuation now pass on macOS (Codex, Command-Return) and the iOS
simulator (Claude, Continue). Physical-iPhone question interaction remains pending. The polished
conversation and 1,000-message task-switch checks pass on Mac and the iOS simulator. Transcript
scroll state is reset when switching tasks so a previous long history cannot leave a short one blank.
