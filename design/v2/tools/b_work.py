from shell import *

B = {}

# ---------- Home: start a task ----------
B['Home.dc.html'] = ('work', 'New task', app('new', f'''
{head('', '', ib('panel', 'Show panel'))}
<div class="dl-scroll" style="display:flex;flex-direction:column;justify-content:center">
  <div class="dl-col" style="padding-bottom:64px">
    <div class="dl-greeting"><span class="dl-mark" style="width:40px;height:40px;border-radius:12px;font-size:17px">d</span>
      <h1 class="dl-title">What should we build?</h1>
      <span class="dl-soft">Agents work on your computers. You approve merges and releases.</span></div>
    <div style="height:28px"></div>
    <div class="dl-dock" style="padding:0">{composer(chip('deploy.local', 'folder') + chip('Any free computer', 'compute'), fid='new-task')[len('<div class="dl-dock">'):-len('</div>')]}</div>
    <div class="dl-starters">
      <a href="Main.dc.html" class="dl-starter">{i('idea')}<span>Add a self-release pipeline with rollback</span><span class="dl-end">Scout</span></a>
      <a href="Main.dc.html" class="dl-starter">{i('idea')}<span>Show checks on merged pull requests</span><span class="dl-end">Scout</span></a>
      <a href="Main.dc.html" class="dl-starter">{i('idea')}<span>Launch the bazzite app one way, not two</span><span class="dl-end">Scout</span></a>
    </div>
  </div>
</div>'''))

# ---------- Scout ----------
scout_panel = f'''<aside class="dl-panel" aria-label="Scout is tracking">
  <div class="dl-panel-head">Tracking<span class="dl-end">{ib('x', 'Close')}</span></div>
  <div class="dl-panel-body">
    <a href="Inbox.dc.html" class="dl-panel-item">{i('check', 14)}<span class="dl-t"><span>2 of Scout's questions</span><span>In Waiting on you</span></span></a>
    <div class="dl-panel-label">Running</div>
    <a href="Task.dc.html" class="dl-panel-item">{SPIN()}<span class="dl-t"><span>Self-release pipeline</span><span>MacBook Pro · 12 min</span></span></a>
    <div class="dl-panel-label">Watching</div>
    <div class="dl-panel-item">{i('eye', 14)}<span class="dl-t"><span>Merged PRs don't show their checks</span></span></div>
    <div class="dl-panel-item">{i('eye', 14)}<span class="dl-t"><span>Two ways to launch the bazzite app</span></span></div>
    <div class="dl-panel-label">Shipped this week</div>
    <div class="dl-panel-item">{i('check', 14)}<span class="dl-t"><span>14 pull requests</span><span>Last: Keep leading zeros in SSH keys</span></span></div>
  </div>
</aside>'''
B['Main.dc.html'] = ('work', 'Scout — the dev-loop agent', app('scout', f'''
{head('Scout', 'Keeps deploy.local moving', ib('eye', 'Tracking', True) + ib('settings', 'Tune Scout', href='Configure.dc.html'), S_GLYPH)}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  <div class="dl-turn">
    {worklog('Worked for 1m · morning brief', [S('pr', 'Reviewed 14 pull requests and last week\'s tasks'), S('pulse', 'Checked SER 2a91c0e with Warden', 'healthy'), S('search', 'Compared open gaps against merged work')])}
    {reply('PR #17 shipped overnight. Two things need you, and I have one proposal.')}
    {approval(i('merge', 18), 'Merge PR #18', 'Stops the repositories cancellation test timing out. Reviewed by GPT-6.1-Sol, 4 checks passed on this version.', btn('Merge and release', 'primary') + btn('Review', href='Review.dc.html') + btn('Not now', 'quiet'))}
    {approval(i('idea', 18), 'Start a self-release pipeline?', 'Releases still need SSH to SER. Two tasks: prepare, verify and activate with rollback, then worker auto-update.', btn('Start tasks', 'primary') + btn('Make an issue') + btn('Dismiss', 'quiet'))}
  </div>
  {you('Yes to the pipeline, but have Warden review the rollback plan first. I\'ll look at #18 after lunch.')}
  <div class="dl-turn">
    {worklog('Worked for 2m', [S('shield', 'Asked Warden to review the rollback plan', 'approved'), S('compute', 'Started Self-release pipeline on MacBook Pro')])}
    {reply('The pipeline task is running on MacBook Pro, and I\'ll ask before it activates anything on SER. #18 stays in Waiting on you.')}
  </div>
</div></div></div>
{composer(chip('Scout') , placeholder='Ask Scout…', fid='scout-msg', model='Qwen3-8B · local')}
''', scout_panel))

def review_bar(on, meta='Not a pull request yet · checkpoint 3 · 2 min ago', actions=None, links=('Task.dc.html', 'TaskChanges.dc.html', 'TaskChecks.dc.html'), checks=''):
    names = (('chat', 'Chat'), ('changes', 'Changes'), ('checks', 'Checks' + (f' <span class="dl-meta">{checks}</span>' if checks else '')))
    seg = '<div class="dl-seg">' + ''.join(f'<a href="{h}"{" class=\"on\"" if k == on else ""}>{t}</a>' for (k, t), h in zip(names, links)) + '</div>'
    actions = btn('Update from main') + btn('Publish pull request', 'primary') if actions is None else actions
    return (f'<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 20px 16px">{seg}<span class="dl-meta">{meta}</span>'
            f'<span style="margin-left:auto;display:flex;gap:8px">{actions}</span></div>')

# ---------- Task ----------
task_end = ib('compute', 'Computer use') + ib('more', 'More')
B['Task.dc.html'] = ('work', 'A task, while it runs', app('task', f'''
{head('Self-release pipeline', 'deploy.local · MacBook Pro', task_end)}
{review_bar('chat', 'Running · checkpoint 3 · 2 min ago', btn('Update from main'))}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  {you('Add prepare → verify → activate with rollback for SER releases. Keep deploy-update working. Ask before activating.')}
  <div class="dl-turn">
    {worklog('Worked for 9m', [S('file', 'Read scripts/deploy-update.mjs and server/release/activate.ts'), S('search', 'Searched for releases/ in server', '9 results'), S('edit', 'Edited 4 files', '<span class="dl-add">+178</span> <span class="dl-del">−9</span>'), S('terminal', 'Ran node --test server/release', '18 passed')])}
    {reply('Prepare and verify pass on SER: the new release builds in <code>releases/c41d9e2</code>, and the health check answers before the switch. Rollback keeps earlier releases on disk.')}
    {approval(i('clock', 18), 'How many releases should SER keep?', 'Each release is about 410 MB. Five use about 2 GB and cover a week of daily releases.', btn('Keep 5', 'primary') + btn('Keep 3') + btn('Answer in chat', 'quiet'))}
  </div>
  <div class="dl-turn">{worklog('Waiting for your answer', [], True)}</div>
</div></div></div>
{composer(chip('deploy.local', 'folder') + chip('MacBook Pro', 'compute'), fid='task-msg')}
'''))

# ---------- Task review: Changes / Checks ----------
files = [('scripts/release.mjs', '+68', ''), ('server/release/rollback.ts', '+41', '−6'), ('server/release/activate.ts', '+12', '−3'), ('server/release/rollback.test.ts', '+57', '')]
file_nav = ''.join(f'<a href="#" class="dl-nav"><span class="dl-t dl-mono">{f}</span><span class="dl-end"><span class="dl-add">{a}</span> <span class="dl-del">{d}</span></span></a>' for f, a, d in files)
B['TaskChanges.dc.html'] = ('work', 'A task under review: changes', app('task', f'''
{head('Self-release pipeline', 'deploy.local · MacBook Pro', task_end.replace('class="dl-icon-btn" aria-label="Changes"', 'class="dl-icon-btn on" aria-label="Changes"'))}
{review_bar('changes')}
<div style="flex:1;min-height:0;display:flex;gap:20px;padding:0 20px 20px">
  <nav aria-label="Changed files" class="dl-hide-mid" style="flex:0 0 240px;overflow:auto"><div class="dl-side-label" style="padding-top:0">4 files changed</div>{file_nav}</nav>
  <div style="flex:1;min-width:0;overflow:auto;display:flex;flex-direction:column;gap:16px">
    <section class="dl-source"><div class="dl-source-head"><span class="dl-mono dl-strong">server/release/rollback.ts</span><span class="dl-end"><span><span class="dl-add">+41</span> <span class="dl-del">−6</span></span><a href="#" class="dl-btn quiet">View file</a></span></div>
    {diff([('@', '', '', '@@ -18,6 +18,14 @@ export async function rollback(options) {'),
           (' ', 18, 18, 'const releases = await listReleases(options.root);'),
           ('-', 19, '', 'const previous = releases.at(-2);'),
           ('-', 20, '', "if (!previous) throw new Error('No previous release');"),
           ('+', '', 19, 'const current = await readCurrent(options.root);'),
           ('+', '', 20, 'const previous = releases.filter((r) =&gt; r.id !== current.id).at(-1);'),
           ('+', '', 21, "if (!previous) return { status: 'unavailable' };"),
           (' ', 21, 22, 'await switchCurrent(options.root, previous.id);'),
           ('+', '', 23, 'const healthy = await waitForHealth(options.url, { timeoutMs: 30_000 });'),
           ('+', '', 24, 'if (!healthy) await switchCurrent(options.root, current.id);'),
           (' ', 22, 25, "return { status: 'rolled-back', release: previous.id };")])}</section>
    <section class="dl-source"><div class="dl-source-head"><span class="dl-mono dl-strong">scripts/release.mjs</span><span class="dl-tag">New file</span><span class="dl-end"><span class="dl-add">+68</span></span></div>
    {diff([('+', '', 1, '#!/usr/bin/env node'), ('+', '', 2, "import { prepare, verify, activate } from '../server/release/index.js';"), ('+', '', 3, ''), ('+', '', 4, 'const [command, ...args] = process.argv.slice(2);')])}</section>
  </div>
</div>'''))

checks = [(OK(), 'Unit tests', 'node --test server/release', '18 passed · 4 s', True),
          (OK(), 'Type check', 'pnpm typecheck', 'Passed · 22 s', False),
          (SPIN(), 'Release dry run on SER', 'deploy-update prepare --dry-run', 'Running · 40 s', False)]
B['TaskChecks.dc.html'] = ('work', 'A task under review: checks', app('task', f'''
{head('Self-release pipeline', 'deploy.local · MacBook Pro', task_end)}
{review_bar('checks')}
<div class="dl-scroll"><div class="dl-col" style="padding-top:8px;display:flex;flex-direction:column;gap:16px">
  {group([item(n, f'<span class="dl-mono">{cmd}</span>', ic, c(res)) for ic, n, cmd, res, _ in checks], 'Checkpoint 3', btn('Run again', 'quiet'))}
  <pre class="dl-term">✔ prepare builds into releases/&lt;sha&gt;          812ms
✔ verify waits for /healthz before switching   1204ms
✔ activate keeps earlier releases                96ms
✔ rollback is unavailable without an earlier one 12ms
ℹ tests 18 · pass 18 · fail 0 · 4.1 s</pre>
</div></div>'''))

# ---------- Pull request ----------
pr_panel = f'''<aside class="dl-panel" aria-label="Merge">
  <div class="dl-panel-head">Merge</div>
  <div class="dl-panel-body" style="gap:4px">
    <div class="dl-panel-item">{OK()}<span class="dl-t"><span>Ready to merge</span><span>No conflicts with main</span></span></div>
    <div style="display:flex;flex-direction:column;gap:8px;padding:8px 0 4px">{btn('Merge and release', 'primary')}{btn('Merge only')}</div>
    <div class="dl-panel-label">Checks on this version</div>
    <div class="dl-panel-item">{OK()}<span class="dl-t"><span>Unit tests</span><span>312 passed</span></span></div>
    <div class="dl-panel-item">{OK()}<span class="dl-t"><span>Type check</span><span>Passed</span></span></div>
    <div class="dl-panel-item">{OK()}<span class="dl-t"><span>Repositories suite × 20</span><span>20 of 20 passed</span></span></div>
    <div class="dl-panel-label">Release</div>
    <div class="dl-panel-item">{i('rocket', 14)}<span class="dl-t"><span>Prepare, verify, activate on SER</span><span>Warden watches for 10 min and rolls back on failure</span></span></div>
  </div>
</aside>'''
B['Review.dc.html'] = ('work', 'A pull request, reviewed by an agent', app('pr18', f'''
{head('Stop the repositories cancellation test timing out', 'PR #18 · deploy.local', ib('diff', 'Files') + ib('link', 'Copy link') + ib('more', 'More'), '<span class="dl-glyph plain">' + i('pr', 12) + '</span>')}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  <div class="dl-turn"><div class="dl-who-line">{S_GLYPH}Scout<span class="dl-meta">opened 2 h ago · scout/cancel-timeout → main · <span class="dl-add">+46</span> <span class="dl-del">−12</span></span></div>
    {reply('The cancellation test raced the clone finishing. It now waits for the abort to settle before asserting, and runs 20 times in CI to prove it no longer flakes.')}</div>
  <div class="dl-turn"><div class="dl-who-line"><span class="dl-glyph plain">R</span>GPT-6.1-Sol<span class="dl-meta">reviewed 1 h ago</span></div>
    {reply('One issue: <code>waitForAbort</code> can hang if the clone already finished. Add a timeout.')}
    {worklog('Scout fixed it in 2m', [S('edit', 'Added a 5 s timeout to waitForAbort'), S('terminal', 'Ran the repositories suite 20 times', '20 passed')])}</div>
  {approval(i('merge', 18), 'Merge and release PR #18?', 'Releases to SER with prepare, verify and activate. Warden watches for 10 minutes and rolls back on failure.', btn('Merge and release', 'primary') + btn('Request changes') + btn('Not now', 'quiet'))}
</div></div></div>
{composer(chip('PR #18', 'pr'), fid='pr-msg')}
''', pr_panel))

# ---------- Warden ----------
warden_panel = f'''<aside class="dl-panel" aria-label="Warden is watching">
  <div class="dl-panel-head">Watching</div>
  <div class="dl-panel-body">
    <div class="dl-panel-label">Apps</div>
    <div class="dl-panel-item"><span class="dl-t"><span>home-gym sync</span><span>Worker · 9c3e1fa</span></span>{status('failed', 'Failing')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>home-gym</span><span>Web app · 9c3e1fa</span></span>{status('', 'Healthy')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>Immich</span><span>Memory 92% of 4 GB</span></span>{status('attention', 'High memory')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>deploy.local</span><span>2a91c0e · 6 h</span></span>{status('', 'Healthy')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>recipes</span><span>Stopped by you</span></span>{status('inactive', 'Stopped')}</div>
    <div class="dl-panel-label">Computers</div>
    <div class="dl-panel-item"><span class="dl-t"><span>SER</span><span>Disk 61% · memory 38%</span></span>{status('', 'Online')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>bazzite</span><span>Worker d279f45</span></span>{status('', 'Online')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>MacBook Pro</span><span>Running 1 task</span></span>{status('active', 'Busy')}</div>
  </div>
</aside>'''
B['Warden.dc.html'] = ('work', 'Warden — the ops agent', app('warden', f'''
{head('Warden', 'Watches your apps and computers', ib('eye', 'Watching', True) + ib('settings', 'Tune Warden'), W_GLYPH)}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  <div class="dl-turn">
    {worklog('Worked for 40s · 2:14 PM', [S('pulse', 'home-gym sync: 38% of jobs failing since the 1:58 PM release'), S('logs', 'Read the worker logs on SER and the release diff'), S('team', 'Asked Scout to fix it forward', 'Fix the sync migration')])}
    {reply('Release 9c3e1fa renamed <code>workouts.started</code> to <code>started_at</code>. The web app was updated, but the sync worker still reads the old name, and 1,240 jobs are queued behind it.', 'Scout needs about 20 minutes to fix it forward. Rolling back stops the errors now.')}
    {approval(i('undo', 18), 'Roll back home-gym to 81be0d2?', 'Moves the web app and the sync worker back together and undoes migration 0042. The previous release ran 9 days without errors.', btn('Roll back home-gym', 'primary', 'Rollback.dc.html') + btn('Wait for the fix') + btn('Not now', 'quiet'))}
  </div>
</div></div></div>
{composer(chip('All apps', 'app'), placeholder='Ask Warden…', fid='warden-msg', model='Qwen3-8B · local')}
''', warden_panel))

# ---------- Tune an agent ----------
B['Configure.dc.html'] = ('work', 'Tune an agent', app('scout', f'''
{head('Tune Scout', '', btn('Save', 'primary'), S_GLYPH, True)}
<div class="dl-scroll"><div class="dl-page" style="max-width:768px;gap:32px">
  {section('Instructions', 'What Scout is for and how it works. This is most of its tuning.', '<label for="manual" class="dl-sr">Instructions</label><textarea id="manual" class="dl-textarea" rows="6">Keep deploy.local\'s development loop moving.\n- Each morning, review open gaps, failed checks and last week\'s tasks; propose at most 3 improvements.\n- Turn approved proposals into tasks with a clear brief and tests.\n- Have a different model review every pull request before asking me to merge.\n- Never merge or release without my approval.</textarea>')}
  {section('When Scout works', '', group([f'<div class="dl-inset">{setting("Chat and @Scout mentions", "", sw("Chat"))}{setting("Issues labelled scout", "", sw("Issues"))}{setting("A task finishes, a check fails or a PR conflicts", "", sw("Events"))}{setting("Morning brief", "7:00 AM on weekdays", sw("Brief"))}</div>']))}
  {section('Set elsewhere', 'Shared with every agent, so they are set in one place.', group([item('What Scout may do', '2 allowed · 2 ask you · from the Approvals table', i('shield', 16), '', 'SettingsAgents.dc.html'), item('Which models Scout uses', 'The defaults: Qwen3-8B, Opus, GPT-6.1-Sol', i('chip', 16), '', 'Models.dc.html')]))}
  {section('Learned from you', '', group([item('Run tests without pipes', 'From the PR #15 review', end=btn('Forget', 'quiet')), item('Ask Warden to review anything touching releases', 'From this morning', end=btn('Forget', 'quiet'))]))}
</div></div>'''))
