from shell import *
from b_projects import spark
from b_work import scout_panel, review_bar

B = {}
FOLDER = '<span class="dl-glyph plain">' + i('folder', 12) + '</span>'

# ---------- Fewer nouns: a tab appears only once its thing exists ----------
# A one-app project has no Apps tab (the project page is the app page) and no
# Pull requests or Issues tab until the first one is opened.
pantry_tabs = tabs([('overview', 'Overview', '#', ''), ('code', 'Code', '#', ''), ('releases', 'Releases', '#', '2'), ('logs', 'Logs', '#', ''), ('settings', 'Settings', '#', '')], 'overview')
B['OneAppProject.dc.html'] = ('projects', 'A one-app project: only the tabs it needs', app('projects', f'''
{head('pantry', 'Project', ib('search', 'Search') + btn('New task', 'primary', 'Home.dc.html'), FOLDER)}
<div class="dl-scroll"><div class="dl-page" style="padding-top:8px">
  {pantry_tabs}
  <div class="dl-page-head"><div class="dl-t"><h1 class="dl-title" style="display:flex;align-items:center;gap:10px">pantry {status('', 'Healthy')}</h1><span class="dl-meta"><a href="#" class="dl-link">pantry.deploy.local</a> · c09ab12 · on SER · up 3 days</span></div>
  <span class="dl-end">{btn('Restart')}{btn('Open')}</span></div>
  <div class="dl-stats">
    <div class="dl-stat"><span class="dl-meta">Requests per minute</span><span class="dl-v">6</span>{spark([4, 5, 6, 5, 7, 6, 5, 6, 7, 6, 6, 6])}</div>
    <div class="dl-stat"><span class="dl-meta">p95 latency</span><span class="dl-v">28 ms</span>{spark([20, 22, 19, 21, 20, 19, 18, 21, 20, 19, 20, 19])}</div>
    <div class="dl-stat"><span class="dl-meta">Memory</span><span class="dl-v">96 MB</span>{spark([10, 10, 11, 11, 11, 11, 12, 12, 11, 11, 12, 12])}</div>
  </div>
  {section('Recent', '', group([item('Released c09ab12', 'Show expiry dates · by you, from the CLI', i('rocket', 16), c('3d')), item('Created from a folder', 'deploy in ~/code/pantry', i('folder', 16), c('5d'))]))}
  <span class="dl-meta">Pull requests and issues get their own tabs once there are some. Add a second app and an Apps tab appears.</span>
</div></div>'''))

# ---------- First time: the words are taught where they first happen ----------
stages = [('Task', 'Scout works in its own copy of the code, on a free computer', True),
          ('Pull request', 'You review the change; a second model reviews it first', False),
          ('Release', 'Merging ships it, and every app in the project moves together', False)]
stage_html = ''.join(f'''<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding:12px;border-radius:8px;{"background:var(--surface);box-shadow:0 0 0 1px var(--line-strong)" if on else ""}">
  <span class="dl-meta">{n + 1} of 3</span><span class="dl-strong" style="font-size:15px;line-height:24px">{t}</span><span class="dl-soft" style="font-size:12px;line-height:16px">{d}</span></div>''' for n, (t, d, on) in enumerate(stages))
hint = f'''<div class="dl-notice" style="flex-direction:column;align-items:stretch;gap:12px;padding:16px">
  <div style="display:flex;align-items:center;gap:10px">{i('idea', 16)}<span class="dl-strong" style="color:var(--ink)">Your first task</span><span class="dl-end">{btn('Got it', 'quiet')}</span></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">{stage_html}</div>
</div>'''
first_today = [('Add a shopping list', 'FirstTask.dc.html', 'first', 'spin', '1m')]
B['FirstTask.dc.html'] = ('work', 'The first task: task, pull request and release explained once, in place', app('first', f'''
{head('Add a shopping list to pantry', 'pantry · MacBook Pro', ib('more', 'More'))}
{review_bar('chat', 'Running · 1 min', btn('Update from main'), ('FirstTask.dc.html', '#', '#'))}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  {hint}
  {you('Add a shopping list to pantry that pulls in items about to expire.')}
  <div class="dl-turn">{worklog('Reading the pantry code', [S('file', 'Read src/items.ts and src/routes.ts'), S('search', 'Searched for expiry', '4 results')], True)}</div>
</div></div></div>
{composer(chip('pantry', 'folder') + chip('MacBook Pro', 'compute'), fid='first-msg')}
''', inbox=[], today=first_today, live='<span class="dl-c">1 running</span>', fresh=True))

# ---------- A long agent conversation stays readable ----------
def folded(when, summary, tags):
    t = ''.join(f'<span class="dl-tag">{x}</span>' for x in tags)
    return f'''<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface)">
  {i('right', 14)}<span class="dl-strong" style="font-weight:500;width:92px;flex:none">{when}</span><span class="dl-soft" style="flex:1;min-width:0">{summary}</span><span style="display:flex;gap:6px">{t}</span></div>'''
day = lambda t: f'<div style="display:flex;align-items:center;gap:10px;font-size:12px;line-height:16px;color:var(--muted)"><span style="flex:1;height:1px;background:var(--line)"></span>{t}<span style="flex:1;height:1px;background:var(--line)"></span></div>'
filters = f'''<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
  <label class="dl-field" style="flex:1 1 220px;max-width:320px"><span class="dl-sr">Search this conversation</span>{i('search', 14)}<input type="text" placeholder="Search this conversation"></label>
  <div class="dl-seg"><a class="on">Everything</a><a>Decisions</a><a>Tasks</a></div></div>'''
B['LongChat.dc.html'] = ('work', 'A long agent conversation: past days fold, today stays open', app('scout', f'''
{head('Scout', 'Keeps deploy.local moving', ib('eye', 'Tracking', True) + ib('settings', 'Tune Scout', href='Configure.dc.html'), S_GLYPH)}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  {filters}
  {folded('Last week', '5 briefs · 9 tasks started, 7 shipped, 2 closed', ['7 merged'])}
  {folded('Monday', 'Morning brief · 2 proposals, both done', ['2 decisions'])}
  {folded('Yesterday', 'Brief and 3 follow-ups · started Self-release pipeline', ['1 task'])}
  {day('Today')}
  <span class="dl-meta" style="font-weight:600;color:var(--ink-soft)">Morning brief · Tuesday 7:00 AM</span>
  <div class="dl-turn">
    {worklog('Worked for 1m', [S('pr', 'Reviewed 14 pull requests and last week\'s tasks'), S('pulse', 'Checked SER 2a91c0e with Warden', 'healthy')])}
    {reply('PR #17 shipped overnight. PR #18 is ready for you.')}
    {approval(i('merge', 18), 'Merge PR #18', 'Stops the repositories cancellation test timing out. Reviewed by GPT-6.1-Sol, 4 checks passed on this version.', btn('Merge and release', 'primary') + btn('Review', href='Review.dc.html') + btn('Not now', 'quiet'))}
  </div>
  <span class="dl-meta">Briefs once a day; otherwise Scout only writes when something needs you or finished.</span>
</div></div></div>
{composer(chip('Scout'), placeholder='Ask Scout…', fid='long-msg', model='Qwen3-8B · local')}
''', scout_panel))
