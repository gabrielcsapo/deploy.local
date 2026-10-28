from shell import *
from b_work import review_bar
from b_shots import phone_ui, phone_list_ui, laptop_ui, thumb

B = {}
# A chat that isn't an agent is a task. Its context (project and repository, computer and model,
# changed files, checks, screenshots, releases) sits beside it on desktop and behind its title on iPhone.
# Shipping is yours to start: the task never asks, it only offers Ship… where you can reach it.
CTX = [
    ('Project', [(i('folder', 14), 'meal-planner', 'Web app · created by this task'), (i('branch', 14), 'deploy.local/meal-planner.git', 'main · 3 commits')]),
    ('Running on', [(i('compute', 14), 'MacBook Pro', 'Opus · 6% of Claude so far')]),
    ('Work', [(i('diff', 14), '14 files changed', '<span class="dl-add">+612</span> <span class="dl-del">−0</span> · Changes'), (OK(14), '3 checks passed', 'Unit tests, type check, build')]),
    ('Screenshots', [(i('eye', 14), '3 screenshots', 'Asked for at 2:41 PM · Safari on MacBook Pro')]),
    ('Releases', [(i('rocket', 14), 'None yet', 'Ship it whenever you are ready')]),
]
panel_body = ''.join(f'<div class="dl-panel-label">{lab}</div>' + ''.join(f'<div class="dl-panel-item">{ic}<span class="dl-t"><span>{t}</span><span>{s}</span></span></div>' for ic, t, s in rows) for lab, rows in CTX)
task_panel = f'''<aside class="dl-panel" aria-label="This task">
  <div class="dl-panel-head">This task<span class="dl-end">{ib('x', 'Close')}</span></div>
  <div class="dl-panel-body">{panel_body}
    <div class="dl-panel-label">Started</div>
    <div class="dl-panel-item">{i('clock', 14)}<span class="dl-t"><span>By you, 20 min ago</span><span>From New task, no agent</span></span></div>
  </div>
</aside>'''
shots = (f'<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">'
         f'{thumb(phone_ui(), 390, 780, 96, "iPhone size")}{thumb(phone_list_ui(), 390, 780, 96, "Shopping list")}{thumb(laptop_ui(), 1440, 900, 300, "Laptop · 1440 wide")}</div>'
         '<span class="dl-meta">Screenshots come from where the app runs: a browser for web apps, Simulator for iPhone apps, the window for Mac apps.</span>')
today = [('Meal planner', 'NewProduct.dc.html', 'mealplan', 'spin', '20m')] + TODAY
B['NewProduct.dc.html'] = ('work', 'A new product from a plain chat: screenshots when you ask, Ship… when you decide', app('mealplan', f'''
{head('Meal planner', 'meal-planner · MacBook Pro', btn('Ship…') + ib('panel', 'This task', True) + ib('more', 'More'))}
{review_bar('chat', 'Not released yet · 20 min', btn('Update from main'), ('NewProduct.dc.html', '#', '#'), '3 passed')}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  {you('Build a small meal-planning app for my family: recipes, a plan for the week, and a shopping list from the plan.')}
  <div class="dl-turn">
    {worklog('Worked for 18m', [S('folder', 'Created the meal-planner project and repository'), S('edit', 'Wrote 14 files', '<span class="dl-add">+612</span>'), S('terminal', 'Ran tests and a build', '3 passed')])}
    {reply('The first version works: recipes, a week view you can drag meals into, and a shopping list that merges ingredients.')}
  </div>
  {you('Show me what it looks like on a phone and on a laptop.')}
  <div class="dl-turn">
    {worklog('Worked for 40s', [S('globe', 'Opened it in Safari on MacBook Pro'), S('eye', 'Took 3 screenshots', '390 and 1440 wide')])}
    {shots}
  </div>
</div></div></div>
{composer(chip('meal-planner', 'folder') + chip('MacBook Pro', 'compute'), fid='meal-msg')}
''', task_panel, today=today))

# iPhone: tap the task's title for the same context, with Ship… at the bottom.
rows_ph = lambda rows: ''.join(ph_row(t, s, ic.replace('width="14" height="14"', 'width="18" height="18"')) for ic, t, s in rows)
ph_title = ('<span style="display:flex;flex-direction:column;align-items:center;line-height:1.2"><span>Meal planner</span>'
            '<span style="font-size:12px;line-height:16px;font-weight:400;color:var(--muted)">meal-planner · not released ›</span></span>')
chat_ph = phone(ph_title, f'''
<div class="dl-ph-thread">
  <div class="dl-you">Build a small meal-planning app for my family: recipes, a plan for the week, and a shopping list.</div>
  {worklog('Worked for 18m', [S('folder', 'Created meal-planner'), S('edit', 'Wrote 14 files', '+612')])}
</div>''', None, ph_btn('back', 'Back', 'HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Follow up…'))
sheet_rows = ''.join(f'<div class="dl-ph-label">{lab}</div><div class="dl-ph-group">{rows_ph(rows)}</div>' for lab, rows in CTX)
sheet = f'''<div style="position:absolute;inset:0;background:rgba(20,18,26,.32);display:flex;align-items:flex-end">
<div class="dl-sheet" style="width:100%;height:790px;box-sizing:border-box;border-radius:20px 20px 0 0;background:var(--paper);padding:8px 0 24px;display:flex;flex-direction:column;overflow:hidden">
  <span style="align-self:center;width:36px;height:5px;border-radius:3px;background:var(--line-strong)"></span>
  <div style="display:flex;align-items:center;gap:12px;padding:12px 20px 0"><span style="display:flex;flex-direction:column;flex:1"><span style="font-size:20px;line-height:26px;font-weight:600">Meal planner</span><span class="dl-meta" style="font-size:13px">Task · started by you 20 min ago · no agent</span></span></div>
  {sheet_rows}
  <div style="padding:16px 16px 0">{btn('Ship…').replace('class="dl-btn secondary"', 'class="dl-btn secondary" style="width:100%;height:44px;font-size:17px;border-radius:12px"')}</div>
</div></div>'''
B['TaskInfoPhone.dc.html'] = ('phone', 'iPhone — tap a task\'s title for its project, files, screenshots, and Ship…', f'<div style="position:relative;width:390px;height:844px;overflow:hidden">{chat_ph}{sheet}</div>')
