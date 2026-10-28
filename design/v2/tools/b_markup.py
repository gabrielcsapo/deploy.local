from shell import *
from b_shots import phone_ui, laptop_ui, thumb
from b_work import review_bar
import b_taskctx

B = {}
INK = '#e5484d'
HAND = 'font-family:"Marker Felt","Comic Sans MS",cursive;font-weight:700'

# Markup is drawn in the screenshot's own pixels, so it scales with the image wherever it is shown.
def marks(w):
    s = w / 390
    return (f'<svg width="{w}" height="{round(780 * s)}" viewBox="0 0 390 780" style="position:absolute;inset:0;pointer-events:none" aria-hidden="true">'
            f'<ellipse cx="190" cy="252" rx="186" ry="34" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round" transform="rotate(-2 190 252)"/>'
            f'<path d="M60 452 Q 190 446 330 454" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>'
            f'<path d="M250 520 L 210 470 M210 470 L 214 492 M210 470 L 232 476" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<text x="168" y="314" fill="{INK}" stroke="#fff" stroke-width="8" paint-order="stroke" style="{HAND}" font-size="30">pick-up night!</text>'
            f'<text x="70" y="570" fill="{INK}" stroke="#fff" stroke-width="8" paint-order="stroke" style="{HAND}" font-size="32">show the count first</text></svg>')

def marked(w, label='', href='#'):
    return f'<span style="position:relative;display:inline-block">{thumb(phone_ui(), 390, 780, w, label, href)}<span style="position:absolute;left:0;top:0">{marks(w)}</span></span>'

# ---------- iPhone: draw on the screenshot, then say what you want ----------
dot = lambda c, on=False: f'<span style="width:22px;height:22px;border-radius:11px;background:{c};box-shadow:{"0 0 0 2px #000,0 0 0 4px #fff" if on else "none"}"></span>'
TEXT_GLYPH = '<span style="font-size:17px;font-weight:600;letter-spacing:-.02em">Aa</span>'
ARROW_GLYPH = '<span style="display:inline-flex;transform:rotate(45deg)">' + i('up', 20) + '</span>'
def tool(glyph, label, on=False):
    st = 'background:#fff;color:#000' if on else 'color:#fff'
    g = glyph if glyph.startswith('<') else i(glyph, 20)
    return (f'<span style="display:flex;flex-direction:column;align-items:center;gap:2px;width:52px"><span style="width:40px;height:40px;border-radius:20px;display:inline-flex;align-items:center;justify-content:center;{st}">{g}</span>'
            f'<span style="font-size:11px;line-height:14px;color:#c5c1cc">{label}</span></span>')
def toolbar(active):
    tools = [('edit', 'Pen'), (ARROW_GLYPH, 'Arrow'), (TEXT_GLYPH, 'Text'), ('undo', 'Undo')]
    return ('<div style="flex:none;display:flex;align-items:center;justify-content:center;gap:4px;padding:8px 12px">'
            + ''.join(tool(g, l, l == active) for g, l in tools) + '<span style="width:8px"></span>'
            + dot(INK, True) + dot('#f5c518') + dot('#4c8dff') + '</div>')
B['MarkupPhone.dc.html'] = ('phone', 'iPhone — draw on a screenshot to point things out', f'''<div class="dl-phone" style="background:#000;color:#fff">
  <header class="dl-ph-top" style="color:#fff"><span style="padding:0 12px;font-size:17px">Cancel</span><span class="dl-t">Mark up</span><span style="padding:0 12px;font-size:17px;font-weight:600">Done</span></header>
  <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center">{marked(270)}</div>
  {toolbar('Pen')}
  <div style="flex:none;margin:6px 12px 26px;display:flex;align-items:center;gap:8px;min-height:48px;box-sizing:border-box;padding:6px 6px 6px 8px;border-radius:24px;background:#211f25;border:1px solid #403d46">
    <span style="flex:none">{thumb(phone_ui(), 390, 780, 28)}</span>
    <span style="flex:1;font-size:16px;line-height:22px;color:#f3f2f5">Make Wednesday pick-up night, and put the item count before the button</span>
    <span class="dl-send" style="width:36px;height:36px" aria-hidden="true">{i('up', 18, 2)}</span>
  </div>
</div>''')

# ---------- iPhone: it arrives in the task as your message, markup and all ----------
TITLE = ('<span style="display:flex;flex-direction:column;align-items:center;line-height:1.2"><span>Meal planner</span>'
         '<span style="font-size:12px;line-height:16px;font-weight:400;color:var(--muted)">meal-planner · not released ›</span></span>')
B['MarkupSentPhone.dc.html'] = ('phone', 'iPhone — the marked-up screenshot is part of your message', phone(TITLE, f'''
<div class="dl-ph-thread">
  <div style="align-self:flex-end;display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:85%">
    {marked(150)}
    <div class="dl-you" style="margin:0">Make Wednesday pick-up night, and put the item count before the button</div>
  </div>
  {worklog('Working from your markup · 30s', [S('eye', 'Read your 2 marks', 'Wednesday row · list button'), S('edit', 'Editing src/routes/week.tsx', '')], True)}
  <span class="dl-meta" style="font-size:13px">It will reply with new screenshots when you ask, or when the change is done if you said so.</span>
</div>''', None, ph_btn('back', 'Back', 'NewProductPhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Follow up…')))

# ---------- Desktop: the same tools in the screenshot viewer ----------
def dtool(icon, label, on=False):
    return f'<span class="dl-icon-btn{" on" if on else ""}" title="{label}" aria-label="{label}">{i(icon, 16)}</span>'
viewer = f'''<div class="dl-dialog dl-sheet" role="dialog" aria-label="Mark up screenshot" style="max-width:760px;padding:0;gap:0;overflow:hidden">
  <div style="display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line)">
    <span class="dl-strong" style="font-weight:600;margin-right:8px">Mark up</span>{dtool('edit', 'Pen', True)}{dtool('right', 'Arrow')}{dtool('app', 'Box')}<span class="dl-icon-btn" title="Text" aria-label="Text"><span style="font-size:14px;font-weight:600">Aa</span></span>{dtool('undo', 'Undo')}
    <span style="display:flex;gap:6px;margin-left:8px">{dot(INK, True).replace('#000', 'var(--surface)').replace('#fff', 'var(--ink)')}{dot('#f5c518')}{dot('#4c8dff')}</span>
    <span class="dl-meta" style="margin-left:auto">1 of 3 · iPhone size · Safari on MacBook Pro</span>{ib('x', 'Close')}
  </div>
  <div style="display:flex;justify-content:center;padding:20px;background:var(--selection)">{marked(260)}</div>
  <div style="padding:12px;border-top:1px solid var(--line)"><div class="dl-composer" style="margin:0"><input type="text" value="Make Wednesday pick-up night, and put the item count before the button" aria-label="Message"><div class="dl-composer-bar"><span class="dl-chip">{i('eye', 14)}Screenshot with 2 marks</span><span class="dl-grow"></span><button type="button" class="dl-send" aria-label="Send">{i('up', 16, 2)}</button></div></div></div>
</div>'''
base = b_taskctx.B['NewProduct.dc.html'][2]
B['MarkupDesktop.dc.html'] = ('work', 'Desktop — mark up a screenshot in the viewer, then send it to the task', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{base}
<div class="dl-scrim" style="align-items:flex-start;padding-top:40px">{viewer}</div></div>''')

# ---------- iPhone: type a note onto the screenshot ----------
def typing(w):
    s = w / 390
    box = (f'<span style="position:absolute;left:{round(40 * s)}px;top:{round(600 * s)}px;max-width:{round(300 * s)}px;padding:{round(8 * s)}px {round(12 * s)}px;'
           f'border-radius:{round(10 * s)}px;border:{max(1, round(3 * s))}px dashed {INK};background:rgba(255,255,255,.92);color:{INK};{HAND};font-size:{round(30 * s)}px;line-height:1.2">'
           f'needs a "pick-up" tag on the card<span style="display:inline-block;width:2px;height:1em;background:{INK};vertical-align:-0.15em;margin-left:2px"></span></span>')
    return f'<span style="position:relative;display:inline-block">{marked(w)}{box}</span>'
B['MarkupTextPhone.dc.html'] = ('phone', 'iPhone — type a note right onto the screenshot', f'''<div class="dl-phone" style="background:#000;color:#fff">
  <header class="dl-ph-top" style="color:#fff"><span style="padding:0 12px;font-size:17px">Cancel</span><span class="dl-t">Mark up</span><span style="padding:0 12px;font-size:17px;font-weight:600">Done</span></header>
  <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center">{typing(210)}</div>
  {toolbar('Text')}
  <div style="flex:none;display:flex;align-items:center;justify-content:center;gap:16px;padding:0 12px 8px;font-size:13px;color:#c5c1cc"><span style="font-weight:600;color:#fff">Small</span><span>Large</span><span>·</span><span>On a white label</span></div>
  <div style="flex:none;height:250px;background:#2b2a30;display:flex;align-items:center;justify-content:center;color:#77727f;font-size:13px">Keyboard</div>
</div>''')
