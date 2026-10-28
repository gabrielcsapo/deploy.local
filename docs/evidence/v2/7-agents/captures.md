# Capture slice 7

Chromium launch is blocked by the sandbox (`bootstrap_check_in … Permission denied`, SIGTRAP).
No screenshots or pairs were produced; visual parity is unverified. Do not substitute board renders for implementation captures.

Start these two processes in separate terminals from this worktree. Neither uses a coordinator:

```sh
node docs/evidence/v2/7-agents/fixture-server.mjs
DEPLOY_DATA_DIR=/tmp/v2-agents-ui DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5184 pnpm exec vite --host 127.0.0.1 --port 5185 --strictPort
```

Open the **5184** URLs below (5185 supplies web assets only). The fixture injects a script to fill the New agent job, press Draft it for NewAgentDraft, and open Warden's restart rule for RuleEdit. These setup hooks are only in the fixture, never in application code. API fixture responses supply the same named agents, computers, prose and decisions as the boards. The current shared contracts cannot represent every board field; see notes.md.

| Board             | URL                                                                          | Widths    | Height |
| ----------------- | ---------------------------------------------------------------------------- | --------- | ------ |
| Main              | `http://127.0.0.1:5184/dashboard/agents/scout?board=Main`                    | 1440, 700 | 900    |
| LongChat          | `http://127.0.0.1:5184/dashboard/agents/scout?board=LongChat`                | 1440, 700 | 900    |
| Configure         | `http://127.0.0.1:5184/dashboard/agents/scout/tune?board=Configure`          | 1440, 700 | 900    |
| TuneWarden        | `http://127.0.0.1:5184/dashboard/agents/warden/tune?board=TuneWarden`        | 1440, 700 | 1240   |
| NewAgent          | `http://127.0.0.1:5184/dashboard/agents/new?board=NewAgent`                  | 1440, 700 | 900    |
| NewAgentDraft     | `http://127.0.0.1:5184/dashboard/agents/new?board=NewAgentDraft`             | 1440, 700 | 1200   |
| KeeperPage        | `http://127.0.0.1:5184/dashboard/agents/keeper?board=KeeperPage`             | 1440, 700 | 900    |
| SettingsAgents    | `http://127.0.0.1:5184/dashboard/settings/approvals?board=SettingsAgents`    | 1440, 700 | 1260   |
| RuleEdit          | `http://127.0.0.1:5184/dashboard/settings/approvals?board=RuleEdit`          | 1440, 700 | 900    |
| SettingsAgentsNew | `http://127.0.0.1:5184/dashboard/settings/approvals?board=SettingsAgentsNew` | 1440, 700 | 1320   |
| Settings          | `http://127.0.0.1:5184/dashboard/settings?board=Settings`                    | 1440, 700 | 900    |

Exact capture commands:

```sh
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/scout?board=Main' docs/evidence/v2/7-agents/captures/Main 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/scout?board=LongChat' docs/evidence/v2/7-agents/captures/LongChat 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/scout/tune?board=Configure' docs/evidence/v2/7-agents/captures/Configure 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/warden/tune?board=TuneWarden' docs/evidence/v2/7-agents/captures/TuneWarden 1440,700 1240
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/new?board=NewAgent' docs/evidence/v2/7-agents/captures/NewAgent 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/new?board=NewAgentDraft' docs/evidence/v2/7-agents/captures/NewAgentDraft 1440,700 1200
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/agents/keeper?board=KeeperPage' docs/evidence/v2/7-agents/captures/KeeperPage 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/settings/approvals?board=SettingsAgents' docs/evidence/v2/7-agents/captures/SettingsAgents 1440,700 1260
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/settings/approvals?board=RuleEdit' docs/evidence/v2/7-agents/captures/RuleEdit 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/settings/approvals?board=SettingsAgentsNew' docs/evidence/v2/7-agents/captures/SettingsAgentsNew 1440,700 1320
node design/v2/tools/capture.mjs 'http://127.0.0.1:5184/dashboard/settings?board=Settings' docs/evidence/v2/7-agents/captures/Settings 1440,700 900
```

Pair each capture (board left, implementation right), for example:

```sh
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/7-agents/Main-1440.png design/v2/canvas/png/Main-1440.png docs/evidence/v2/7-agents/captures/Main-1440.png
```

Review all 22 pairs before declaring parity. Also check the info dialog, menu, keyboard focus, narrow matrix, edited project rule, provider failure, successful create and sidebar refresh. Stop both fixture processes afterwards.
