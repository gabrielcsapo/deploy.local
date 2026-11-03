#!/usr/bin/env bash
# The orchestrator runs this with an installed Debug app on a booted 390-point iPhone.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
: "${SIMULATOR_UDID:?Set SIMULATOR_UDID to a booted 390-point iPhone simulator}"
BUNDLE_ID="${BUNDLE_ID:-local.deploy.workspace.ios}"
CAPTURE_WAIT_SECONDS="${CAPTURE_WAIT_SECONDS:-5}"
FIXTURE_ORIGIN='http://127.0.0.1:5186'
boards=(
  WorkNoAgentsPhone WorkAgentsPhone NewAgentBlankPhone NewAgentPhone
  AgentAvatarPickerPhone AgentHelloPhone AgentTaughtPhone AgentBeatPhone
  AgentPhone AgentMenuPhone AgentInfoPhone AgentInfoNewPhone AgentCareDetailsPhone
  AgentRoutinePhone AgentBeatProjectsPhone AgentRunsPhone SettingsApprovalsPhone
  AgentRulesPhone TaskMentionPhone
)
if (($#)); then
  for requested in "$@"; do
    found=false
    for board in "${boards[@]}"; do
      if [[ "$requested" == "$board" ]]; then found=true; break; fi
    done
    if [[ "$found" != true ]]; then echo "Unknown board: $requested" >&2; exit 1; fi
  done
  boards=("$@")
fi
# Do not send fixture commands to an unrelated service using the same port.
curl --fail --silent --show-error --max-time 5 "$FIXTURE_ORIGIN/fixture/board" |
  node --input-type=module -e '
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    if (JSON.parse(text).fixture !== "agents-p1-ios") throw new Error("Start ios-fixture-server.mjs on 127.0.0.1:5186");
  '
xcrun simctl get_app_container "$SIMULATOR_UDID" "$BUNDLE_ID" app >/dev/null
mkdir -p docs/evidence/agents-p1/ios
cleanup() { xcrun simctl terminate "$SIMULATOR_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for board in "${boards[@]}"; do
  cleanup
  curl --fail --silent --show-error --max-time 5 \
    -H 'Content-Type: application/json' -X POST \
    --data "{\"board\":\"$board\"}" "$FIXTURE_ORIGIN/fixture/board" >/dev/null
  xcrun simctl launch "$SIMULATOR_UDID" "$BUNDLE_ID" \
    --v2-fixture "$FIXTURE_ORIGIN" --v2-board "$board"
  sleep "$CAPTURE_WAIT_SECONDS"
  xcrun simctl io "$SIMULATOR_UDID" screenshot "docs/evidence/agents-p1/ios/$board-390.png"
  cleanup
  echo "Captured $board"
done
