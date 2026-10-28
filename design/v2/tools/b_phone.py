from shell import *

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)

B['HomePhone.dc.html'] = ('phone', 'iPhone — Work', phone('', f'''
<div class="dl-ph-label">Agents</div>
<div class="dl-ph-group">{ph_row('Scout', 'Working on 2 tasks', S_GLYPH.replace('dl-glyph', 'dl-glyph lg'), '', 'ScoutPhone.dc.html')}{ph_row('Warden', 'Watching 7 apps · 1 failing', W_GLYPH.replace('dl-glyph', 'dl-glyph lg'), '', 'Phone.dc.html')}</div>
<div class="dl-ph-label">Waiting on you · 3</div>
<div class="dl-ph-group">{ph_row('Roll back home-gym?', 'Warden · sync worker failing', ATTN(18), 'now', 'Phone.dc.html')}{ph_row('Merge PR #18', 'Scout · reviewed, 4 checks passed', ATTN(18), '4m', 'ReviewPhone.dc.html')}{ph_row('Keep 3 or 5 releases?', 'Scout · self-release pipeline', ATTN(18), '12m')}</div>
<div class="dl-ph-label">Today</div>
<div class="dl-ph-group">{ph_row('Self-release pipeline', 'Running tests · MacBook Pro', SPIN(18), '12m')}{ph_row('Fix the sync migration', 'Reading migrations · bazzite', SPIN(18), '3m')}{ph_row('Show checks on merged PRs', 'Ready for review', OK(18), '40m')}</div>
''', 'work', '', ph_btn('edit', 'New task', 'Home.dc.html'), 'Work', ph_composer()))

B['ScoutPhone.dc.html'] = ('phone', 'iPhone — Scout', phone('Scout', f'''
<div class="dl-ph-thread">
  {worklog('Worked for 1m · morning brief', [S('pr', 'Reviewed 14 pull requests'), S('pulse', 'Checked SER with Warden')])}
  {reply('PR #17 shipped overnight. Two things need you.')}
  {approval(i('merge', 18), 'Merge PR #18', 'Reviewed by GPT-6.1-Sol. 4 checks passed on this version.', btn('Merge and release', 'primary') + btn('Review', href='ReviewPhone.dc.html') + btn('Not now', 'quiet'))}
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Ask Scout…')))

B['Phone.dc.html'] = ('phone', 'iPhone — Warden', phone('Warden', f'''
<div class="dl-ph-thread">
  {worklog('Worked for 40s · 2:14 PM', [S('pulse', 'home-gym sync: 38% of jobs failing'), S('logs', 'Read worker logs and the release diff')])}
  {reply('The release renamed <code>workouts.started</code>, but the sync worker still reads the old name. Scout is fixing it forward.')}
  {approval(i('undo', 18), 'Roll back home-gym?', 'Both apps go back to 81be0d2 and migration 0042 is undone.', btn('Roll back', 'primary', 'Rollback.dc.html') + btn('Wait for the fix'))}
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Ask Warden…', 'Qwen3-8B')))

B['ReviewPhone.dc.html'] = ('phone', 'iPhone — approve a merge', phone('PR #18', f'''
<div class="dl-ph-thread">
  <div class="dl-reply" style="font-weight:600;font-size:22px;line-height:28px">Stop the repositories cancellation test timing out</div>
  <span class="dl-meta" style="font-size:13px">deploy.local · by Scout · <span class="dl-add">+46</span> <span class="dl-del">−12</span></span>
</div>
<div class="dl-ph-label">Checks on this version</div>
<div class="dl-ph-group">{ph_row('Unit tests', '312 passed', OK(18))}{ph_row('Type check', 'Passed', OK(18))}{ph_row('Repositories suite × 20', '20 of 20 passed', OK(18))}</div>
<div class="dl-ph-label">Review</div>
<div class="dl-ph-group">{ph_row('GPT-6.1-Sol', 'Asked for a timeout · Scout fixed it', '<span class="dl-glyph plain lg">R</span>')}</div>
<div class="dl-ph-label">After merging</div>
<div class="dl-ph-group">{ph_row('Release to SER', 'Warden watches for 10 minutes', i('rocket', 18))}</div>
''', None, BACK('HomePhone.dc.html'), ph_btn('link', 'Copy link'), '', f'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line)">{btn("Merge and release", "primary")}{btn("Request changes")}</div>'))

B['ProjectPhone.dc.html'] = ('phone', 'iPhone — a project', phone('', f'''
<div class="dl-ph-label">Projects</div>
<div class="dl-ph-group">{ph_row('deploy.local', '2 pull requests · app healthy', '<span class="dl-glyph plain lg">' + i('folder', 14) + '</span>', '', 'Project.dc.html')}{ph_row('home-gym', '1 of 2 apps failing · 9c3e1fa', '<span class="dl-glyph plain lg">' + i('folder', 14) + '</span>')}{ph_row('recipes', 'Stopped', '<span class="dl-glyph plain lg">' + i('folder', 14) + '</span>')}</div>
<div class="dl-ph-label">deploy.local</div>
<div class="dl-ph-group">{ph_row('Pull requests', '#18 ready to merge', i('pr', 18), '2')}{ph_row('Issues', '1 being worked on', i('issue', 18), '5')}{ph_row('App', '2a91c0e on SER', i('app', 18), status('', 'Healthy'))}{ph_row('Logs', 'Live', i('logs', 18))}</div>
''', 'projects', '', ph_btn('plus', 'New project'), 'Projects'))

B['ComputePhone.dc.html'] = ('phone', 'iPhone — computers', phone('', f'''
<div class="dl-ph-label">3 online</div>
<div class="dl-ph-group">{ph_row('SER', 'Coordinator · disk 61%', i('compute', 18), status('', 'Online'), 'Computer.dc.html')}{ph_row('MacBook Pro', 'Self-release pipeline', i('compute', 18), status('active', 'Busy'))}{ph_row('bazzite', 'Fix the sync migration', i('compute', 18), status('active', 'Busy'))}</div>
<div class="dl-ph-label">Models</div>
<div class="dl-ph-group">{ph_row('Qwen3-8B', 'Local on SER · free', i('chip', 18))}{ph_row('Claude', '42% of weekly limit', '<span class="dl-glyph plain lg">C</span>')}{ph_row('Codex', '18% of weekly limit', '<span class="dl-glyph plain lg">X</span>')}</div>
''', 'compute', '', ph_btn('plus', 'Add a computer'), 'Computers'))
