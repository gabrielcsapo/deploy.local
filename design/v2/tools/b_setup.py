from shell import *
from b_desktop import CSS as DK_CSS, menubar, tray, LIGHTS
from b_compute import settings
import b_cli

B = {}
FOLDER = '<span class="dl-glyph plain">' + i('folder', 12) + '</span>'
APPG = '<span class="dl-glyph plain">' + i('app', 12) + '</span>'
LOCK = '<span class="dl-glyph plain">' + i('key', 12) + '</span>'
FRESH = dict(inbox=[], today=[], live='<span class="dl-c">Nothing running</span>', fresh=True)
SG, WG = S_GLYPH, W_GLYPH
RADIO_ON = '<span style="width:16px;height:16px;flex:none;box-sizing:border-box;border-radius:8px;border:5px solid var(--action)" aria-hidden="true"></span>'

def field(fid, label, value='', placeholder='', hint='', end='', mono=False, kind='text'):
    v = f' value="{value}"' if value else ''
    p = f' placeholder="{placeholder}"' if placeholder else ''
    st = ' style="font-family:var(--font-mono);font-size:12px"' if mono else ''
    h = f'<p class="dl-meta" style="margin:6px 0 0">{hint}</p>' if hint else ''
    return f'<div><label class="dl-field-label" for="{fid}">{label}</label><label class="dl-field"><input id="{fid}" type="{kind}"{v}{p}{st}>{end}</label>{h}</div>'

def pick(fid, label, value, hint=''):
    return field(fid, label, value, end=i('chev', 14), hint=hint)

def wizard(step, title, sub, body, actions, steps=('Sign in', 'This computer', 'Permissions')):
    marks = []
    for n, s in enumerate(steps):
        if n < step:
            marks.append(f'<span style="display:inline-flex;align-items:center;gap:6px">{OK()}{s}</span>')
        elif n == step:
            marks.append(f'<b>{s}</b>')
        else:
            marks.append(f'<span>{s}</span>')
    bar = '<div class="dk-steps">' + '<span class="dk-line"></span>'.join(marks) + '</div>'
    return f'''<div style="max-width:520px;margin:0 auto;padding:28px 24px 32px;display:flex;flex-direction:column;gap:20px">
  {bar}
  <div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">{title}</h1><span class="dl-soft">{sub}</span></div>
  {body}
  <div style="display:flex;justify-content:flex-end;gap:8px">{actions}</div>
</div>'''

# ---------- 1. Getting started ----------
# Setup step 1 in the desktop app: find SER, check its certificate, then sign in.
found = group([item('SER', 'deploy.local · 192.168.1.20 · found on this network', '<span class="dl-glyph plain">' + i('compute', 12) + '</span>', status('', 'Answering'))])
cert = f'''<div class="dl-approval" style="box-shadow:none"><div class="dl-approval-head">{i('shield', 18)}<div class="dl-t"><p class="dl-approval-title">Trust SER's certificate?</p>
<p class="dl-approval-text">SER signs its own certificate. Check that these characters match the ones on SER's screen, or run <code class="dl-code-inline">deploy status --fingerprint</code> on SER.</p>
<div class="dl-well" style="font-size:13px">4F:A2:19:C7:0B:E3 · 88:D1:5E:42:9C:07</div></div></div>
<div class="dl-approval-answer">{i('check', 14, 2)}<span>They match · trusted for deploy.local only</span></div></div>'''
signin = f'''<div style="display:flex;flex-direction:column;gap:12px">
  {field('user', 'Username', 'gabriel')}
  {field('pass', 'Password', placeholder='Your deploy.local password', kind='password')}
</div>'''
B['SignIn.dc.html'] = ('desktop', 'Setup step 1: find SER, trust its certificate, sign in', f'''{DK_CSS}<div class="dk-desk dl-sheet">
{menubar('deploy.local', '')}
<div class="dk-win" style="left:50%;top:56px;transform:translateX(-50%);width:720px">
  <div class="dk-title" style="border-bottom:0">{LIGHTS.replace('top:18px', 'top:14px')}</div>
  {wizard(0, 'Sign in to deploy.local', 'deploy.local runs on one of your computers. This app found it on your network.', found + cert + signin,
          btn('Use another address', 'quiet') + btn('Sign in', 'primary'))}
</div>
</div>''')

# A brand-new install: one computer, nothing running, a short checklist.
check_rows = group([
    item('Add a project', 'A repository and the apps it runs. Scout writes the deploy file for you.', '<span class="dl-glyph plain">1</span>', btn('New project', 'primary', 'NewProject.dc.html')),
    item('Or install an app', 'Immich, Vaultwarden, Miniflux and more, on your own computer', '<span class="dl-glyph plain">2</span>', btn('Discover apps', href='InstallApp.dc.html')),
    item('Add another computer', 'Optional. Install the app on a laptop or desktop and it can take tasks', '<span class="dl-glyph plain">3</span>', btn('Add a computer', 'quiet', 'Setup.dc.html'))])
B['Welcome.dc.html'] = ('work', 'A brand-new install: one computer, nothing running', app('new', f'''
{head('', '', '')}
<div class="dl-scroll" style="display:flex;flex-direction:column;justify-content:center">
  <div class="dl-col" style="padding-bottom:64px;display:flex;flex-direction:column;gap:24px">
    <div class="dl-greeting"><span class="dl-mark" style="width:40px;height:40px;border-radius:12px;font-size:17px">d</span>
      <h1 class="dl-title">Welcome to deploy.local</h1>
      <span class="dl-soft">SER is running and ready. Start with a project or an app; Scout and Warden begin once there is something to work on.</span></div>
    {check_rows}
    <div class="dl-dock" style="padding:0">{composer(chip('Any free computer', 'compute'), fid='welcome-msg', placeholder='Or ask: set up git@github.com:me/app.git')[len('<div class="dl-dock">'):-len('</div>')]}</div>
  </div>
</div>''', **FRESH))

# New project from a repository: deploy.local reads it and proposes the apps.
detected = group([
    item('home-gym', 'Web app · vite build · serves port 3000', APPG, c('Found')),
    item('home-gym sync', 'Worker · node dist/sync.js · no port', APPG, c('Found')),
    item('Postgres 17', 'From docker-compose.yml · data kept on SER', '<span class="dl-glyph plain">' + i('chip', 12) + '</span>', c('Found'))])
empty_projects = app('projects', f'''
{head('Projects', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page">
  {page_head('Projects', 'Repositories, and apps installed from Discover')}
  {group([f'<div class="dl-empty"><span class="dl-glyph">{i("folder", 20)}</span><h3>No projects yet</h3><p>A project is a repository and the apps it runs. Start from code you have, or install an app.</p><div class="dl-actions">{btn("New project", "primary")}{btn("Discover apps")}</div></div>'])}
</div></div>''', **FRESH)
B['NewProject.dc.html'] = ('projects', 'New project: deploy.local reads the repository and proposes its apps', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{empty_projects}
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="New project" style="max-width:560px">
  <div class="dl-dialog-head"><h2>New project</h2>{ib('x', 'Close')}</div>
  <div class="dl-seg" style="align-self:flex-start"><a class="on">From a repository</a><a>From a folder</a><a>Empty</a></div>
  {field('repo', 'Repository', 'git@github.com:gabriel/home-gym.git', end=OK(), mono=True, hint='Read with the SSH key from this Mac. Nothing runs until you create the project.')}
  <div><span class="dl-field-label">Found in the repository</span>{detected}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">{pick('pc', 'Runs on', 'SER')}{field('dom', 'Address', 'home-gym.deploy.local', end=OK())}</div>
  <div class="dl-setting" style="padding:0;border:0"><span class="dl-t"><span>Scout opens the first pull request</span><span>It adds deploy.yaml with what was found above, for you to review</span></span><span class="dl-v">{sw('Scout PR')}</span></div>
  <div class="dl-dialog-foot">{btn('Cancel', 'quiet')}{btn('Create project', 'primary')}</div>
</div></div></div>''')

# Install from Discover: where, address, storage, version. Nothing about images or ports.
B['InstallApp.dc.html'] = ('projects', 'Install from Discover: where, address and storage', app('projects', f'''
{head('Discover', 'Immich', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page" style="max-width:768px">
  <div class="dl-page-head"><div class="dl-t" style="flex-direction:row;align-items:center;gap:12px"><span class="dl-glyph lg" style="width:40px;height:40px;border-radius:12px;font-size:17px">I</span>
    <span style="display:flex;flex-direction:column"><h1 class="dl-title">Install Immich</h1><span class="dl-meta">Photo and video backup · v1.123.0 · published image, no code to change</span></span></div></div>
  {section('Where it runs', 'Other computers appear here once you add them.', group([item('SER', 'Coordinator · 3.1 GB memory free · 1.2 TB disk free', RADIO_ON, '<span class="dl-tag">Only computer</span>')]))}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    {field('addr', 'Address', 'photos.deploy.local', end=OK(), hint='Available. Gets a certificate from SER.')}
    {pick('mem', 'Memory limit', '4 GB', hint='Immich suggests 4 GB or more.')}
  </div>
  {section('Your photos', 'Kept outside the app, so updates and reinstalls never touch them.', group([f'<div class="dl-inset">{setting("Folder on SER", "", "<span class=\"dl-mono\">/srv/immich</span>")}{setting("Back up nightly", "To the Home recovery bundle on SER", sw("Backup"))}</div>']))}
  {section('First account', 'Immich asks for an admin on first open. deploy.local does not create accounts inside apps.', '')}
  <div style="display:flex;justify-content:flex-end;gap:8px">{btn('Cancel', 'quiet')}{btn('Install Immich', 'primary')}</div>
</div></div>''', **FRESH))

# deploy login and the first deploy from a folder.
T = b_cli
login_lines = [
    T.prompt('deploy login', '~'),
    f'Looking for deploy.local on this network… {T.OKc("found SER")} {T.D("(192.168.1.20)")}',
    '',
    f'{T.WA()} SER signs its own certificate. Check it matches SER\'s screen:',
    f'  {T.BO("4F:A2:19:C7:0B:E3 · 88:D1:5E:42:9C:07")}',
    f'  Trust it for deploy.local? {T.D("[y/N]")} {T.BO("y")}',
    '',
    f'Sign in in your browser: {T.AC("https://deploy.local/device")}',
    f'  Code {T.BO("KQ2M-9XDF")}   {T.D("waiting…")}',
    f'{T.OKc()} Signed in as {T.BO("gabriel")} on SER',
    f'  {T.D("No account yet? The browser page creates one.")}',
    f'  {T.D("Next: deploy (in a project folder) · deploy status")}',
]
first_lines = [
    T.prompt('deploy'),
    f'This folder isn\'t a project yet. Found:',
    f'  {T.OKc("●")} home-gym        {T.D("web app · vite build · port 3000")}',
    f'  {T.OKc("●")} home-gym sync   {T.D("worker · node dist/sync.js")}',
    f'  {T.OKc("●")} Postgres 17     {T.D("from docker-compose.yml")}',
    f'Create {T.BO("home-gym")} on SER at home-gym.deploy.local? {T.D("[Y/n]")} {T.BO("y")}',
    '',
    f'  {T.OKc()} Wrote deploy.yaml           {T.D("review it, then commit")}',
    f'  {T.OKc()} Created project home-gym',
    f'  {T.RU()} Preparing release           {T.D("pnpm build")}',
]
B['CliLogin.dc.html'] = ('cli', 'CLI — signing in and the first deploy', b_cli.board('getting started', 'Signed in, then shipped, in one sitting.',
    'deploy login finds SER on the network, checks its certificate the same way the desktop app does, and signs in through the browser so no password is typed into a terminal. The first deploy in a folder proposes a project instead of failing.',
    f'''<div class="t-row" style="grid-template-columns:repeat(2,minmax(0,1fr))">
  <div>{b_cli.cap('deploy login', 'Browser sign-in with a code; the terminal never sees a password')}{b_cli.term('zsh', login_lines, 330)}</div>
  <div>{b_cli.cap('The first deploy', 'Reads the folder, proposes the apps, writes deploy.yaml for review')}{b_cli.term('home-gym — zsh', first_lines, 330)}</div>
</div>''', 680), 1440, 680)

# ---------- 2. App settings and secrets ----------
APP_TABS = [('overview', 'Overview', '#', ''), ('settings', 'Settings', 'AppSettings.dc.html', '')]
def var_row(name, value, used, end, secret=False):
    v = f'<span class="dl-mono">{value}</span>'
    lead = LOCK if secret else '<span class="dl-glyph plain">' + i('terminal', 12) + '</span>'
    return item(f'<span class="dl-mono">{name}</span>', f'{v} · {used}', lead, end)
env = group([
    var_row('NODE_ENV', 'production', 'both apps', btn('Edit', 'quiet')),
    var_row('DATABASE_URL', '••••••••', 'secret · both apps · set 9 days ago', btn('Replace', 'quiet'), True),
    var_row('STRAVA_CLIENT_ID', '48120', 'sync worker only', btn('Edit', 'quiet')),
    var_row('STRAVA_CLIENT_SECRET', '••••••••', 'secret · sync worker only · set today', btn('Replace', 'quiet'), True)],
    '2 variables · 2 secrets', btn('Add', 'quiet', 'SecretEdit.dc.html'))
def app_settings():
    return app('projects', f'''
{head('home-gym', 'Web app in home-gym', ib('search', 'Search') + ib('more', 'More'), APPG)}
<div class="dl-scroll"><div class="dl-page" style="padding-top:8px">
  {tabs(APP_TABS, 'settings')}
  <div class="dl-notice">{i('key', 16)}<span>Variables, secrets, releases and logs belong to the project, so both home-gym apps share them.</span><span class="dl-end">{btn('Project settings', 'quiet', 'ProjectSettings.dc.html')}</span></div>
  {section('Address', '', group([f'<div class="dl-inset">{setting("home-gym.deploy.local", "Primary · certificate from SER, renews itself", status("", "Active"))}{setting("gym.example.com", "Waiting for its DNS record to point at SER", status("attention", "Checking"))}</div>'], 'Domains', btn('Add domain', 'quiet')))}
  {section('Health and resources', '', group([f'<div class="dl-inset">{setting("Health check", "Failing after 3 misses in a row", "<span class=\"dl-mono\">GET /healthz</span> every 10 s")}{setting("Memory limit", "Using 380 MB of 1 GB", btn("1 GB", "secondary"))}{setting("Runs on", "Moving it keeps its data and address", btn("SER", "secondary"))}</div>']))}
  {section('Remove', '', group([f'<div class="dl-inset">{setting("Remove the web app", "Stops it and frees its address. Data, releases and the repository stay.", btn("Remove app", "danger"))}</div>']))}
</div></div>''')
B['AppSettings.dc.html'] = ('projects', 'App settings: address, health and limits (the rest is the project\'s)', app_settings(), 1440, 1000)

# Project settings: variables and secrets, the repository, and how releases happen.
from b_projects import project
def project_settings():
    return project('settings', f'''
  {section('Variables and secrets', 'Shared by the project\'s apps; limit one to a single app when only it needs it. Secrets are encrypted on SER, and agents never see their values.', env)}
  {section('Repository', '', group([f'<div class="dl-inset">{setting("Source", "", "<span class=\"dl-mono\">git@github.com:gabriel/home-gym.git</span>")}{setting("Releases from", "Merges to this branch become releases", "<span class=\"dl-mono\">main</span>")}{setting("Deploy file", "Written by Scout in PR #1", "<span class=\"dl-mono\">deploy.yaml</span>")}</div>']))}
  {section('Releases', 'One release covers every app in the project, and its migrations.', group([f'<div class="dl-inset">{setting("Release after a merge", "Who decides is in Agents and approvals", "<span class=\"dl-tag\">Ask me</span>")}{setting("Keep earlier releases", "For instant rollback", btn("5", "secondary"))}{setting("Verify migrations", "Run them on a copy of the data before switching", sw("Verify migrations"))}</div>']))}
  {section('Remove', '', group([f'<div class="dl-inset">{setting("Remove home-gym", "Stops both apps and frees their addresses. Backups stay for 30 days.", btn("Remove project", "danger"))}</div>']))}
''', name='home-gym')
B['ProjectSettings.dc.html'] = ('projects', 'Project settings: variables, secrets, repository and releases', project_settings(), 1440, 1160)

B['SecretEdit.dc.html'] = ('projects', 'Adding a secret: encrypted on SER, never shown to agents', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{project_settings()}
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="Add a secret">
  <div class="dl-dialog-head"><h2>Add a secret</h2>{ib('x', 'Close')}</div>
  {field('sname', 'Name', 'STRAVA_CLIENT_SECRET', mono=True)}
  {field('sval', 'Value', 'not-a-real-value', kind='password', end=ib('eye', 'Show value'))}
  <div><span class="dl-field-label">Available to</span>{group([f'<div class="dl-inset">{setting("home-gym", "Web app", sw("Web app", False))}{setting("home-gym sync", "Worker", sw("Sync worker"))}</div>'])}</div>
  <div class="dl-notice">{i('shield', 16)}<span>Encrypted on SER and given to the app only when it starts. Agents see the name, never the value, and it is never sent to Claude or Codex.</span></div>
  <div class="dl-dialog-foot">{btn('Cancel', 'quiet')}{btn('Save, apply on next release')}{btn('Save and restart', 'primary')}</div>
</div></div></div>''')

# ---------- 3. Approval rules and per-agent trust ----------
ASK = '<span class="dl-tag">Ask me</span>'
ALLOW = '<span class="dl-tag" style="background:color-mix(in srgb,var(--success) 14%,transparent);color:var(--success)">Allowed</span>'
NEVER = '<span class="dl-tag" style="background:transparent;box-shadow:inset 0 0 0 1px var(--line-strong)">Never</span>'
meta = lambda w: f'<span class="dl-meta">{w}</span>' if w else ''
TD = 'style="white-space:normal;height:auto;padding:10px 16px"'
rules = [('Start a task', 'On any free computer', ALLOW, NEVER), ('Open a pull request', '', ALLOW, NEVER), ('Merge a pull request', 'After review by a second model', ASK, NEVER),
         ('Restart an app', 'When it stops answering for 2 minutes', NEVER, '<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">' + ALLOW + '<a href="RuleEdit.dc.html" class="dl-link" style="font-size:12px">Edit</a></span>'),
         ('Roll back a release', 'When health checks fail after a release', NEVER, ASK)]
rule_rows = ''.join(f'<tr><td {TD}><span style="display:flex;flex-direction:column"><span class="dl-strong" style="font-weight:500">{a}</span>{meta(w)}</span></td><td {TD}>{s}</td><td {TD}>{wv}</td></tr>' for a, w, s, wv in rules)
# Small screens get one group per agent instead of a table that would squeeze.
def matrix_stack(agents):
    return '<div class="dl-matrix-stack">' + ''.join(
        group([item(a, w, '', v) for (a, w, *_), v in zip(rules, vals)], f'<span style="display:inline-flex;align-items:center;gap:6px">{g}{n}</span>')
        for g, n, vals in agents) + '</div>'
matrix = (f'<div class="dl-matrix-table dl-table-wrap dl-group"><table class="dl-table" style="table-layout:fixed"><thead><tr><th>Action</th>'
          f'<th style="width:104px"><span style="display:inline-flex;align-items:center;gap:6px">{SG}Scout</span></th><th style="width:136px"><span style="display:inline-flex;align-items:center;gap:6px">{WG}Warden</span></th></tr></thead><tbody>{rule_rows}</tbody></table></div>') + matrix_stack([(SG, 'Scout', [r[2] for r in rules]), (WG, 'Warden', [r[3] for r in rules])])
suggest = approval(WG.replace('dl-glyph', 'dl-glyph lg'), 'Let Warden roll back without asking?',
    'You approved all 4 of Warden\'s rollbacks in the last 30 days, each within 20 minutes. It would still tell you right after, in its conversation.',
    btn('Allow for failed health checks', 'primary') + btn('Keep asking') + btn('Not now', 'quiet'))
always = group([f'<div class="dl-inset">{setting("Use the screen", "Asked per task, for one app at a time", "<span class=\"dl-tag\">Always asks</span>")}{setting("Delete data or remove an app", "", "<span class=\"dl-tag\">Always asks</span>")}{setting("Read or change secrets", "Agents never see secret values", NEVER)}{setting("Start a release", "Press Ship… or merge a pull request yourself", "<span class=\"dl-tag\">Only you</span>")}</div>'])
B['SettingsAgents.dc.html'] = ('settings', 'Approvals: what each agent may do without asking', settings('agents', f'''
{section('What agents may do', 'Each agent starts by asking. Trust grows one action at a time, and every answer is in Waiting on you › Answered.', matrix)}
{section('Suggested from your answers', '', suggest)}
{section('Always yours', 'These stay with you no matter how much you trust an agent.', always)}
{section('Agents', '', group([item('Scout', 'Dev loop · deploy.local · morning brief at 7:00', SG, btn('Tune', 'quiet', 'Configure.dc.html')), item('Warden', 'Ops · all apps and computers · checks every minute', WG, btn('Tune', 'quiet'))]))}'''), 1440, 1260)

rule_body = f'''<div style="display:flex;flex-direction:column;gap:14px">
  <div class="dl-scope" style="margin-top:0">
    <div><span class="dl-k">Agent</span><span style="display:inline-flex;align-items:center;gap:6px">{WG}Warden</span></div>
    <div><span class="dl-k">May</span><span>Restart an app</span></div>
  </div>
  {pick('when', 'When', 'It stops answering for 2 minutes')}
  {pick('which', 'Which apps', 'All apps, except deploy.local')}
  {pick('limit', 'At most', '3 times an hour, then ask me')}
  {pick('tell', 'Tell me', 'Afterwards, in Warden\'s conversation (no notification)')}
  <span class="dl-meta">Used 4 times in 30 days · last: Vaultwarden at 6:12 AM, healthy after</span>
</div>'''
B['RuleEdit.dc.html'] = ('settings', 'A rule: when, which apps, how often, and how you hear about it', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{settings('agents', section('What agents may do', '', matrix))}
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="Edit rule">
  <div class="dl-dialog-head"><h2>Warden may restart an app</h2>{ib('x', 'Close')}</div>
  {rule_body}
  <div class="dl-dialog-foot" style="justify-content:space-between">{btn('Back to asking', 'quiet')}<span style="display:flex;gap:8px">{btn('Cancel')}{btn('Save rule', 'primary')}</span></div>
</div></div></div>''')
