from shell import *

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)
W_LG = W_GLYPH.replace('dl-glyph', 'dl-glyph lg')

# The Work tab's box goes to Scout by default. A question gets an answer in place;
# a request to change something becomes a task on a free computer. @Warden or @Keeper picks the agent.
pchip = lambda icon, text: f'<span class="dl-chip" style="height:32px;font-size:15px">{i(icon, 16)}{text}{i("chev", 12)}</span>'
compose = f'''<div style="position:absolute;inset:0;background:rgba(20,18,26,.32);display:flex;align-items:flex-end">
<div class="dl-sheet" style="width:100%;box-sizing:border-box;border-radius:20px 20px 0 0;background:var(--surface);padding:8px 16px 16px;display:flex;flex-direction:column;gap:12px">
  <span style="align-self:center;width:36px;height:5px;border-radius:3px;background:var(--line-strong)"></span>
  <div style="font-size:17px;line-height:24px;min-height:96px">Make the home-gym sync worker read started_at, and add a test that runs it against the migrated schema<span style="display:inline-block;width:2px;height:20px;background:var(--accent);vertical-align:-4px;margin-left:1px"></span></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">{pchip('folder', 'home-gym')}{pchip('compute', 'Any free computer')}</div>
  <div style="display:flex;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:10px">
    <a href="AttachPhone.dc.html" class="dl-ph-btn" style="width:32px;height:32px;margin-left:-8px" aria-label="Attach">{i('plus', 20)}</a>
    <span class="dl-meta" style="font-size:13px;flex:1">To Scout · it will start a task</span>
    <a href="ModelPhone.dc.html" style="display:inline-flex;align-items:center;gap:2px;font-size:13px;color:var(--muted)">Auto{i('chev', 12)}</a>
    <span class="dl-ph-btn">{i('mic', 22)}</span>
    <span class="dl-send" style="width:36px;height:36px" aria-hidden="true">{i('up', 18, 2)}</span>
  </div>
  <div style="height:236px;margin:0 -16px -16px;background:var(--selection);display:flex;align-items:center;justify-content:center" class="dl-meta">Keyboard</div>
</div></div>'''
work_bg = phone('', f'''
<div class="dl-ph-label">Waiting on you · 3</div>
<div class="dl-ph-group">{ph_row('Roll back home-gym?', 'Warden · sync worker failing', ATTN(18), 'now')}{ph_row('Merge PR #18', 'Scout · reviewed', ATTN(18), '4m')}</div>
''', 'work', '', ph_btn('edit', 'New task'), 'Work', ph_composer())
B['ComposePhone.dc.html'] = ('phone', 'iPhone — asking for work: one box, with project and computer', f'<div style="position:relative;width:390px;height:844px;overflow:hidden">{work_bg}{compose}</div>')

# A request to change code becomes a task, and the phone follows it.
seg = '<div class="dl-seg" style="display:flex;margin:0 16px"><a class="on" style="flex:1;justify-content:center">Chat</a><a style="flex:1;justify-content:center">Changes</a><a style="flex:1;justify-content:center">Checks</a></div>'
B['TaskPhone.dc.html'] = ('phone', 'iPhone — the request is now a task running on bazzite', phone('Fix the sync worker', f'''
{seg}
<div class="dl-ph-thread">
  <div class="dl-you">Make the home-gym sync worker read started_at, and add a test that runs it against the migrated schema</div>
  {worklog('Working on bazzite · Codex · 1m', [S('file', 'Read src/sync/workouts.ts and migration 0042'), S('edit', 'Edited src/sync/workouts.ts', '<span class="dl-add">+6</span> <span class="dl-del">−6</span>'), S('terminal', 'Running pnpm test src/sync', '')], True)}
  <span class="dl-meta" style="font-size:13px">You'll hear back when the pull request is ready, or sooner if Scout needs you. Nothing ships without your merge.</span>
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Follow up…')))

# A question is answered in place, by whichever agent knows; nothing runs on a computer.
B['AskPhone.dc.html'] = ('phone', 'iPhone — a question gets an answer, not a task', phone('Warden', f'''
<div class="dl-ph-thread">
  <div class="dl-you">Why is Immich using so much memory?</div>
  {worklog('Worked for 8s', [S('pulse', 'Read Immich memory for the last 24 hours'), S('logs', 'Checked its jobs')])}
  <div class="dl-reply"><p>A face-detection job started at 2:10 PM on 1,900 new photos. It holds about 3.5 GB until it finishes, in roughly 40 minutes.</p><p>Memory goes back to about 1.2 GB afterwards. If you import this many again, 6 GB avoids the warning.</p></div>
  {approval(i('chip', 18), 'Raise Immich to 6 GB?', 'SER has 28 GB free. Immich restarts once, for about 30 seconds.', btn('Raise to 6 GB', 'primary') + btn('Not now'))}
  <span class="dl-meta" style="font-size:13px">Answered by Warden because it watches running apps · Qwen3-8B on SER · free</span>
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Follow up…', 'Qwen3-8B')))
