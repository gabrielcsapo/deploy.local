#!/bin/bash
set -euo pipefail
# Run from the repository root with a booted 390-point iPhone simulator.
# Install only this simulator build; this script never touches a physical device.
root=docs/evidence/v2/12-ios-1
port=${PORT:-5189}
origin="http://127.0.0.1:$port"
app=${IOS_APP:-/tmp/deploy-ios-derived/Build/Products/Debug-iphonesimulator/Deploy.app}
xcrun simctl install booted "$app"
xcrun simctl status_bar booted override --time '14:32' --batteryState charged --batteryLevel 100
xcrun simctl ui booted appearance light
for board in HomePhone ComposePhone TaskPhone AskPhone ChangesPhone AttachPhone AttachedPhone ModelPhone AnsweredPhone OfflinePhone LivePhone WorkerPhone Phone ProjectPhone ComputePhone SettingsPhone ScoutPhone AgentInfoPhone; do
  curl --fail --silent -X POST "$origin/fixture/board" -H 'Content-Type: application/json' -d "{\"board\":\"$board\"}" >/dev/null
  xcrun simctl terminate booted local.deploy.workspace.ios 2>/dev/null || true
  xcrun simctl launch booted local.deploy.workspace.ios --v2-fixture "$origin" --v2-board "$board"
  sleep 4
  xcrun simctl io booted screenshot "$root/captures/$board-native.png"
  uv run --no-project --python 3.13 --with pillow python - "$root/captures/$board-native.png" "$root/captures/$board.png" <<'PYIMAGE'
from PIL import Image
import sys
image = Image.open(sys.argv[1])
assert image.width % 390 == 0, "Use a 390-point simulator before capturing parity evidence"
image.resize((390, round(image.height * 390 / image.width))).save(sys.argv[2])
PYIMAGE
  uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py "$root/$board-390.png" "design/v2/canvas/png/$board-390.png" "$root/captures/$board.png"
done
curl --fail --silent "$origin/fixture/push" > "$root/push.apns"
xcrun simctl push booted local.deploy.workspace.ios "$root/push.apns"
# LockScreen and AgentMenuPhone require opening the native notification/menu before capture.
# Capture with simctl io, then pair exactly as above. Do not substitute browser renders.
xcrun simctl status_bar booted clear
