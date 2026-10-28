# Polish B capture handoff

Chromium fails before opening a page with `bootstrap_check_in … Permission denied (1100)`.
See `capture-attempt.log`. No implementation capture or pair was produced; visual parity and keyboard interactions remain unverified.

From the repository root, start these in separate terminals:

```sh
node docs/evidence/v2/polish-b/fixture-server.mjs
DEPLOY_DATA_DIR=/private/tmp/deploy-polish-b-preview DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5196 pnpm exec vite --host 127.0.0.1 --port 5197 --strictPort
```

The in-memory fixture imports no coordinator or database code. Browse port **5196**; 5197 serves assets only. The fixture fills and submits the new-agent description for NewAgentDraft and opens the restart editor for RuleEdit. Dates are relative to capture time. Stop both processes with Ctrl-C before running tests (they share the two assigned ports).

| Board             | Exact URL                                                                          | Widths   | Height |
| ----------------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| Project           | `http://127.0.0.1:5196/dashboard/projects/deploy.local?board=Project`              | 1440,700 | 900    |
| ProjectSettings   | `http://127.0.0.1:5196/dashboard/projects/home-gym/settings?board=ProjectSettings` | 1440,700 | 1160   |
| Logs              | `http://127.0.0.1:5196/dashboard/projects/deploy.local/logs?board=Logs`            | 1440,700 | 900    |
| SettingsAgents    | `http://127.0.0.1:5196/dashboard/settings/approvals?board=SettingsAgents`          | 1440,700 | 1260   |
| RuleEdit          | `http://127.0.0.1:5196/dashboard/settings/approvals?board=RuleEdit`                | 1440,700 | 900    |
| SettingsAgentsNew | `http://127.0.0.1:5196/dashboard/settings/approvals?board=SettingsAgentsNew`       | 1440,700 | 1320   |
| Main              | `http://127.0.0.1:5196/dashboard/agents/scout?board=Main`                          | 1440,700 | 900    |
| LongChat          | `http://127.0.0.1:5196/dashboard/agents/scout?board=LongChat`                      | 1440,700 | 900    |
| NewAgentDraft     | `http://127.0.0.1:5196/dashboard/agents/new?board=NewAgentDraft`                   | 1440,700 | 1200   |
| KeeperPage        | `http://127.0.0.1:5196/dashboard/agents/keeper?board=KeeperPage`                   | 1440,700 | 900    |

Exact capture commands:

```sh
mkdir -p docs/evidence/v2/polish-b/captures
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/projects/deploy.local?board=Project' docs/evidence/v2/polish-b/captures/Project 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/projects/home-gym/settings?board=ProjectSettings' docs/evidence/v2/polish-b/captures/ProjectSettings 1440,700 1160
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/projects/deploy.local/logs?board=Logs' docs/evidence/v2/polish-b/captures/Logs 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/settings/approvals?board=SettingsAgents' docs/evidence/v2/polish-b/captures/SettingsAgents 1440,700 1260
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/settings/approvals?board=RuleEdit' docs/evidence/v2/polish-b/captures/RuleEdit 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/settings/approvals?board=SettingsAgentsNew' docs/evidence/v2/polish-b/captures/SettingsAgentsNew 1440,700 1320
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/agents/scout?board=Main' docs/evidence/v2/polish-b/captures/Main 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/agents/scout?board=LongChat' docs/evidence/v2/polish-b/captures/LongChat 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/agents/new?board=NewAgentDraft' docs/evidence/v2/polish-b/captures/NewAgentDraft 1440,700 1200
node design/v2/tools/capture.mjs 'http://127.0.0.1:5196/dashboard/agents/keeper?board=KeeperPage' docs/evidence/v2/polish-b/captures/KeeperPage 1440,700 900
```

Pair and inspect every image (board left, implementation right):

```sh
for board in Project ProjectSettings Logs SettingsAgents RuleEdit SettingsAgentsNew Main LongChat NewAgentDraft KeeperPage; do
  for width in 1440 700; do
    uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py "docs/evidence/v2/polish-b/$board-$width.png" "design/v2/canvas/png/$board-$width.png" "docs/evidence/v2/polish-b/captures/$board-$width.png"
  done
done
```

Extra interactions: open Remove project and inspect its unavailable confirmation; change log level/search; edit and save a rule; verify the suggestion only opens the editor; rename Keeper, edit its schedule/triggers/coverage and create it. The fixture does not execute any removal or release.
