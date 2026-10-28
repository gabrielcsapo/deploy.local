#!/bin/bash
set -euo pipefail
# Run from the repository root with a booted 390-point iPhone simulator.
# Install only this simulator build; this script never touches a physical device.
root=docs/evidence/v2/12-ios-2
mkdir -p "$root/captures"
port=5186
simulator=${SIMULATOR_UDID:?Set SIMULATOR_UDID to your dedicated booted 390-point simulator}
origin="http://127.0.0.1:$port"
app=${IOS_APP:-/tmp/deploy-ios2-derived/Build/Products/Debug-iphonesimulator/Deploy.app}
cleanup() {
  xcrun simctl status_bar "$simulator" clear 2>/dev/null || true
  xcrun simctl terminate "$simulator" local.deploy.workspace.ios 2>/dev/null || true
}
trap cleanup EXIT
xcrun simctl install "$simulator" "$app"
xcrun simctl status_bar "$simulator" override --time '14:32' --batteryState charged --batteryLevel 100
xcrun simctl ui "$simulator" appearance light
for board in ReleasesPhone ReleasePhone ReleaseFailedPhone ShipPhone RollbackPhone RestorePhone SettingsPhone AgentMenuPhone NewProductPhone TaskInfoPhone ProjectPhone SignInPhone AnsweredPhone; do
  curl --fail --silent -X POST "$origin/fixture/board" -H 'Content-Type: application/json' -d "{\"board\":\"$board\"}" >/dev/null
  xcrun simctl terminate "$simulator" local.deploy.workspace.ios 2>/dev/null || true
  xcrun simctl launch "$simulator" local.deploy.workspace.ios --v2-fixture "$origin" --v2-board "$board"
  sleep 4
  xcrun simctl io "$simulator" screenshot "$root/captures/$board-native.png"
  uv run --no-project --python 3.13 --with pillow python - "$root/captures/$board-native.png" "$root/captures/$board.png" <<'PYIMAGE'
from PIL import Image
import sys
image = Image.open(sys.argv[1])
assert image.width % 390 == 0, "Use a 390-point simulator before capturing parity evidence"
image.resize((390, round(image.height * 390 / image.width))).save(sys.argv[2])
PYIMAGE
  uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py "$root/$board-390.png" "design/v2/canvas/png/$board-390.png" "$root/captures/$board.png"
done
xcrun simctl status_bar "$simulator" clear
# LockScreen requires real notification authorization on a dedicated test simulator.
# Fixture mode never requests it. See captures.md for the manual APNs acceptance steps.
