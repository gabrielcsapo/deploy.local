# deploy.local for iPhone

`DeployIOS` opens `DeployV2Root` and uses the `DeployCore` and `DeployUI` Swift packages.
The Mac, Windows and Linux desktop app is Electron in [`desktop/`](../../desktop/README.md).
The retired Swift Mac target and its legacy workspace screens are no longer built.
The independent server worker owns execution; backgrounding the iPhone client does not stop it.

## Build and test

From the repository root, with Xcode and XcodeGen installed:

```sh
xcodegen generate --spec native/Apple/project.yml
xcodebuild -project native/Apple/Deploy.xcodeproj -scheme DeployIOS -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath native/Apple/DerivedData build
swift test --package-path native/Apple/Packages/DeployKit
node --import tsx --test server/v2/contracts.test.ts
```

The simulator application is `native/Apple/DerivedData/Build/Products/Debug-iphonesimulator/Deploy.app`.
Generated Xcode projects and build outputs are ignored. Regenerate an existing project to remove
its old DeployMac scheme. Open `Deploy.xcodeproj` for Xcode Run and physical-device signing.
For a physical iPhone, select your development team in Xcode. Simulator builds include a
simulator-only application identifier and Keychain access group; do not disable signing.

DeployKit retains its macOS platform and compilation fallbacks so its package tests can run on
a Mac. That does not create a Mac application. The TypeScript contract tests compile Foundation-only
Swift decoders and fail if Swift is missing on macOS; Linux releases skip these checks when Swift
is unavailable. Fixtures are typed against `shared/v2/contracts.ts`, including its workspace exports.

## Connect

Use the coordinator's HTTPS origin and an existing deploy.local account. HTTP is accepted only
for loopback development. LAN devices require a trusted HTTPS coordinator; the client does not
bypass certificate trust or follow credential-bearing redirects to another origin or downgraded transport.
Login tokens use the app's private, device-only Keychain access group. Keep the team and bundle
identifier consistent across updates. The client suspends polling in the background and refreshes
on return; drafts remain local.

## Independent Mac utilities

`DeployControlHelper` remains a standalone macOS command-line target using `native/ControlHelper`.
Electron's download build also compiles that source directly. To build the helper with Xcode:

```sh
xcodebuild -project native/Apple/Deploy.xcodeproj -scheme DeployControlHelper -configuration Debug -derivedDataPath native/Apple/DerivedData build
```

Desktop's build discovers `DerivedData/Build/Products/Debug/deploy-control-helper`, or accepts
`DEPLOY_DESKTOP_HELPER`. Screen capture still requires OS permissions and per-task approval.
See [`desktop/README.md`](../../desktop/README.md) for packaging and signing.

The `menubar:*` root scripts build/install a separate supervisor status indicator from
`scripts/menubar/DeployLocalStatus.swift` with `swiftc` (and use `packages/node-app` on Linux).
They do not depend on DeployKit, DeployMac or the control-helper target.

Earlier Swift Mac build and visual acceptance records remain historical evidence in `docs/evidence/`.
The cleanup does not claim new iPhone build, physical-device or visual acceptance.
