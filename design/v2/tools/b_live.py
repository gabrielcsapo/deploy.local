from shell import *

B = {}
FOLDER = '<span class="dl-glyph plain">' + i('folder', 12) + '</span>'
APPG = '<span class="dl-glyph plain">' + i('app', 12) + '</span>'
PCG = '<span class="dl-glyph plain">' + i('compute', 12) + '</span>'
W_LG = W_GLYPH.replace('dl-glyph', 'dl-glyph lg')

# Health is one status plus the reason in plain words. Web apps answer an HTTP check;
# workers have no address, so their health is process, heartbeat, failure rate and queue age.
def health(tone, label, why):
    return f'<span style="display:flex;flex-direction:column;gap:2px">{status(tone, label)}<span class="dl-meta">{why}</span></span>'

def traffic(value, sub):
    return f'<span style="display:flex;flex-direction:column"><span>{value}</span><span class="dl-meta">{sub}</span></span>'

# A release belongs to the project, so both home-gym apps show the same one.
SER = [
    ('home-gym sync', 'Worker · home-gym', health('failed', 'Failing', '38% of jobs error since 1:58 PM'), traffic('9 jobs/min', '1,240 queued'), '9c3e1fa', '34m', 'Worker.dc.html'),
    ('Immich', 'photos.deploy.local · from Discover', health('attention', 'High memory', '92% of 4 GB for 20 min'), traffic('3 req/min', 'p95 210 ms'), 'v1.122.3', '4d', 'ImmichApp.dc.html'),
    ('home-gym', 'Web app · home-gym.deploy.local', health('', 'Healthy', 'GET /healthz 200'), traffic('12 req/min', 'p95 38 ms'), '9c3e1fa', '34m', 'App.dc.html'),
    ('deploy.local', 'deploy.local', health('', 'Healthy', 'GET /healthz 200'), traffic('184 req/min', 'p95 42 ms'), '2a91c0e', '6h', 'App.dc.html'),
]
BAZZITE = [
    ('Vaultwarden', 'vault.deploy.local · from Discover', health('', 'Healthy', 'GET /alive 200'), traffic('1 req/min', 'p95 25 ms'), '1.32.0', '9d', 'ImmichApp.dc.html'),
    ('Miniflux', 'feeds.deploy.local · from Discover', health('', 'Healthy', 'GET /healthcheck 200'), traffic('2 req/min', 'p95 31 ms'), '2.2.3', '12d', 'ImmichApp.dc.html'),
    ('Miniflux fetcher', 'Worker · Miniflux', health('', 'Healthy', 'Heartbeat 3 s ago'), traffic('14 jobs/min', 'Queue empty'), '2.2.3', '12d', 'ImmichApp.dc.html'),
]

def table(rows):
    body = ''.join(f'''<tr>
  <td class="dl-name"><a href="{href}" style="display:flex;flex-direction:column"><span>{n}</span><span class="dl-meta dl-truncate" style="font-weight:400">{sub}</span></a></td>
  <td style="white-space:normal">{h}</td>
  <td class="dl-hide-narrow">{tr}</td>
  <td class="dl-hide-mid"><span class="dl-mono">{rel}</span> <span class="dl-meta">{ago}</span></td>
</tr>''' for n, sub, h, tr, rel, ago, href in rows)
    return (f'<div class="dl-table-wrap"><table class="dl-table" style="table-layout:fixed"><thead><tr><th style="width:32%">App</th><th style="width:34%">Health</th>'
            f'<th class="dl-hide-narrow" style="width:18%">Traffic</th><th class="dl-hide-mid" style="width:16%">Release</th></tr></thead><tbody>{body}</tbody></table></div>')

def computer_group(name, meta, tone, label, rows):
    return (f'<div class="dl-group"><div class="dl-group-head" style="padding:12px 16px">{PCG}<span class="dl-strong" style="font-size:13px">{name}</span>'
            f'<span>{meta}</span><span class="dl-end">{status(tone, label)}</span></div>{table(rows)}</div>')

# The same decision as "Roll back home-gym?" in Waiting on you, shown where it applies.
ROLLBACK_CARD = approval(W_LG, 'Roll back home-gym to 81be0d2?',
    'home-gym sync fails 38% of jobs with <code class="dl-code-inline">column "started" does not exist</code> since the 1:58 PM release. '
    'The web app and the worker ship as one release, so both go back and migration 0042 is undone.'
    '<span class="dl-meta" style="display:block;margin-top:4px">From Warden · also in Waiting on you</span>',
    btn('Roll back home-gym', 'primary', 'Rollback.dc.html') + btn('Open worker', href='Worker.dc.html') + btn('Not now', 'quiet'))

def live_app(card=None, ser=None, sub='7 apps on 2 computers · 1 failing · 1 high memory · checked 20 s ago', **state):
    return app('live', f'''
{head('Live', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page">
  {page_head('Live', sub, btn('Discover apps', 'secondary', 'Discover.dc.html'))}
  {ROLLBACK_CARD if card is None else card}
  {computer_group('SER', 'Coordinator · CPU 14% · memory 38% · disk 61%', '', 'Online', SER if ser is None else ser)}
  {computer_group('bazzite', 'Takes tasks · runs apps · CPU 22% · memory 51%', '', 'Online', BAZZITE)}
  {section('Not running', '', group([item('recipes', 'Stopped by you 3 days ago · would run on SER', APPG, btn('Start', 'quiet'), 'Project.dc.html', False)]))}
</div></div>''', **state)

B['Live.dc.html'] = ('live', 'Live — every running app, grouped by computer', live_app(), 1440, 1100)
B['LiveDark.dc.html'] = ('live', 'Live — dark theme', f'<div data-theme="dark" style="background:var(--paper);color:var(--ink)">{live_app()}</div>', 1440, 1100)

# ---------- Project-level rollback ----------
arrow = lambda a, b: f'<span class="dl-c dl-mono">{a} → {b}</span>'
B['Rollback.dc.html'] = ('live', 'Rolling back a release moves the whole project', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{live_app()}
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="Roll back home-gym">
  <div class="dl-dialog-head"><h2>Roll back home-gym?</h2>{ib('x', 'Close')}</div>
  <p class="dl-soft" style="margin:0">Goes back to <span class="dl-mono">81be0d2</span>, the release before 1:58 PM, which ran for 9 days without errors. A release covers the whole project, so everything in it moves together.</p>
  {group([
    item('home-gym', 'Web app on SER', APPG, arrow('9c3e1fa', '81be0d2')),
    item('home-gym sync', 'Worker on SER', APPG, arrow('9c3e1fa', '81be0d2')),
    item('Migration 0042', 'Renames workouts.started_at back to started', '<span class="dl-glyph plain">' + i('undo', 12) + '</span>', c('Undone')),
    item('1,240 queued jobs', 'Retried by the rolled-back worker', '<span class="dl-glyph plain">' + i('clock', 12) + '</span>', c('Kept'))])}
  <div class="dl-notice">{i('shield', 16)}<span>Takes about 40 s. Warden watches health for 10 minutes, and Scout keeps fixing it forward in Fix the sync migration.</span></div>
  <div class="dl-dialog-foot">{btn('Cancel')}{btn('Roll back home-gym', 'primary')}</div>
</div></div></div>''')

# ---------- A sick worker, in detail ----------
checks = [
    (FAIL(), 'Jobs', '38% failing in the last 15 min · column "started" does not exist', 'Usually under 1%'),
    (FAIL(), 'Queue', '1,240 waiting · oldest 14 min', 'Usually empty within a minute'),
    ('<span style="color:var(--warning);display:inline-flex">' + i('refresh', 16) + '</span>', 'Process', 'Running · restarted 3 times in 10 min', 'Exits on the first failed batch'),
    (OK(), 'Heartbeat', 'Last seen 4 s ago', 'Expected every 10 s'),
]
check_rows = ''.join(item(t, d, ic, c(n)) for ic, t, d, n in checks)
APP_TABS = [('overview', 'Overview', 'Worker.dc.html', ''), ('settings', 'Settings', 'AppSettings.dc.html', '')]
B['Worker.dc.html'] = ('live', 'A sick worker: what health means without an address', app('live', f'''
{head('home-gym sync', 'Worker in home-gym', ib('search', 'Search') + ib('more', 'More'), APPG)}
<div class="dl-scroll"><div class="dl-page" style="padding-top:8px">
  {tabs(APP_TABS, 'overview')}
  <div class="dl-page-head"><div class="dl-t"><h1 class="dl-title" style="display:flex;align-items:center;gap:10px">home-gym sync {status('failed', 'Failing')}</h1><span class="dl-meta">Worker · no address · part of <a href="App.dc.html" class="dl-link">home-gym</a> · release 9c3e1fa on SER</span></div>
  <span class="dl-end">{btn('Logs', href='Logs.dc.html')}{btn('Roll back home-gym', 'primary', 'Rollback.dc.html')}</span></div>
  {section('Health', 'A worker has no address to check, so deploy.local watches what it does.', group([check_rows]))}
  {section('Release 9c3e1fa', 'Rename workouts.started to started_at · released 1:58 PM. One release covers the project, so rolling back moves both apps and undoes the migration.', group([
    item('home-gym', 'Web app · reads started_at', APPG, status('', 'Healthy'), 'App.dc.html'),
    item('home-gym sync', 'This worker · still reads started', APPG, status('failed', 'Failing')),
    item('Migration 0042', 'Renamed workouts.started to started_at', '<span class="dl-glyph plain">' + i('file', 12) + '</span>', c('Applied 1:58 PM'))]))}
  <div class="dl-cols">
    {section('Jobs in the last hour', '', f'<div class="dl-stat"><span style="display:flex;justify-content:space-between"><span class="dl-meta">Completed</span><span class="dl-meta">Failed</span></span><svg class="dl-spark" viewBox="0 0 110 40" preserveAspectRatio="none" aria-hidden="true" style="height:64px"><polyline points="0,8 10,7 20,8 30,9 40,8 50,10 60,22 70,26 80,28 90,30 100,31 110,32" fill="none" stroke="var(--ink-soft)" stroke-width="1.5" vector-effect="non-scaling-stroke"/><polyline points="0,39 10,39 20,39 30,39 40,39 50,38 60,24 70,20 80,18 90,17 100,16 110,16" fill="none" stroke="var(--danger)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg><span class="dl-meta">Failures start at 1:58 PM, the 9c3e1fa release</span></div>')}
    {section('Latest error', '', '<pre class="dl-term wrap">2:31:07 PM  error  sync batch 8812 failed\n  column "started" does not exist\n  at readWorkouts (src/sync/workouts.ts:41)\n  retrying in 30 s (attempt 3 of 5)</pre>')}
  </div>
</div></div>'''), 1440, 1000)

# ---------- All projects ----------
B['Projects.dc.html'] = ('projects', 'Projects', app('projects', f'''
{head('Projects', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page">
  {page_head('Projects', 'Repositories, and apps installed from Discover', btn('Discover apps', 'secondary', 'Discover.dc.html') + btn('New project', 'primary'))}
  {section('With code', '', group([
    item('deploy.local', 'main · 2 open pull requests · 1 app', FOLDER, status('', 'Healthy') + c('6h ago'), 'Project.dc.html'),
    item('home-gym', 'main · 2 apps · release 9c3e1fa', FOLDER, status('failed', '1 of 2 apps failing') + c('34m ago'), 'Project.dc.html'),
    item('recipes', 'main · 1 app', FOLDER, status('inactive', 'Stopped') + c('3d ago'), 'Project.dc.html')]))}
  {section('Apps from Discover', 'Published images. No repository, so no code, pull requests or issues.', group([
    item('Immich', 'v1.122.3 · photos.deploy.local', APPG, status('attention', 'High memory') + c('4d ago'), 'ImmichApp.dc.html'),
    item('Vaultwarden', '1.32.0 · vault.deploy.local', APPG, status('', 'Healthy') + c('9d ago'), 'ImmichApp.dc.html'),
    item('Miniflux', '2.2.3 · feeds.deploy.local · 2 apps', APPG, status('', 'Healthy') + c('12d ago'), 'ImmichApp.dc.html')]))}
</div></div>'''))

# ---------- An app-only project ----------
# An app from Discover is a one-app project, so its project page is its app page.
APP_TABS2 = [('overview', 'Overview', 'ImmichApp.dc.html', ''), ('releases', 'Releases', '#', ''), ('logs', 'Logs', '#', ''), ('settings', 'Settings', '#', '')]
B['ImmichApp.dc.html'] = ('projects', 'An app from Discover (no repository)', app('projects', f'''
{head('Immich', 'App from Discover', ib('search', 'Search') + ib('more', 'More'), APPG)}
<div class="dl-scroll"><div class="dl-page wide" style="padding-top:8px">
  {tabs(APP_TABS2, 'overview')}
  <div class="dl-page-head"><div class="dl-t"><h1 class="dl-title" style="display:flex;align-items:center;gap:10px">Immich {status('attention', 'High memory')}</h1><span class="dl-meta"><a href="#" class="dl-link">photos.deploy.local</a> · v1.122.3 · on SER · installed from Discover 4 days ago</span></div>
  <span class="dl-end">{btn('Restart')}{btn('Open')}</span></div>
  <div class="dl-notice">{i('pulse', 16)}<span>Memory has been at 92% of its 4 GB limit for 20 minutes. Warden restarts Immich if it stops answering.</span><span class="dl-end">{btn('Raise limit to 6 GB', 'quiet')}</span></div>
  <div class="dl-stats">
    <div class="dl-stat"><span class="dl-meta">Memory</span><span class="dl-v">3.7 of 4 GB</span><div class="dl-bar"><span style="width: 92%; background: var(--warning)"></span></div></div>
    <div class="dl-stat"><span class="dl-meta">CPU</span><span class="dl-v">31%</span><div class="dl-bar"><span style="width: 31%"></span></div></div>
    <div class="dl-stat"><span class="dl-meta">Library</span><span class="dl-v">212 GB</span><span class="dl-meta">48,210 photos · 1,904 videos</span></div>
    <div class="dl-stat"><span class="dl-meta">p95 latency</span><span class="dl-v">210 ms</span><span class="dl-meta">Usually 60 ms</span></div>
  </div>
  <div class="dl-cols">
    {section('App', '', group([f'<div class="dl-inset">{setting("Version", "1.123.0 is available", btn("Update", "quiet", "UpdateApp.dc.html"))}{setting("Computer", "", "SER")}{setting("Storage", "Photos live on SER, outside the app", "/srv/immich · backed up nightly")}{setting("Code", "Runs a published image, so there is nothing to change here", btn("Connect a repository", "quiet"))}</div>']))}
    {section('Activity', '', group([item('Warden noticed high memory', '92% of limit for 20 minutes', W_GLYPH, c('now')), item('Updated to v1.122.3', 'By you, from Discover', i('rocket', 16), c('4d')), item('Installed from Discover', 'By you', i('download', 16), c('4d'))]))}
  </div>
</div></div>'''))

# ---------- Live on the phone ----------
B['LivePhone.dc.html'] = ('phone', 'iPhone — Live', phone('', f'''
<div style="padding:0 16px 8px">{approval(W_LG, 'Roll back home-gym?', 'The sync worker fails 38% of jobs since 1:58 PM. Both apps go back and migration 0042 is undone.', btn('Roll back', 'primary', 'Rollback.dc.html') + btn('Open worker', href='Worker.dc.html'))}</div>
<div class="dl-ph-label">SER · online</div>
<div class="dl-ph-group">{ph_row('home-gym sync', 'Worker · 38% of jobs error', i('app', 18), status('failed', 'Failing'), 'Worker.dc.html')}{ph_row('Immich', 'Memory 92% of 4 GB', i('app', 18), status('attention', 'High memory'), 'ImmichApp.dc.html')}{ph_row('home-gym', 'Web app · 12 req/min', i('app', 18), status('', 'Healthy'))}{ph_row('deploy.local', '184 req/min', i('app', 18), status('', 'Healthy'))}</div>
<div class="dl-ph-label">bazzite · online</div>
<div class="dl-ph-group">{ph_row('Vaultwarden', '1 req/min', i('app', 18), status('', 'Healthy'))}{ph_row('Miniflux', '2 req/min', i('app', 18), status('', 'Healthy'))}{ph_row('Miniflux fetcher', 'Worker · queue empty', i('app', 18), status('', 'Healthy'))}</div>
''', 'live', '', ph_btn('search', 'Search'), 'Live'))
