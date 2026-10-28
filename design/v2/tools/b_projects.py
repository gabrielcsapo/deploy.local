from shell import *

B = {}
FOLDER = '<span class="dl-glyph plain">' + i('folder', 12) + '</span>'

def project(on, body, wide=False, sub_end='', name='deploy.local', **state):
    return app('projects', f'''
{head(name, 'Project', ib('search', 'Search') + btn('New task', 'primary', 'Home.dc.html'), FOLDER)}
<div class="dl-scroll"><div class="dl-page{' wide' if wide else ''}" style="padding-top:8px">
  {tabs(project_tabs(name), on)}
  {body}
</div></div>''', **state)

# ---------- All projects ----------
B['Projects.dc.html'] = ('projects', 'Projects', app('projects', f'''
{head('Projects', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page">
  {page_head('Projects', 'A repository and everything it runs.', btn('Discover apps', 'secondary', 'Discover.dc.html') + btn('New project', 'primary'))}
  {group([
    item('deploy.local', 'main · 2 open pull requests · deploy.local.deploy.local', FOLDER, status('', 'Running') + c('2h ago'), 'Project.dc.html'),
    item('home-gym', 'main · 2 apps · release 9c3e1fa', FOLDER, status('failed', '1 of 2 apps failing') + c('34m ago'), 'Project.dc.html'),
    item('recipes', 'main · recipes.deploy.local', FOLDER, status('inactive', 'Stopped') + c('3d ago'), 'Project.dc.html'),
    item('notes-sync', 'Repository only · no app', FOLDER, c('12d ago'), 'Project.dc.html')])}
</div></div>'''))

# ---------- Project overview ----------
B['Project.dc.html'] = ('projects', 'Project overview', project('overview', f'''
<div class="dl-stats">
  <div class="dl-stat"><span class="dl-meta">Open work</span><span class="dl-v">3</span><span class="dl-meta">2 running · 1 waiting on you</span></div>
  <div class="dl-stat"><span class="dl-meta">Pull requests</span><span class="dl-v">2</span><span class="dl-meta">#18 ready to merge</span></div>
  <div class="dl-stat"><span class="dl-meta">Shipped this week</span><span class="dl-v">14</span><span class="dl-meta">Last 6 h ago</span></div>
  <div class="dl-stat"><span class="dl-meta">App</span><span class="dl-v" style="display:flex;align-items:center;gap:8px">{status('', 'Healthy')}</span><span class="dl-meta">2a91c0e on SER</span></div>
</div>
<div class="dl-cols">
  {section('Work', '1 decision for this project is in Waiting on you.', group([
    item('Self-release pipeline', 'Running tests · MacBook Pro', SPIN(), c('12m'), 'Task.dc.html'),
    item('Show checks on merged PRs', 'Ready for review · <span class="dl-add">+88</span> <span class="dl-del">−12</span>', OK(), c('40m'), 'TaskChanges.dc.html')]))}
  {section('Recent releases', '', group([
    item('2a91c0e', 'Pass worker TLS trust to tool servers', i('rocket', 16), status('', 'Live'), 'Deployments.dc.html'),
    item('0d96f82', 'Keep leading zeros in SSH keys', i('rocket', 16), c('Yesterday'), 'Deployments.dc.html'),
    item('d279f45', 'Queue runs per computer', i('rocket', 16), c('2 days ago'), 'Deployments.dc.html')]))}
</div>'''))

# ---------- Code ----------
tree = [('folder', 'app', 'Separate phone layout from desktop', '2 days ago'), ('folder', 'native', 'Clone popover in the Mac app', '3 days ago'),
        ('folder', 'packages', 'Shared design tokens', '1 day ago'), ('folder', 'server', 'Pass worker TLS trust to tool servers', '6 h ago'),
        ('folder', 'scripts', 'Release prepare and verify', '1 day ago'), ('file', 'README.md', 'Document hosted Git', '5 days ago'), ('file', 'package.json', 'Patch ssh2 for Ed25519 keys', 'yesterday')]
rows = ''.join(f'<tr><td class="dl-name"><span style="display:inline-flex;align-items:center;gap:8px">{i(ic, 14)}{n}</span></td><td>{m}</td><td>{t}</td></tr>' for ic, n, m, t in tree)
B['Code.dc.html'] = ('projects', 'Project code', project('code', f'''
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
  <span class="dl-chip">{i('branch', 14)}main {i('chev', 12)}</span>
  <label class="dl-field" style="width:240px"><span class="dl-sr">Go to file</span>{i('search', 14)}<input type="text" placeholder="Go to file"><span class="dl-kbd">T</span></label>
  <span style="margin-left:auto;display:flex;gap:8px">{btn('Clone')}{btn('History', 'quiet')}</span>
</div>
<div class="dl-group">
  <div class="dl-group-head"><span class="dl-avatar" style="width:16px;height:16px;font-size:9px">G</span><span class="dl-strong" style="font-weight:500">Gabriel</span><span>Pass worker TLS trust to tool servers</span><span class="dl-end">2a91c0e · 6 h ago</span></div>
  <div class="dl-table-wrap"><table class="dl-table"><thead><tr><th>Name</th><th>Last commit</th><th>Updated</th></tr></thead><tbody>{rows}</tbody></table></div>
</div>
<div class="dl-group"><div class="dl-group-head">README.md</div><div style="padding:20px 24px" class="dl-reply"><p style="font-size:22px;line-height:28px;font-weight:600">deploy.local</p><p>Deploy apps and run coding agents on computers you own. One coordinator, any number of workers, hosted Git and a phone app.</p></div></div>''', True))

# ---------- Pull requests ----------
B['PullRequests.dc.html'] = ('projects', 'Pull requests', project('pulls', f'''
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div class="dl-seg"><a href="#" class="on">Open 2</a><a href="#">Merged 16</a><a href="#">Closed</a></div>
<label class="dl-field" style="max-width:280px;margin-left:auto"><span class="dl-sr">Search pull requests</span>{i('search', 14)}<input type="text" placeholder="Search"></label></div>
<p class="dl-section-sub" style="margin:0">A pull request is the last stage of a task. Open one to see its chat, changes and checks in one place.</p>
{group([
  item('Stop the repositories cancellation test timing out', '#18 · task by Scout · reviewed by GPT-6.1-Sol · 4 checks passed', i('pr', 16), '<span class="dl-tag">Ready to merge</span>' + c('2h'), 'Review.dc.html'),
  item('Show checks on merged pull requests', '#19 · task by Scout · second-model review running · <span class="dl-add">+88</span> <span class="dl-del">−12</span>', i('pr', 16), SPIN() + c('40m'), 'TaskChanges.dc.html')])}
{section('Merged recently', '', group([
  item('Keep leading zeros in SSH keys', '#17 · merged yesterday · released 0d96f82', i('merge', 16), c('1d'), '#'),
  item('Run checks on the published version', '#16 · merged 2 days ago', i('merge', 16), c('2d'), '#')]))}'''))

# ---------- Issues ----------
B['Issues.dc.html'] = ('projects', 'Issues', project('issues', f'''
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div class="dl-seg"><a href="#" class="on">Open 5</a><a href="#">Closed 31</a></div>
<span style="margin-left:auto;display:flex;gap:8px">{btn('New issue')}</span></div>
{group([
  item('Merged pull requests don\'t show their checks', 'Found by Scout · task running', i('issue', 16), SPIN() + c('today'), 'Task.dc.html'),
  item('Any non-test command marks checks as earlier', 'Found by Scout in PR #15', i('issue', 16), '<span class="dl-tag">scout</span>' + c('3d'), '#'),
  item('Launch the bazzite app one way, not two', 'Opened by Gabriel', i('issue', 16), c('3d'), '#'),
  item('Repositories cancellation test flakes', 'Fixed by #18 · closes on merge', i('issue', 16), c('4d'), 'Review.dc.html'),
  item('Mac Clone popover needs a check on a locked screen', 'Opened by Scout', i('issue', 16), c('5d'), '#')])}'''))

# ---------- App ----------
def spark(points, cls=''):
    pts = ' '.join(f'{x * 10},{40 - y}' for x, y in enumerate(points))
    return f'<svg class="dl-spark" viewBox="0 0 {10 * (len(points) - 1)} 40" preserveAspectRatio="none" aria-hidden="true"><polyline points="{pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>'
B['App.dc.html'] = ('projects', 'An app and how it\'s running', project('apps', f'''
<div class="dl-page-head"><div class="dl-t"><h1 class="dl-title" style="display:flex;align-items:center;gap:10px">deploy.local {status('', 'Healthy')}</h1><span class="dl-meta"><a href="#" class="dl-link">deploy.local</a> · 2a91c0e · on SER · up 6 h</span></div>
<span class="dl-end">{btn('Restart')}{btn('Open', 'primary')}</span></div>
<div class="dl-stats">
  <div class="dl-stat"><span class="dl-meta">Requests per minute</span><span class="dl-v">184</span>{spark([12, 14, 13, 18, 22, 19, 24, 21, 26, 25, 23, 27])}</div>
  <div class="dl-stat"><span class="dl-meta">p95 latency</span><span class="dl-v">42 ms</span>{spark([20, 22, 19, 21, 24, 20, 18, 22, 21, 19, 20, 18])}</div>
  <div class="dl-stat"><span class="dl-meta">CPU</span><span class="dl-v">7%</span>{spark([6, 8, 7, 9, 6, 7, 12, 8, 7, 6, 7, 7])}</div>
  <div class="dl-stat"><span class="dl-meta">Memory</span><span class="dl-v">412 MB</span>{spark([18, 18, 19, 19, 20, 20, 21, 21, 21, 22, 22, 22])}</div>
</div>
<div class="dl-cols">
  {section('Runtime', '', group([f'<div class="dl-inset">{setting("Computer", "", "SER")}{setting("Command", "", "<span class=\"dl-mono\">node server/main.js</span>")}{setting("Domains", "", "deploy.local · *.deploy.local")}{setting("Health check", "", "GET /healthz every 10 s")}</div>']))}
  {section('Activity', '', group([item('Released 2a91c0e', 'Merged PR #18 · by Scout, approved by you', i('rocket', 16), c('6h')), item('Warden checked health after release', '10 minutes, no errors', i('shield', 16), c('6h')), item('Restarted', 'By you', i('refresh', 16), c('2d'))]))}
</div>''', True))

# ---------- Deployments ----------
deps = [('2a91c0e', 'Stop the repositories cancellation test timing out', 'Live', 'Released by you · 1m 48s', True), ('0d96f82', 'Keep leading zeros in SSH keys', '', 'Yesterday · 1m 52s', False),
        ('d279f45', 'Queue runs per computer', '', '2 days ago · 2m 03s', False), ('9a01c4b', 'Update from main for tasks', 'Rolled back', '3 days ago · health failed', False)]
dep_items = ''.join(f'<a href="#" class="dl-nav{" on" if sel else ""}" style="height:auto;padding:8px;align-items:flex-start">{i("rocket", 14)}<span class="dl-t" style="white-space:normal"><span class="dl-strong dl-mono">{sha}</span> <span class="dl-meta" style="display:block">{meta}</span></span>{f"<span class=\"dl-tag\">{tag}</span>" if tag else ""}</a>' for sha, msg, tag, meta, sel in deps)
B['Deployments.dc.html'] = ('projects', 'Deployments', project('deployments', f'''
<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
  <nav aria-label="Releases" style="flex:1 1 240px;max-width:280px;display:flex;flex-direction:column">{dep_items}</nav>
  <div style="flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:16px">
    <div class="dl-page-head"><div class="dl-t"><span class="dl-strong" style="font-size:15px;line-height:24px">Stop the repositories cancellation test timing out</span><span class="dl-meta">2a91c0e · deploy.local on SER and the task worker on bazzite · prepare 41s · verify 52s · activate 15s</span></div><span class="dl-end">{btn('Roll back release')}</span></div>
    <pre class="dl-term">[prepare]  building releases/2a91c0e
[prepare]  pnpm install --frozen-lockfile   done 22.4s
[prepare]  pnpm build                        done 18.9s
[verify]   starting on :7844
[verify]   GET /healthz → 200 in 312ms
[verify]   smoke: sign-in, tasks, repositories → ok
[activate] switching current → 2a91c0e
[activate] edge reloaded · previous kept: 0d96f82, d279f45, 9a01c4b
[activate] task worker on bazzite → 2a91c0e
[watch]    Warden watching for 10 minutes</pre>
  </div>
</div>''', True))

# ---------- Logs ----------
logs = [('14:16:02', 'edge', 'info', 'GET /api/workspace/state 200 18ms'), ('14:16:01', 'coordinator', 'info', 'worker node-worker-node_5d5f… heartbeat'),
        ('14:15:58', 'coordinator', 'warn', 'run queue: MacBook Pro busy, queued task 3f2c for bazzite'), ('14:15:51', 'edge', 'info', 'POST /tasks/59242655/messages 202 41ms'),
        ('14:15:47', 'home-gym', 'error', 'POST /sync column "started" does not exist'), ('14:15:47', 'home-gym', 'error', 'POST /sync column "started" does not exist'),
        ('14:15:40', 'coordinator', 'info', 'checkpoint captured for task 59242655'), ('14:15:33', 'edge', 'info', 'GET /deploy.local.git/info/refs 200 9ms'),
        ('14:15:20', 'lemond', 'info', 'Qwen3-8B · 412 tokens · 15.2 tok/s'), ('14:15:02', 'edge', 'info', 'GET /healthz 200 2ms')]
log_rows = ''.join(f'<div class="dl-log-row{" warn" if lv == "warn" else ""}{" error" if lv == "error" else ""}"><span>{t}</span><span>{s}</span><span class="dl-lv">{lv}</span><span>{m}</span></div>' for t, s, lv, m in logs)
B['Logs.dc.html'] = ('projects', 'Logs', project('logs', f'''
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
  <label class="dl-field" style="flex:1 1 240px;max-width:360px"><span class="dl-sr">Filter logs</span>{i('search', 14)}<input type="text" placeholder="Filter"></label>
  <span class="dl-chip">All services {i('chev', 12)}</span><span class="dl-chip">Any level {i('chev', 12)}</span><span class="dl-chip">Last hour {i('chev', 12)}</span>
  <span style="margin-left:auto" class="dl-status active"><span class="dl-dot"></span>Live</span>
</div>
<div class="dl-source"><div class="dl-log">{log_rows}</div></div>''', True))

# ---------- Discover ----------
apps = [('Immich', 'Photos and videos backup', 'Needs 4 GB memory'), ('Miniflux', 'Minimal feed reader', 'Postgres included'), ('Vaultwarden', 'Password manager server', 'Small'),
        ('Plausible', 'Privacy-friendly analytics', 'ClickHouse included'), ('Gitea', 'Lightweight Git server', 'Small'), ('Home Assistant', 'Home automation', 'Needs USB access')]
cards = ''.join(f'<a href="#" class="dl-stat" style="gap:8px"><span class="dl-glyph plain lg">{n[0]}</span><span class="dl-strong" style="font-size:15px;line-height:24px">{n}</span><span class="dl-soft">{d}</span><span class="dl-meta">{m}</span></a>' for n, d, m in apps)
B['Discover.dc.html'] = ('projects', 'Discover apps to run', app('projects', f'''
{head('Discover', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page wide">
  {page_head('Discover', 'Apps you can run on your computers in one step.', btn('Import from a repository'))}
  <label class="dl-field" style="max-width:420px"><span class="dl-sr">Search apps</span>{i('search', 14)}<input type="text" placeholder="Search apps"></label>
  <div class="dl-stats" style="grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))">{cards}</div>
</div></div>'''))
