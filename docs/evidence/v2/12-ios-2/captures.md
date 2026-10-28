# Native capture handoff

No app captures were produced here. CoreSimulator cannot connect in the sandbox;
see `simulator-capture.log`. Xcode fails before app compilation; see `xcode-ios.log`
and `xcode-mac.log`. The source renders were inspected; visual parity remains open.
A browser reproduction is not evidence of these SwiftUI screens.

1. Run `node docs/evidence/v2/12-ios-2/fixture-server.mjs` (only 127.0.0.1:5186).
2. Run `xcodegen generate --spec native/Apple/project.yml`, then build DeployIOS
   Debug for Simulator and DeployMac Debug (unsigned). Use a dedicated 390-point
   simulator, not a physical device. No fixture mode requests camera, photo-library,
   notification or Keychain permission; SignInPhone displays the scanner entry
   without starting the camera. The fixture uses no real coordinator or database.
3. Set `SIMULATOR_UDID` and `IOS_APP`, then run
   `bash docs/evidence/v2/12-ios-2/capture.sh` from the repository root.
4. Inspect every paired PNG and fix discrepancies. This remains an acceptance gate.

All screens use `http://127.0.0.1:5186`, native width **390 pt**, board height
**844 pt**. A newer simulator may have a taller safe area; the script preserves
that actual height rather than cropping content. Select each fixture with
`POST /fixture/board {"board":"<name>"}` and launch with
`--v2-fixture http://127.0.0.1:5186 --v2-board <name>`.

| Board              | Destination                                        |
| ------------------ | -------------------------------------------------- |
| ReleasesPhone      | Projects → home-gym → Releases                     |
| ReleasePhone       | Projects → deploy.local → Releases → 7f3b2d4       |
| ReleaseFailedPhone | Projects → home-gym → Releases → b81e4c0           |
| ShipPhone          | Meal planner → Ship sheet                          |
| RollbackPhone      | Warden → answered rollback and live steps          |
| RestorePhone       | Settings → Backups → home-gym restore sheet        |
| SettingsPhone      | Settings                                           |
| AgentMenuPhone     | Scout → native action sheet                        |
| NewProductPhone    | Meal planner conversation                          |
| TaskInfoPhone      | Meal planner → Task info                           |
| ProjectPhone       | Projects → deploy.local section                    |
| SignInPhone        | QR sign-in sheet; scanner disabled in fixture mode |
| AnsweredPhone      | Waiting on you → Answered                          |

## Lock screen and actions

LockScreen cannot be accepted by rendering a SwiftUI imitation. On a dedicated
simulator with notifications already permitted, fetch `/fixture/push`, save it to
a temporary `.apns` file, and use `xcrun simctl push "$SIMULATOR_UDID"
local.deploy.workspace.ios /tmp/ios2-push.apns`. Open the notification and exercise
Approve, Not now and Open; verify `on: iphone` in `/api/v2/inbox?state=answered`.
Reset `/fixture/board` between decisions. Repeat an already-answered decision and
an unavailable-network action; check that no success is fabricated. Confirm that
the failed-answer notification opens the correct scoped inbox item. Unlock is
required for Approve/Not now. Capture the real notification and pair with
`design/v2/canvas/png/LockScreen-390.png` using `design/v2/tools/pair.py`.

The capture script deliberately does not request permission or send push. Do not
change a real coordinator's APNs settings or register a physical device for this
fixture check. Camera scanning, full TLS pin validation, Keychain persistence,
real device-token revocation and APNs delivery need separate device acceptance.
