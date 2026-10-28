from shell import *
from b_overview import sheet, block

B = {}
HEIGHTS = []

# The terminal uses the dark theme's tokens, so the CLI and the app share one palette.
CSS = '''<style>
.t-win{border-radius:12px;overflow:hidden;background:var(--paper);color:var(--ink);box-shadow:0 0 0 1px rgba(0,0,0,.1),0 24px 48px -16px rgba(20,18,26,.35);display:flex;flex-direction:column;min-width:0}
.t-bar{height:34px;flex:none;display:flex;align-items:center;justify-content:center;position:relative;font-family:var(--font-sans);font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}
.t-bar .t-lights{position:absolute;left:12px;top:11px;display:flex;gap:7px}
.t-bar .t-lights span{width:11px;height:11px;border-radius:6px;background:#ff5f57}
.t-bar .t-lights span:nth-child(2){background:#febc2e}
.t-bar .t-lights span:nth-child(3){background:#28c840}
.t-body{margin:0;padding:14px 18px 18px;font-family:var(--font-mono);font-size:13px;line-height:20px;white-space:pre;overflow:hidden;color:var(--ink);flex:1}
.t-dim{color:var(--muted)}.t-ok{color:var(--success)}.t-fail{color:var(--danger)}.t-warn{color:var(--warning)}.t-run{color:var(--active)}.t-acc{color:var(--accent)}.t-b{font-weight:700}
.t-row{display:grid;gap:24px;align-items:start}
.t-cap{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
</style>'''

def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

D = lambda s: f'<span class="t-dim">{s}</span>'
OKc = lambda s='✓': f'<span class="t-ok">{s}</span>'
FA = lambda s='✗': f'<span class="t-fail">{s}</span>'
WA = lambda s='!': f'<span class="t-warn">{s}</span>'
RU = lambda s='⠋': f'<span class="t-run">{s}</span>'
BO = lambda s: f'<span class="t-b">{s}</span>'
AC = lambda s: f'<span class="t-acc">{s}</span>'
DOT = {'ok': OKc('●'), 'fail': FA('●'), 'warn': WA('●')}

def prompt(cmd, cwd='~/code/home-gym'):
    return f'{D(cwd)} {AC("$")} {cmd}'

def term(title, lines, height=None):
    h = f'height:{height}px;' if height else ''
    return (f'<div class="t-win" data-theme="dark" style="{h}"><div class="t-bar"><span class="t-lights"><span></span><span></span><span></span></span>{title}</div>'
            f'<pre class="t-body">{chr(10).join(lines)}</pre></div>')

def cap(title, sub):
    return f'<div class="t-cap"><span class="dl-strong" style="font-size:15px;line-height:24px">{title}</span><span class="dl-soft">{sub}</span></div>'

def board(kicker, title, sub, body, h):
    HEIGHTS.append(h)
    return CSS + sheet(1440, h, f'''<div class="dl-t" style="display:flex;flex-direction:column;gap:8px"><span class="dl-meta">CLI · {kicker}</span>
<h1 class="dl-title" style="font-size:40px;line-height:44px;letter-spacing:-.02em">{title}</h1>
<span class="dl-soft" style="font-size:15px;line-height:24px;max-width:820px">{sub}</span></div>{body}''')

def col(name, desc, w=22):
    return f'  {BO(esc(name.ljust(w)))} {D(esc(desc))}'

# ---------- Help ----------
help_lines = [
    prompt('deploy --help', '~'),
    f'{BO("deploy")} {D("— ship and run apps on computers you own")}',
    '',
    f'{D("Usage")}  deploy [command] [app] [flags]',
    '',
    f'{BO("Ship")}',
    col('deploy', 'Ship this folder to its project'),
    col('plan', 'Show what would change, without shipping'),
    col('rollback [app]', 'Move a whole project back to its last release'),
    col('releases [app]', 'List a project\'s releases'),
    '',
    f'{BO("Watch")}',
    col('status', 'What is running, what is failing, what needs you'),
    col('logs [app]', 'Stream logs  (--build for the last build)'),
    col('open [app]', 'Open the app in your browser'),
    col('ssh [app]', 'Open a shell inside the app'),
    '',
    f'{BO("Decide")}',
    col('inbox', 'Answer what is waiting on you'),
    '',
    f'{BO("Agents")}',
    col('task "<what to do>"', 'Start a task  (--on <computer>, --agent scout)'),
    col('tasks', 'Today\'s tasks and what they are doing'),
    '',
    f'{BO("Apps and computers")}',
    col('discover [search]', 'Browse apps you can install'),
    col('install <app>', 'Install an app from Discover'),
    col('computers', 'Computers and what each one is doing'),
    col('computer join', 'Make this computer a worker'),
    '',
    f'{BO("Account")}   login · logout · whoami · upgrade · version',
    '',
    f'{D("Flags")}    --json  machine output     -y, --yes  skip confirmations',
    f'         -u, --url  coordinator      -h, --help  help for any command',
    '',
    D('[app] defaults to the project in this folder.  More: deploy help advanced'),
]
before = [
    prompt('deploy --help', '~'),
    'deploy.local — self-hosted deployment platform',
    '',
    'Usage:',
    '  deploy server              Start the deploy.local server',
    '  deploy                     Deploy the current directory',
    '  deploy legacy &lt;action&gt;     status/update/recover/rollback -a…',
    '  deploy publish            Scoped CI source publish (--source-c…',
    '  deploy release head|status|wait  Scoped durable release receipt',
    '  deploy validate            Validate and summarize the local app…',
    '  deploy plan [-a &lt;name&gt;]    Compare the local graph with the se…',
    '  deploy list                List all deployments',
    '  deploy logs -a &lt;name&gt;      Stream logs from a deployment',
    '  deploy ssh &lt;name&gt;          Open an interactive shell in a dep…',
    '  deploy nodes enroll        Create enrollment (also in Dashboard…',
    '  deploy agent join &lt;url&gt;     Enroll this machine as an executio…',
    '  deploy catalog installations|status|upgrade|rollback|retry|un…',
    '  deploy component scale &lt;app&gt; &lt;component&gt; &lt;instances&gt; [--site…',
    '  deploy recovery create|verify|rehearse|restore|list',
    D('  … 21 more command lines'),
    '',
    'Options:',
    '  -a, --application &lt;name&gt;   Application name',
    '      --rebase               Rebase repository graph edits onto…',
    '      --recovery-point &lt;id&gt;  Catalog recovery point for upgrade/…',
    '      --confirm-data-loss    Confirm restoration of the pre-relea…',
    '      --no-cache             Build without using cached layers (…',
    D('  … 21 more options, all in one list'),
]
B['CliHelp.dc.html'] = ('cli', 'CLI — help that matches the app', board('help', 'Six groups, the app\'s words.',
    'Today\'s help has 36 command lines and 25 options in one list. It mixes -a with positional names, and none of tasks, agents, Live or Waiting on you appear. The new help groups commands by what you are doing and moves CI, recovery and graph internals to deploy help advanced.',
    f'''<div class="t-row" style="grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)">
  <div>{cap('Today', '36 command lines, 25 options, internal words (graph, component, site, suitcase)')}{term('zsh', before, 780)}</div>
  <div>{cap('Proposed', 'Grouped by intent; [app] defaults to this folder; flags live with their command')}{term('zsh', help_lines, 780)}</div>
</div>''', 1100))

# ---------- Ship ----------
ship_ok = [
    prompt('deploy'),
    f'{BO("home-gym")} {D("· 2 apps · release 4e7a2c1 → SER")}',
    '',
    f'  {OKc()} Packed 214 files              {D("1.2 MB · 0.4 s")}',
    f'  {OKc()} Prepared release              {D("pnpm build · 18.9 s")}',
    f'  {OKc()} Migration 0043 ready          {D("adds an index, renames nothing")}',
    f'  {OKc()} Verified on SER               {D("web GET /healthz 200 · sync heartbeat")}',
    f'  {RU()} Activating                    {D("web app ✓ · sync worker …")}',
    f'    {D("Warden watches for 10 minutes after this")}',
    '',
    f'{OKc()} {BO("Released 4e7a2c1 in 41 s")}',
    f'  https://home-gym.deploy.local',
    f'  {D("Next: deploy logs · deploy rollback")}',
]
ship_fail = [
    prompt('deploy'),
    f'{BO("home-gym")} {D("· 2 apps · release 9c3e1fa → SER")}',
    '',
    f'  {OKc()} Packed 214 files              {D("1.2 MB · 0.4 s")}',
    f'  {OKc()} Prepared release              {D("pnpm build · 19.2 s")}',
    f'  {OKc()} Migration 0042 applied        {D("on the verify copy only")}',
    f'  {FA()} Verify failed: sync worker exited',
    f'      {D("column")} "started" {D("does not exist")}',
    f'      {D("at readWorkouts (src/sync/workouts.ts:41)")}',
    '',
    f'{FA()} {BO("Nothing changed.")} SER is still on 81be0d2.',
    f'  {D("The web app passed; the worker reads the old column name.")}',
    f'  {D("Next: deploy logs --build · deploy task \"fix the sync worker\"")}',
]
B['CliDeploy.dc.html'] = ('cli', 'CLI — shipping shows steps, not a log dump', board('deploy', 'Steps, not a log dump.',
    'Today deploy streams every build line, then prints "Deployment accepted" and a dashboard link. The new output shows the same steps as a release in the app: prepare, verify, activate, watch. Build output stays behind deploy logs --build, and only the lines that matter appear when something fails.',
    f'''<div class="t-row" style="grid-template-columns:repeat(2,minmax(0,1fr))">
  <div>{cap('A release that ships', 'One line per step; the last line is the result, the address and what to do next')}{term('home-gym — zsh', ship_ok, 360)}</div>
  <div>{cap('A release that fails verification', 'Verify runs both apps before the switch, so the bad worker never reaches users')}{term('home-gym — zsh', ship_fail, 360)}</div>
</div>''', 700))

# ---------- Status and inbox ----------
status_lines = [
    prompt('deploy status', '~'),
    f'{BO("SER")} {D("online")} · 7 running · {FA("1 failing")} · {WA("3 waiting on you")}',
    '',
    f'{BO("SER")}      {D("coordinator · CPU 14% · memory 38%")}',
    f'  {DOT["fail"]} home-gym sync   {FA("Failing")}      {D("38% of jobs error since 1:58 PM")}',
    f'  {DOT["warn"]} Immich          {WA("High memory")}  {D("92% of 4 GB")}',
    f'  {DOT["ok"]} home-gym        Healthy      {D("12 req/min")}',
    f'  {DOT["ok"]} deploy.local    Healthy      {D("184 req/min")}',
    f'{BO("bazzite")}  {D("task worker · CPU 22% · memory 51%")}',
    f'  {DOT["ok"]} Vaultwarden     Healthy      {D("1 req/min")}',
    f'  {DOT["ok"]} Miniflux        Healthy      {D("2 req/min")}',
    f'  {DOT["ok"]} Miniflux fetch… Healthy      {D("queue empty")}',
    '',
    f'{WA()} 3 waiting on you        {D("deploy inbox")}',
    f'{RU()} 2 tasks running         {D("deploy tasks")}',
]
inbox_lines = [
    prompt('deploy inbox', '~'),
    f'{WA()} {BO("Roll back home-gym to 81be0d2?")}            {D("Warden · now")}',
    f'  {D("home-gym sync fails 38% of jobs since 1:58 PM. Both")}',
    f'  {D("apps go back and migration 0042 is undone.")}',
    f'  {AC("›")} [r] Roll back  [d] Details  [s] Skip  [q] Quit   {BO("r")}',
    '',
    f'  {OKc()} Undid migration 0042            {D("3 s")}',
    f'  {OKc()} home-gym web app → 81be0d2      {D("GET /healthz 200")}',
    f'  {OKc()} home-gym sync → 81be0d2         {D("heartbeat ok")}',
    f'  {OKc()} Retried 1,240 queued jobs       {D("0 failed")}',
    f'{OKc()} Rolled back home-gym in 41 s. {D("Warden is watching.")}',
    '',
    f'{WA()} {BO("Merge PR #18?")}                             {D("Scout · 4m")}',
    f'  {D("Reviewed by GPT-6.1-Sol. 4 checks passed.")}',
    f'  {AC("›")} [m] Merge and release  [o] Open  [s] Skip  [q] Quit',
]
B['CliStatus.dc.html'] = ('cli', 'CLI — status and the inbox', board('status and inbox', 'The tray, in a terminal.',
    'deploy list printed names and a bracketed status. deploy status reads like Live: grouped by computer, health in plain words, then what needs you. deploy inbox answers the same Waiting on you items as the app, the menu bar and iPhone; answering here answers everywhere.',
    f'''<div class="t-row" style="grid-template-columns:repeat(2,minmax(0,1fr))">
  <div>{cap('deploy status', 'Exit code 3 while anything is waiting on you, so scripts can check')}{term('zsh', status_lines, 380)}</div>
  <div>{cap('deploy inbox', 'One decision at a time, with the same actions as the card in the app')}{term('zsh', inbox_lines, 380)}</div>
</div>''', 740))

# ---------- Errors ----------
err_lines = [
    prompt('deploy stauts', '~'),
    f'{FA()} Unknown command "stauts". Did you mean {BO("status")}?',
    '',
    prompt('deploy logs', '~'),
    f'{FA()} Which app? This folder is not a project.',
    f'  {D("Try: deploy logs home-gym, or run it in the project folder")}',
    '',
    prompt('deploy'),
    f'{FA()} Can\'t reach SER at https://deploy.local',
    f'  {D("It stopped answering at 2:41 PM. Nothing was uploaded.")}',
    f'  {D("Check its power and network, then: deploy status")}',
    '',
    prompt('deploy'),
    f'{FA()} You\'re signed out.',
    f'  {D("Run deploy login. It offers to create an account if you need one.")}',
]
confirm_lines = [
    prompt('deploy rollback'),
    f'{BO("home-gym")} {D("· 9c3e1fa → 81be0d2 (9 days without errors)")}',
    f'  home-gym web app   {D("9c3e1fa → 81be0d2")}',
    f'  home-gym sync      {D("9c3e1fa → 81be0d2")}',
    f'  {WA("Migration 0042")}     {D("undone: started_at back to started")}',
    f'{WA()} Roll back home-gym? {D("[y/N]")} ',
    '',
    prompt('deploy status --json | jq -r \'.failing[].name\'', '~'),
    'home-gym sync',
    '',
    prompt('NO_COLOR=1 deploy status > status.txt', '~'),
    D('# plain text, no color or spinners when piped'),
]
B['CliErrors.dc.html'] = ('cli', 'CLI — errors and scripting', board('errors and scripting', 'What happened, and the next command.',
    'Every error names what happened, what deploy.local did or did not do, and one command to run next. Anything that changes data asks first and shows exactly what changes; --yes skips the question in scripts.',
    f'''<div class="t-row" style="grid-template-columns:repeat(2,minmax(0,1fr))">
  <div>{cap('Errors', 'No stack traces; raw detail lives in deploy logs')}{term('zsh', err_lines, 360)}</div>
  <div>{cap('Confirmations and scripting', '--json on every command; no color when piped or with NO_COLOR')}{term('zsh', confirm_lines, 360)}</div>
</div>''', 660))

# ---------- Rules ----------
rules = [
    ('The app\'s words', 'Projects, apps, Live, computers, tasks, Waiting on you. Never graph, component, site or suitcase outside deploy help advanced.'),
    ('[app] is positional', 'It defaults to the project in this folder. -a still works so old scripts keep running.'),
    ('Steps, not logs', 'One line per step with ✓ ✗ ⠋. Raw output stays in deploy logs; failures show only the lines that explain them.'),
    ('End with the next command', 'Every run ends with what happened and what to run next: an address, deploy logs, deploy inbox.'),
    ('Ask before changing data', 'Rollbacks, removals and migrations list exactly what changes and ask [y/N]. --yes is for scripts.'),
    ('Scriptable', '--json on every command, no color when piped or with NO_COLOR. Exit 0 ok, 1 failed, 2 usage, 3 waiting on you.'),
]
rule_cards = ''.join(f'<div class="dl-group" style="padding:16px;display:flex;flex-direction:column;gap:6px"><span class="dl-meta">{n + 1:02d}</span><span class="dl-strong" style="font-size:15px;line-height:24px">{t}</span><span class="dl-soft">{d}</span></div>' for n, (t, d) in enumerate(rules))
glyphs = [('✓', 'ok', 'Done', 'success'), ('✗', 'fail', 'Failed', 'danger'), ('!', 'warn', 'Waiting on you', 'warning'), ('⠋', 'run', 'Running', 'active'), ('●', 'ok', 'App health (dot color)', 'success'), ('dim', 'dim', 'Secondary detail', 'muted')]
glyph_rows = ''.join(f'<div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)"><span data-theme="dark" style="width:44px;height:28px;border-radius:6px;background:var(--paper);display:inline-flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:13px" class="t-{k}">{g}</span><span>{lab}</span><span class="dl-meta dl-mono" style="margin-left:auto">{tok}</span></div>' for g, k, lab, tok in glyphs)
mapping = [('deploy list', 'deploy status'), ('deploy logs -a home-gym', 'deploy logs home-gym'), ('deploy nodes enroll · agent join · agent install', 'deploy computer join'),
           ('deploy agent status', 'deploy computer status'), ('deploy catalog list · inspect · install', 'deploy discover · deploy install'),
           ('deploy legacy rollback · catalog rollback', 'deploy rollback (the whole project)'), ('deploy delete -a home-gym', 'deploy remove home-gym (asks first)'),
           ('deploy register', 'deploy login (offers to create an account)'), ('publish · release · component · recovery · validate · schema · files · legacy · server', 'deploy help advanced'),
           ('(missing)', 'deploy inbox · task · tasks · computers · releases')]
TD = 'class="dl-mono" style="white-space:normal;height:auto;padding:8px 16px;font-size:12px;line-height:18px"'
map_rows = ''.join(f'<tr><td {TD}>{a}</td><td {TD}>{b}</td></tr>' for a, b in mapping)
B['CliRules.dc.html'] = ('cli', 'CLI — rules, glyphs and the command map', CSS + sheet(1440, 1100, f'''
<div class="dl-t" style="display:flex;flex-direction:column;gap:8px"><span class="dl-meta">CLI · design rules</span><h1 class="dl-title" style="font-size:40px;line-height:44px;letter-spacing:-.02em">The same product, in a terminal.</h1>
<span class="dl-soft" style="font-size:15px;line-height:24px;max-width:820px">The CLI follows the app's vocabulary, status rules and palette (the dark theme's tokens). Six rules keep it from drifting again.</span></div>
<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px">{rule_cards}</div>
<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:48px">
  {block('Glyphs and color', 'Same meaning as the app. The ! glyph only for decisions.', glyph_rows)}
  {block('Old to new', 'Old commands keep working for one release and print the new name.', f'<div class="dl-table-wrap dl-group"><table class="dl-table" style="table-layout:fixed"><thead><tr><th>Today</th><th>Proposed</th></tr></thead><tbody>{map_rows}</tbody></table></div>')}
</div>'''), 1440, 1100)

for f, h in zip(['CliHelp.dc.html', 'CliDeploy.dc.html', 'CliStatus.dc.html', 'CliErrors.dc.html'], HEIGHTS):
    B[f] = B[f] + (1440, h)
