from shell import *
from b_shots import phone_ui, phone_list_ui, laptop_ui, thumb

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)
TITLE = ('<a href="TaskInfoPhone.dc.html" style="display:flex;flex-direction:column;align-items:center;line-height:1.2"><span>Meal planner</span>'
         '<span style="font-size:12px;line-height:16px;font-weight:400;color:var(--muted)">meal-planner · not released ›</span></a>')
def seg(on):
    tabs_ = (('chat', 'Chat', 'NewProductPhone.dc.html'), ('changes', 'Changes 14', 'ChangesPhone.dc.html'), ('checks', 'Checks', '#'))
    return '<div class="dl-seg" style="display:flex;margin:0 16px 4px">' + ''.join(f'<a href="{h}"{" class=\"on\"" if k == on else ""} style="flex:1;justify-content:center">{t}</a>' for k, t, h in tabs_) + '</div>'

# The whole task on iPhone: same tabs as desktop. Screenshots come when you ask; shipping is yours to start.
SHOTS = ('<div style="display:flex;gap:8px">' + thumb(phone_ui(), 390, 780, 96) + thumb(phone_list_ui(), 390, 780, 96)
         + thumb(laptop_ui(), 1440, 900, 140) + '</div>')
B['NewProductPhone.dc.html'] = ('phone', 'iPhone — a new product as a task: screenshots when you ask', phone(TITLE, f'''
{seg('chat')}
<div class="dl-ph-thread">
  {worklog('Worked for 18m · created meal-planner', [S('edit', 'Wrote 14 files', '<span class="dl-add">+612</span>'), S('terminal', 'Tests and build', '3 passed')])}
  <div class="dl-reply"><p>The first version works: recipes, a week you can drag meals into, and a shopping list.</p></div>
  <div class="dl-you">Show me what it looks like.</div>
  {worklog('Took 3 screenshots · Safari on MacBook Pro', [])}
  {SHOTS}
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Follow up…')))

# Changes on a phone: a file list first; a file opens to a readable, wrapped diff.
files = [('src/routes/week.tsx', '+148', 'New'), ('src/routes/shopping.tsx', '+96', 'New'), ('src/lib/merge-ingredients.ts', '+64', 'New'),
         ('src/routes/recipes.tsx', '+121', 'New'), ('src/db/schema.sql', '+38', 'New'), ('deploy.yaml', '+14', 'New')]
file_rows = ''.join(ph_row(f'<span class="dl-mono" style="font-size:15px">{f.split("/")[-1]}</span>', f.rsplit('/', 1)[0] if '/' in f else 'project root', i('file', 18), f'<span class="dl-add">{a}</span>') for f, a, _ in files)
B['ChangesPhone.dc.html'] = ('phone', 'iPhone — a task\'s changes: files first, diffs one tap away', phone(TITLE, f'''
{seg('changes')}
<div class="dl-ph-label">14 files · <span class="dl-add">+612</span> <span class="dl-del">−0</span> · all new</div>
<div class="dl-ph-group">{file_rows}{ph_row('8 more files', 'tests, styles, config', i('more', 18))}</div>
<div class="dl-ph-label">src/lib/merge-ingredients.ts</div>
<pre class="dl-term wrap" style="margin:0 16px;font-size:12px;line-height:18px"><span class="dl-add">+ export function mergeIngredients(meals) {{</span>
<span class="dl-add">+   const list = new Map();</span>
<span class="dl-add">+   for (const item of meals.flatMap((m) =&gt; m.ingredients)) {{</span>
<span class="dl-add">+     const key = item.name.toLowerCase();</span>
<span class="dl-add">+     list.set(key, add(list.get(key), item));</span></pre>
''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Ask about these changes…')))

# A screenshot, full screen: where it came from, and a way to ask about it.
B['PreviewPhone.dc.html'] = ('phone', 'iPhone — a screenshot full screen, with where it came from', f'''<div class="dl-phone" style="background:#000;color:#fff">
  <header class="dl-ph-top" style="color:#fff">{ph_btn('x', 'Close', 'NewProductPhone.dc.html').replace('dl-ph-btn', 'dl-ph-btn" style="color:#fff')}<span class="dl-t">1 of 3</span>{ph_btn('download', 'Save').replace('dl-ph-btn', 'dl-ph-btn" style="color:#fff')}</header>
  <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center">{thumb(phone_ui(), 390, 780, 300, '', '#')}</div>
  <div style="flex:none;padding:12px 20px 34px;display:flex;flex-direction:column;gap:12px">
    <span style="font-size:13px;line-height:18px;color:#c5c1cc;text-align:center">iPhone size · Safari on MacBook Pro · 2:41 PM · from this task</span>
    <div style="display:flex;justify-content:center;gap:6px"><span style="width:7px;height:7px;border-radius:4px;background:#fff"></span><span style="width:7px;height:7px;border-radius:4px;background:#55525b"></span><span style="width:7px;height:7px;border-radius:4px;background:#55525b"></span></div>
    <a href="MarkupPhone.dc.html" class="dl-btn secondary" style="background:#211f25;color:#fff;border-color:#403d46">Mark up and ask</a>
  </div>
</div>''')
