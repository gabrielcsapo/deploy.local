# Projects / Live and repository join captures

Run from the repository root with dependencies installed. The server mounts the real `V2Layout`, Projects (including project/app detail and dialogs), and Live components using the same small router shim as the earlier review fixture. It does not render board HTML in place of the app.

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5180 node --import tsx docs/evidence/projects-join/fixture-server.ts
```

Each launch creates a new temporary `DEPLOY_DATA_DIR`, overriding any inherited value. Each reset URL clears and reseeds that directory's workspace and deployment records. SIGINT/SIGTERM closes the stores and removes the directory. Only loopback port 5180 (or `PORT=5181` through 5189) is used. Set the same `PORT` for the capture runner if changing it.

The fixture uses the real project membership, stage, Discover classification and unlinked-app readers. Health, release, repository and sidebar responses are seeded snapshots. Repository records deliberately bypass Git inspection; there are no Git commands, mDNS publishers, coordinator processes, workers, Docker operations, health probes or outbound requests. All API mutations return 405, including repository inspection, creation, joining, restarts, task creation and rollback. The fixture is for observing the pre-submit states, not testing those operations. Auth is synthetic and local. A fixture-only Vite transform redirects the layout’s Google Fonts stylesheet to local Hanken files, and both the page CSP and capture runner restrict requests to this fixture origin.

## Reset URLs and captures

**Run captures sequentially:** every reset replaces data shared by every open fixture page. A fresh browser context per capture avoids remembered data, theme and sidebar preferences. The reset redirects to a real dashboard path with a `fixtureState` query marker. Dialog states open their base page; the runner performs the clicks below. For manual review, perform the same action after opening the URL.

| State                 | Reset URL                                                   | Action after redirect                        | Height |
| --------------------- | ----------------------------------------------------------- | -------------------------------------------- | ------ |
| Projects              | http://127.0.0.1:5180/__fixture?state=Projects              | None                                         | 1040   |
| Live                  | http://127.0.0.1:5180/__fixture?state=Live                  | None; light theme                            | 1160   |
| LiveDark              | http://127.0.0.1:5180/__fixture?state=LiveDark              | None; dark theme                             | 1160   |
| AppNoRepository       | http://127.0.0.1:5180/__fixture?state=AppNoRepository       | None; pantry's app project                   | 900    |
| AddRepository         | http://127.0.0.1:5180/__fixture?state=AddRepository         | Click **Add a repository**                   | 900    |
| NewProjectExistingApp | http://127.0.0.1:5180/__fixture?state=NewProjectExistingApp | Click **New project**, type `pantry` in Name | 900    |
| ProjectEmpty          | http://127.0.0.1:5180/__fixture?state=ProjectEmpty          | None; recipes' empty repository              | 900    |
| AddExistingApp        | http://127.0.0.1:5180/__fixture?state=AddExistingApp        | Click **Add an app you shipped**             | 900    |

```sh
node docs/evidence/projects-join/capture.mjs Projects 1440
node docs/evidence/projects-join/capture.mjs Projects 700
node docs/evidence/projects-join/capture.mjs Live 1440
node docs/evidence/projects-join/capture.mjs Live 700
node docs/evidence/projects-join/capture.mjs LiveDark 1440
node docs/evidence/projects-join/capture.mjs LiveDark 700
node docs/evidence/projects-join/capture.mjs AppNoRepository 1440
node docs/evidence/projects-join/capture.mjs AppNoRepository 700
node docs/evidence/projects-join/capture.mjs AddRepository 1440
node docs/evidence/projects-join/capture.mjs AddRepository 700
node docs/evidence/projects-join/capture.mjs NewProjectExistingApp 1440
node docs/evidence/projects-join/capture.mjs NewProjectExistingApp 700
node docs/evidence/projects-join/capture.mjs ProjectEmpty 1440
node docs/evidence/projects-join/capture.mjs ProjectEmpty 700
node docs/evidence/projects-join/capture.mjs AddExistingApp 1440
node docs/evidence/projects-join/capture.mjs AddExistingApp 700
```

Each command writes `output/projects-join/<state>-<width>.png`, at 1× resolution. Height is read from the corresponding board metadata, with a minimum of 900; LiveDark uses Live's dimensions. The runner waits for loaded content, dialog data, fonts and transitions, and fails on page errors or HTTP errors. It logs the exact redirected URL, dimensions and visible text. It does not wait for network idle because the real app long-polls events. It never clicks a submit action.

Projects/Live seed home-gym (web and failing sync worker on SER), forma (web on SER, jobs on imac), tally (stopped), deploy.local (repository without an app), groffee (standalone folder app on imac), recipes (empty repository), immich, Vaultwarden and Miniflux (Discover), and kettle-timer (Done). There are eight running apps, one stopped app, one failure and one high-memory warning. The two computers are SER and imac.

Join states seed healthy pantry, shipped from a folder with no repository, and two releases including `c09ab12`. ProjectEmpty and AddExistingApp have an empty recipes repository with no linked apps. **Only AddExistingApp** also seeds a separate, unlinked recipes app: the approved chooser explicitly shows recipes first (same-name hint) and pantry second. NewProjectExistingApp uses the board's smaller home-gym/pantry background list; the other join states contain pantry and the empty recipes repository.

## Checks without a browser

No running server, listening socket, network connection or browser is needed for these commands:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 node --import tsx docs/evidence/projects-join/fixture-server.ts --check
node --check docs/evidence/projects-join/capture.mjs
```

`--check` exercises all eight reset redirects and JSON routes through the repository's in-process request/response harness. It verifies memberships, Discover exclusions, Done, health counts, the absence of pantry's repository, pantry's two releases, recipes' empty repository, same-name chooser eligibility, invalid states, blocked mutations and reset isolation. It also transforms the Vite entry and real page/dialog modules; dependency prebundling is disabled only for this no-listener check. Both checks and `node_modules/.bin/tsc --noEmit --pretty false` passed when this fixture was added.

## Board comparison (in the capturing environment)

Render approved references from `origin/main` (the renderer uses read-only Git commands):

```sh
node design/tools/render.mjs --main Projects Live AppNoRepository AddRepository NewProjectExistingApp ProjectEmpty AddExistingApp
for state in Projects Live AppNoRepository AddRepository NewProjectExistingApp ProjectEmpty AddExistingApp; do
  for width in 1440 700; do
    python3 design/tools/pair.py "output/projects-join/${state}-pair-${width}.png" "output/design-main/${state}-${width}.png" "output/projects-join/${state}-${width}.png"
  done
done
```

LiveDark is the same Live board with dark tokens; the standard board renderer does not offer a dark option. Produce a dark reference without modifying `design/` after the command above:

```sh
node --input-type=module <<'JS'
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const scratch = mkdtempSync(join(tmpdir(), 'projects-dark-board-'));
execFileSync('tar', ['-x', '-C', scratch], { input: execFileSync('git', ['archive', 'origin/main', 'design'], { maxBuffer: 1 << 30 }) });
const browser = await chromium.launch();
try {
  for (const width of [1440, 700]) {
    const page = await browser.newPage({ viewport: { width, height: 1160 }, colorScheme: 'dark' });
    await page.goto(pathToFileURL(resolve(scratch, 'design/boards/Live.html')).href);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `output/design-main/LiveDark-${width}.png` });
    await page.close();
  }
} finally { await browser.close(); rmSync(scratch, { recursive: true, force: true }); }
JS
for width in 1440 700; do
  python3 design/tools/pair.py "output/projects-join/LiveDark-pair-${width}.png" "output/design-main/LiveDark-${width}.png" "output/projects-join/LiveDark-${width}.png"
done
```

## Verification limits and expected differences

No browser was launched here. Screenshots, clicks, responsive layout, dark rendering and visual parity still need verification by the orchestrator. No product code or design files were changed. This fixture does not establish design approval or parity.

Source inspection already shows differences to record during review, rather than hide with fixture CSS or replacement UI:

- Projects currently renders app counts in place of the board's proposal/PR/last-change summaries; Done has no archive description. Standalone groffee follows stored repository projects in the real list order. The stopped runtime says `Stopped`, without an age.
- Pantry currently renders two metrics plus Runtime and Recent releases, whereas the board has a memory metric and Recent activity. Its overview lacks the board's uptime text.
- ProjectEmpty uses the current project header and composer defaults, rather than the board's Projects breadcrumb and explicit SER/Opus choices. The local model response contains no configured model.
- Repository addresses truthfully use `127.0.0.1:5180` (including HTTP push commands), rather than the board's `deploy.local` host.
- The sidebar has the real seeded agents and two computers, with no fabricated task history. Legacy boards include different sidebar history and a three-computer footer. Live's rollback attribution is currently “From deploy.local”; its board says “From Ops watcher.”
- Relative dates are anchored on each reset. Live's forma release is twelve hours old; its clock label varies with capture time. Board calendar labels and app-name casing can differ from the real project names.
