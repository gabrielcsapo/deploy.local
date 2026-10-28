from shell import *
from b_projects import project
from b_work import review_bar

B = {}
APPG = '<span class="dl-glyph plain">' + i('app', 12) + '</span>'
DBG = '<span class="dl-glyph plain">' + i('chip', 12) + '</span>'
PRG = '<span class="dl-glyph plain">' + i('pr', 12) + '</span>'

# ---------- A task and its pull request are one page ----------
# The pull request is the task's last stage: same Chat, Changes and Checks, one merge card at the end.
pr_bar = review_bar('chat', 'Pull request #18 · scout/cancel-timeout → main · <span class="dl-add">+46</span> <span class="dl-del">−12</span>',
                    btn('Update from main'), ('Review.dc.html', '#', '#'), '4 passed')
B['Review.dc.html'] = ('work', 'A task at its last stage: the pull request, reviewed by a second model', app('pr18', f'''
{head('Stop the repositories cancellation test timing out', 'deploy.local · ready to merge', ib('link', 'Copy link') + ib('more', 'More'), PRG)}
{pr_bar}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  <div class="dl-turn"><div class="dl-who-line">{S_GLYPH}Scout<span class="dl-meta">from issue "Repositories cancellation test flakes" · 2 h ago</span></div>
    {worklog('Worked for 14m', [S('file', 'Read server/repositories/clone.test.ts'), S('edit', 'Edited 2 files', '<span class="dl-add">+46</span> <span class="dl-del">−12</span>'), S('terminal', 'Ran the repositories suite 20 times', '20 passed'), S('pr', 'Opened pull request #18')])}
    {reply('The cancellation test raced the clone finishing. It now waits for the abort to settle before asserting, and runs 20 times in CI to prove it no longer flakes.')}</div>
  <div class="dl-turn"><div class="dl-who-line"><span class="dl-glyph plain">R</span>GPT-6.1-Sol<span class="dl-meta">second-model review · 1 h ago</span></div>
    {reply('One issue: <code>waitForAbort</code> can hang if the clone already finished. Add a timeout.')}
    {worklog('Scout fixed it in 2m', [S('edit', 'Added a 5 s timeout to waitForAbort'), S('terminal', 'Ran the repositories suite 20 times', '20 passed')])}</div>
  <div class="dl-notice">{OK()}<span>4 checks passed on this version · no conflicts with main · review resolved</span><span class="dl-end">{btn('Checks', 'quiet')}</span></div>
  {approval(i('merge', 18), 'Merge and release PR #18?', 'Releases deploy.local to SER with prepare, verify and activate. Warden watches for 10 minutes and rolls back on failure.', btn('Merge and release', 'primary') + btn('Merge only') + btn('Request changes', 'quiet'))}
</div></div></div>
{composer(chip('PR #18', 'pr'), fid='pr-msg')}
'''))

# ---------- home-gym: the project owns releases, logs, variables and secrets ----------
incident = f'<div class="dl-banner danger">{i("x", 16)}<span class="dl-t"><span>home-gym sync is failing on 9c3e1fa</span><span>Warden asked to roll back the whole release. It is in Waiting on you.</span></span><span class="dl-end">{btn("Review rollback", "quiet", "Rollback.dc.html")}</span></div>'
B['App.dc.html'] = ('projects', 'A project\'s apps: each has only Overview and Settings', project('apps', f'''
{incident}
{section('Apps in home-gym', 'They ship together in one release and share the project\'s logs, variables and secrets. Open an app for its health and its own settings.', group([
    item('home-gym', 'Web app · home-gym.deploy.local · SER', APPG, status('', 'Healthy') + c('9c3e1fa'), 'AppSettings.dc.html'),
    item('home-gym sync', 'Worker · no address · SER', APPG, status('failed', 'Failing') + c('9c3e1fa'), 'Worker.dc.html'),
    item('Postgres 17', 'Service · data in /srv/home-gym/db on SER · backed up nightly', DBG, status('', 'Healthy') + c('17.2'))]))}
''', True, name='home-gym'))

rels = [('9c3e1fa', 'Rename workouts.started to started_at', 'Live', '34 min ago · Scout · PR #42', True),
        ('81be0d2', 'Weekly summary email', '', '9 days ago · you', False),
        ('4c2a7d1', 'Refresh Strava tokens before they expire', '', '12 days ago · Scout · PR #39', False),
        ('e07b1aa', 'Add a rest timer', 'Rolled back', '3 weeks ago · verify failed', False)]
rel_nav = ''.join(f'<a href="#" class="dl-nav{" on" if sel else ""}" style="height:auto;padding:8px;align-items:flex-start">{i("rocket", 14)}<span class="dl-t" style="white-space:normal"><span class="dl-strong dl-mono">{sha}</span> <span class="dl-meta" style="display:block">{meta}</span></span>{f"<span class=\"dl-tag\">{tag}</span>" if tag else ""}</a>' for sha, t, tag, meta, sel in rels)
B['Deployments.dc.html'] = ('projects', 'Releases: one per project, with every app inside', project('releases', f'''
<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
  <nav aria-label="Releases" style="flex:1 1 240px;max-width:280px;display:flex;flex-direction:column">{rel_nav}</nav>
  <div style="flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:16px">
    <div class="dl-page-head"><div class="dl-t"><span class="dl-strong" style="font-size:15px;line-height:24px">Rename workouts.started to started_at</span><span class="dl-meta">9c3e1fa · released 1:58 PM by Scout from PR #42 · took 41 s</span></div><span class="dl-end">{btn('Roll back to 81be0d2…', href='Rollback.dc.html')}</span></div>
    {group([item('home-gym', 'Web app', APPG, status('', 'Healthy'), 'AppSettings.dc.html'), item('home-gym sync', 'Worker', APPG, status('failed', 'Failing'), 'Worker.dc.html'),
            item('Migration 0042', 'Renamed workouts.started to started_at', '<span class="dl-glyph plain">' + i('file', 12) + '</span>', c('Applied'))], 'In this release')}
    <pre class="dl-term">[prepare]  building both apps for 9c3e1fa          done 19.2s
[verify]   migration 0042 on a copy of the data     ok
[verify]   web app  GET /healthz → 200              ok
[verify]   sync worker started                      ok  (no jobs yet)
[activate] web app → 9c3e1fa · sync worker → 9c3e1fa
[watch]    2:00 PM sync worker: 38% of jobs failing
[watch]    Warden asked you to roll back the release</pre>
    <span class="dl-meta">Verify only checked that the worker started. Running a sample job during verify would have caught this; Scout has an issue open for it.</span>
  </div>
</div>''', True, name='home-gym'))

logs = [('14:31:07', 'home-gym sync', 'error', 'sync batch 8812 failed: column "started" does not exist'),
        ('14:31:02', 'home-gym', 'info', 'GET /api/workouts 200 31ms'),
        ('14:30:58', 'home-gym sync', 'warn', 'retrying batch 8812 in 30 s (attempt 3 of 5)'),
        ('14:30:51', 'home-gym', 'info', 'GET /healthz 200 2ms'),
        ('14:30:37', 'home-gym sync', 'error', 'sync batch 8811 failed: column "started" does not exist'),
        ('14:30:30', 'postgres', 'info', 'checkpoint complete: wrote 312 buffers'),
        ('14:30:22', 'home-gym', 'info', 'POST /api/sessions 201 44ms'),
        ('14:30:07', 'home-gym sync', 'info', 'process restarted (3rd time in 10 min)'),
        ('14:29:58', 'home-gym', 'info', 'GET / 200 12ms')]
log_rows = ''.join(f'<div class="dl-log-row{" warn" if lv == "warn" else ""}{" error" if lv == "error" else ""}"><span>{t}</span><span>{s}</span><span class="dl-lv">{lv}</span><span>{m}</span></div>' for t, s, lv, m in logs)
B['Logs.dc.html'] = ('projects', 'Logs: one stream per project, filtered by app', project('logs', f'''
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
  <label class="dl-field" style="flex:1 1 240px;max-width:360px"><span class="dl-sr">Filter logs</span>{i('search', 14)}<input type="text" placeholder="Filter"></label>
  <span class="dl-chip">All apps and services {i('chev', 12)}</span><span class="dl-chip">Any level {i('chev', 12)}</span><span class="dl-chip">Last hour {i('chev', 12)}</span>
  <span style="margin-left:auto" class="dl-status active"><span class="dl-dot"></span>Live</span>
</div>
<div class="dl-source"><div class="dl-log">{log_rows}</div></div>''', True, name='home-gym'))
