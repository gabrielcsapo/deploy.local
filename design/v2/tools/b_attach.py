from shell import *
import b_taskphone

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)
base = b_taskphone.B['NewProductPhone.dc.html'][2]
RADIO = lambda on: f'<span style="width:20px;height:20px;flex:none;box-sizing:border-box;border-radius:10px;border:{"6px solid var(--action)" if on else "1.5px solid var(--line-strong)"}" aria-hidden="true"></span>'

def sheet(body, h=None):
    hh = f'height:{h}px;' if h else ''
    return (f'<div style="position:absolute;inset:0;background:rgba(20,18,26,.32);display:flex;align-items:flex-end">'
            f'<div class="dl-sheet" style="width:100%;{hh}box-sizing:border-box;border-radius:20px 20px 0 0;background:var(--paper);padding:8px 0 30px;display:flex;flex-direction:column;overflow:hidden">'
            f'<span style="align-self:center;width:36px;height:5px;border-radius:3px;background:var(--line-strong);margin-bottom:8px"></span>{body}</div></div>')
over = lambda body: f'<div style="position:relative;width:390px;height:844px;overflow:hidden">{base}{body}</div>'

# ---------- + : photos, camera, files, or something from the project ----------
tile = lambda bg, label: f'<span style="flex:none;width:76px;height:76px;border-radius:10px;background:{bg};display:flex;align-items:flex-end;padding:6px;box-sizing:border-box;font-size:11px;line-height:13px;color:#fff;font-weight:600">{label}</span>'
photos = ''.join(tile(bg, l) for bg, l in (('linear-gradient(135deg,#c98b52,#7a4a24)', 'Recipe card'), ('linear-gradient(135deg,#6f8f5a,#34502a)', 'Fridge list'),
                                          ('linear-gradient(135deg,#d9b38c,#9a6b44)', 'Grocery receipt'), ('linear-gradient(135deg,#8e9aaf,#4c566a)', 'Whiteboard')))
# No photo strip: Photos and Files open the system pickers, so the app only receives what you pick.
attach_body = f'''<div class="dl-ph-group">{ph_row('Photos', 'Only the photos you pick are shared', i('eye', 18))}{ph_row('Take a photo', 'A recipe card, a sketch, a whiteboard', i('app', 18))}{ph_row('Files', 'PDFs, spreadsheets, zips, from Files or iCloud', i('file', 18))}</div>
<div class="dl-ph-group" style="margin-top:12px">{ph_row('A screenshot of the app', 'The task takes it where the app runs', i('globe', 18))}{ph_row('A file from meal-planner', 'Point at code instead of pasting it', i('folder', 18))}</div>
<span class="dl-meta" style="padding:12px 32px 0;font-size:13px;line-height:18px">deploy.local never reads your photo library. It asks for the camera only the first time you take a photo.</span>'''
B['AttachPhone.dc.html'] = ('phone', 'iPhone — + attaches through the system pickers, a screenshot, or a project file', over(sheet(attach_body)))

# ---------- The box with things attached ----------
chip_file = f'<span style="display:inline-flex;align-items:center;gap:8px;height:52px;padding:0 12px;border-radius:10px;background:var(--selection);font-size:13px;line-height:16px">{i("file", 18)}<span style="display:flex;flex-direction:column"><span>grandmas-recipes.pdf</span><span style="color:var(--muted)">2.1 MB · 18 pages</span></span>{i("x", 14)}</span>'
chip_photo = f'<span style="position:relative;display:inline-flex">{tile("linear-gradient(135deg,#c98b52,#7a4a24)", "")}<span style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:10px;background:var(--action);color:var(--on-action);display:inline-flex;align-items:center;justify-content:center">{i("x", 12)}</span></span>'
attached_body = phone(b_taskphone.TITLE, f'''
<div class="dl-ph-thread">
  {worklog('Worked for 18m · created meal-planner', [S('edit', 'Wrote 14 files', '<span class="dl-add">+612</span>')])}
  <div class="dl-reply"><p>The first version works: recipes, a week you can drag meals into, and a shopping list.</p></div>
  <span class="dl-meta" style="font-size:13px">Attachments are saved with this task on the computer it runs on. Only the model you picked sees them, when it reads them.</span>
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '',
    ph_composer('Import these into the recipes', 'Opus', chip_photo + chip_file))
B['AttachedPhone.dc.html'] = ('phone', 'iPhone — a photo and a PDF attached, ready to send', attached_body)

# ---------- The model for this chat ----------
model_rows = (ph_row('Auto', 'Follows Models: Opus writes code, GPT-6.1-Sol reviews', RADIO(True))
              + ph_row('Opus', 'Claude · 42% of this week used', RADIO(False))
              + ph_row('GPT-6.1-Sol', 'Codex · 18% of this week used', RADIO(False))
              + ph_row('Qwen3-8B', 'On SER · free · good for questions, slow for code', RADIO(False)))
model_body = f'''<div style="padding:4px 20px 8px;display:flex;flex-direction:column;gap:2px"><span style="font-size:20px;line-height:26px;font-weight:600">Model for this chat</span>
<span class="dl-meta" style="font-size:13px">Only changes this chat. Defaults live in Computers › Models.</span></div>
<div class="dl-ph-group">{model_rows}</div>
<div class="dl-ph-label">Reviews</div>
<div class="dl-ph-group">{ph_row('Always a different model', 'Pull requests from this chat are reviewed by GPT-6.1-Sol', i('shield', 18))}</div>'''
B['ModelPhone.dc.html'] = ('phone', 'iPhone — the model pill picks the model for this chat', over(sheet(model_body)))
