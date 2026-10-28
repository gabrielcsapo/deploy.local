from shell import *
from b_states import answered

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)
S_LG = S_GLYPH.replace('dl-glyph', 'dl-glyph lg')

# The agent's name is the way into its details; the subtitle says what it is doing.
TITLE = ('<a href="AgentInfoPhone.dc.html" style="display:flex;flex-direction:column;align-items:center;line-height:1.2">'
         '<span>Scout</span><span style="font-size:12px;line-height:16px;font-weight:400;color:var(--muted)">2 tasks running ›</span></a>')
day = lambda t: f'<div style="display:flex;align-items:center;gap:10px;font-size:13px;line-height:18px;color:var(--muted)"><span style="flex:1;height:1px;background:var(--line)"></span>{t}<span style="flex:1;height:1px;background:var(--line)"></span></div>'
brief = lambda t: f'<span class="dl-meta" style="font-size:13px;line-height:18px;font-weight:600;color:var(--ink-soft)">{t}</span>'
task_link = lambda t, sub, g: f'<a href="Task.dc.html" class="dl-ph-group" style="margin:0;display:block">{ph_row(t, sub, g, "", "Task.dc.html")}</a>'

def scout_chat():
    return phone(TITLE, f'''
<div class="dl-ph-thread">
  {day('Yesterday')}
  {worklog('Morning brief · Monday · 2 proposals, both done', [])}
  {day('Today')}
  {brief('Morning brief · Tuesday 7:00 AM')}
  {worklog('Worked for 1m', [S('pr', 'Reviewed 14 pull requests'), S('pulse', 'Checked SER with Warden')])}
  {reply('PR #17 shipped overnight. Two things need you.')}
  {approval(i('merge', 18), 'Merge PR #18', 'Reviewed by GPT-6.1-Sol. 4 checks passed on this version.', btn('Merge and release', 'primary') + btn('Review', href='ReviewPhone.dc.html') + btn('Not now', 'quiet'))}
  {answered(i('idea', 18), 'Start a self-release pipeline?', 'Prepare, verify and activate with rollback, then worker auto-update.', 'You said yes, with Warden reviewing the plan first · 9:15 AM')}
  <span class="dl-meta" style="font-size:13px">Started from this conversation</span>
  {task_link('Self-release pipeline', 'Running tests · MacBook Pro · 12m', SPIN(18))}
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Ask Scout…'))

B['ScoutPhone.dc.html'] = ('phone', 'iPhone — Scout: days, brief headers, and the tasks it started', scout_chat())

# Tap the name: what the agent is doing, when it works next, what it costs and may do.
info = f'''<div style="position:absolute;inset:0;background:rgba(20,18,26,.32);display:flex;align-items:flex-end">
<div class="dl-sheet" style="width:100%;height:760px;box-sizing:border-box;border-radius:20px 20px 0 0;background:var(--paper);padding:8px 0 24px;display:flex;flex-direction:column;gap:4px;overflow:hidden">
  <span style="align-self:center;width:36px;height:5px;border-radius:3px;background:var(--line-strong)"></span>
  <div style="display:flex;align-items:center;gap:12px;padding:12px 20px 4px">{S_LG}<span style="display:flex;flex-direction:column;flex:1"><span style="font-size:20px;line-height:26px;font-weight:600">Scout</span><span class="dl-meta" style="font-size:13px">Keeps deploy.local moving · active</span></span>{btn('Tune', 'secondary', 'Configure.dc.html').replace('dl-btn secondary', 'dl-btn secondary" style="width:auto;height:36px;font-size:15px')}</div>
  <div class="dl-ph-label">Doing now</div>
  <div class="dl-ph-group">{ph_row('Self-release pipeline', 'MacBook Pro · 12m', SPIN(18), '', 'Task.dc.html')}{ph_row('Fix the sync migration', 'bazzite · 3m', SPIN(18))}</div>
  <div class="dl-ph-label">Watching</div>
  <div class="dl-ph-group">{ph_row('Merged PRs don\'t show checks', 'Issue · task ready for review', i('eye', 18))}{ph_row('Two ways to launch the bazzite app', 'Waiting for your answer', i('eye', 18))}</div>
  <div class="dl-ph-label">About Scout</div>
  <div class="dl-ph-group">{ph_row('Next', 'Morning brief tomorrow at 7:00 AM', i('clock', 18))}{ph_row('Models', 'Opus to code · GPT-6.1-Sol to review · 38% of Claude this week', i('chip', 18), '', 'Models.dc.html')}{ph_row('May do', '2 allowed · 2 ask you', i('shield', 18), '', 'SettingsAgents.dc.html')}{ph_row('Learned', '2 things from your reviews', i('star', 18), '', 'Configure.dc.html')}</div>
</div></div>'''
B['AgentInfoPhone.dc.html'] = ('phone', 'iPhone — tap the agent\'s name for what it is doing and may do', f'<div style="position:relative;width:390px;height:844px;overflow:hidden">{scout_chat()}{info}</div>')

# ⋯ is actions only.
mi = lambda icon, t, danger=False: f'<div style="display:flex;align-items:center;gap:12px;padding:11px 16px;font-size:17px;line-height:22px;{"color:var(--danger);" if danger else ""}border-bottom:1px solid var(--line)"><span style="flex:1">{t}</span>{i(icon, 18)}</div>'
menu = f'''<div style="position:absolute;inset:0;background:rgba(20,18,26,.12)">
<div class="dl-sheet" style="position:absolute;top:96px;right:12px;width:250px;border-radius:14px;background:var(--surface);box-shadow:var(--shadow-xl);overflow:hidden">
  {mi('search', 'Search this conversation')}{mi('bell', 'Mute for 1 hour')}{mi('settings', 'Tune Scout')}{mi('link', 'Copy link')}
  <div style="height:8px;background:var(--selection)"></div>
  <div style="display:flex;align-items:center;gap:12px;padding:11px 16px;font-size:17px;line-height:22px;color:var(--danger)"><span style="flex:1">Pause Scout</span>{i('stop', 18)}</div>
</div></div>'''
B['AgentMenuPhone.dc.html'] = ('phone', 'iPhone — ⋯ holds actions: search, mute, tune, link, pause', f'<div style="position:relative;width:390px;height:844px;overflow:hidden">{scout_chat()}{menu}</div>')
