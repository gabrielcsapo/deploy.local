from shell import *
from b_overview import sheet
from flows import FLOWS, PLATFORMS
import b_taskctx, b_taskphone

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)
APPG = '<span class="dl-glyph plain">' + i('app', 12) + '</span>'
WAIT = lambda: f'<span style="display:inline-flex;color:var(--muted)">{i("clock", 14)}</span>'

def ship_body(phone=False):
    seg = '<div class="dl-seg"><a>Just me</a><a class="on">Everyone at home</a></div>'
    rows = (setting('Runs on', 'Runs apps · 28 GB memory free', 'SER') + setting('Address', 'Gets a certificate from SER', '<span class="dl-mono">meal-planner.deploy.local</span>')
            + setting('Who can open it', '', seg) + setting('Data', 'A new Postgres on SER, backed up nightly', 'New'))
    steps_ = ''.join(f'<li class="dl-step"><span class="dl-i">{i(ic, 14)}</span><span class="dl-t">{t}</span></li>' for ic, t in
                     (('rocket', 'Prepare the release from main · 3 commits'), ('shield', 'Verify it on a copy, then switch'), ('pulse', 'Warden watches it for 10 minutes')))
    return (f'<p class="dl-soft" style="margin:0">The first release of meal-planner. After this, changes arrive as pull requests you merge.</p>'
            f'{group(["<div class=\"dl-inset\">" + rows + "</div>"])}<ul class="dl-steps" style="margin-left:4px">{steps_}</ul>')

# ---------- Ship: started by you, from the task header or its info sheet ----------
base = b_taskctx.B['NewProduct.dc.html'][2]
B['ShipDialog.dc.html'] = ('ship', 'Ship… opens this: where it runs, its address, who can open it', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{base}
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="Ship meal planner" style="max-width:560px">
  <div class="dl-dialog-head"><h2>Ship meal planner</h2>{ib('x', 'Close')}</div>
  {ship_body()}
  <div class="dl-dialog-foot">{btn('Cancel', 'quiet')}{btn('Ship', 'primary')}</div>
</div></div></div>''')

phone_base = b_taskphone.B['NewProductPhone.dc.html'][2]
B['ShipPhone.dc.html'] = ('phone', 'iPhone — Ship… from the task: the same choices in a sheet', f'''<div style="position:relative;width:390px;height:844px;overflow:hidden">{phone_base}
<div style="position:absolute;inset:0;background:rgba(20,18,26,.32);display:flex;align-items:flex-end">
<div class="dl-sheet" style="width:100%;box-sizing:border-box;border-radius:20px 20px 0 0;background:var(--paper);padding:8px 16px 30px;display:flex;flex-direction:column;gap:12px">
  <span style="align-self:center;width:36px;height:5px;border-radius:3px;background:var(--line-strong)"></span>
  <span style="font-size:20px;line-height:26px;font-weight:600">Ship meal planner</span>
  {ship_body(True)}
  {btn('Ship', 'primary').replace('class="dl-btn primary"', 'class="dl-btn primary" style="width:100%;height:44px;font-size:17px;border-radius:12px"')}
</div></div></div>''')

# ---------- iPhone: a release in progress ----------
B['ReleasePhone.dc.html'] = ('phone', 'iPhone — a release in progress, steps as they happen', phone('deploy.local releases', f'''
<div style="padding:0 16px">{approval(SPIN(18), 'Verifying 7f3b2d4', 'You merged PR #18 at 2:41 PM · 52 s so far', '')}</div>
<div style="padding:4px 20px 0"><ul class="dl-steps">{''.join(f'<li class="dl-step"><span class="dl-i">{ic}</span><span class="dl-t">{t}</span></li>' for ic, t in ((OK(14), 'Prepared · 41 s'), (SPIN(14), 'Verifying on SER'), (WAIT(), 'Activate'), (WAIT(), 'Watch for 10 minutes')))}</ul></div>
<div class="dl-ph-label">In this release</div>
<div class="dl-ph-group">{ph_row('Coordinator', 'SER · 2a91c0e → 7f3b2d4', i('app', 18), 'First')}{ph_row('Task workers', 'MacBook Pro and bazzite', i('compute', 18), 'When idle')}</div>
<div class="dl-ph-label">Earlier</div>
<div class="dl-ph-group">{ph_row('2a91c0e', 'Live · 6 h ago', i('rocket', 18))}{ph_row('0d96f82', 'Yesterday · PR #17', i('rocket', 18))}</div>
''', 'projects', BACK('ProjectPhone.dc.html'), '', '', f'<div style="padding:12px 16px">{btn("Stop before activating")}</div>'))

# ---------- iPhone: a sick worker ----------
warn = f'<span style="display:inline-flex;color:var(--warning)">{i("refresh", 18)}</span>'
B['WorkerPhone.dc.html'] = ('phone', 'iPhone — a sick worker: what health means without an address', phone('home-gym sync', f'''
<div style="padding:0 20px 4px;display:flex;align-items:center;gap:8px">{status('failed', 'Failing')}<span class="dl-meta" style="font-size:13px">Worker · part of home-gym · 9c3e1fa</span></div>
<div class="dl-ph-label">Health</div>
<div class="dl-ph-group">{ph_row('Jobs', '38% failing · usually under 1%', FAIL(18))}{ph_row('Queue', '1,240 waiting · oldest 14 min', FAIL(18))}{ph_row('Process', 'Restarted 3 times in 10 min', warn)}{ph_row('Heartbeat', 'Last seen 4 s ago', OK(18))}</div>
<div class="dl-ph-label">Release 9c3e1fa · both apps</div>
<div class="dl-ph-group">{ph_row('home-gym', 'Web app', i('app', 18), status('', 'Healthy'))}{ph_row('home-gym sync', 'This worker', i('app', 18), status('failed', 'Failing'))}{ph_row('Migration 0042', 'Renamed workouts.started', i('file', 18), 'Applied')}</div>
''', 'live', BACK('LivePhone.dc.html'), ph_btn('more', 'More'), '', f'<div style="padding:12px 16px">{btn("Roll back home-gym…", "primary", "RollbackPhone.dc.html")}</div>'))

# ---------- Coverage: every step, every platform ----------
TAG = {'design': '<span class="dl-tag">By design</span>', 'later': '<span class="dl-tag" style="background:color-mix(in srgb,var(--warning) 14%,transparent);color:var(--warning)">Later</span>'}
def cell(step, key):
    boards = step.get(key, [])
    if boards:
        return f'<span style="display:inline-flex;align-items:center;gap:6px;color:var(--success)">{i("check", 14, 2)}<span style="color:var(--ink)">{len(boards)}</span></span>'
    g = step.get('gaps', {}).get(key)
    return TAG.get(g, '<span class="dl-meta">—</span>')
TD = 'style="height:auto;padding:7px 16px;white-space:normal"'
rows = ''
n_steps = n_boards = n_later = 0
for pid, pname, steps in FLOWS:
    if pid == 'overview':
        continue
    rows += f'<tr><td colspan="5" style="height:auto;padding:12px 16px 6px;background:var(--paper)"><span class="dl-strong">{pname}</span></td></tr>'
    for label, step in steps:
        n_steps += 1
        n_boards += sum(len(step.get(k, [])) for k, _ in PLATFORMS)
        n_later += sum(1 for v in step.get('gaps', {}).values() if v == 'later')
        rows += f'<tr><td {TD}>{label}</td>' + ''.join(f'<td {TD}>{cell(step, k)}</td>' for k, _ in PLATFORMS) + '</tr>'
head_row = '<tr><th>Step</th>' + ''.join(f'<th style="width:150px">{n}</th>' for _, n in PLATFORMS) + '</tr>'
B['Coverage.dc.html'] = ('overview', 'Coverage: every step on every platform', sheet(1440, 1860, f'''
<div class="dl-t" style="display:flex;flex-direction:column;gap:8px"><span class="dl-meta">Coverage</span><h1 class="dl-title" style="font-size:40px;line-height:44px;letter-spacing:-.02em">Every step, side by side.</h1>
<span class="dl-soft" style="font-size:15px;line-height:24px;max-width:860px">{n_steps} steps in {len(FLOWS) - 2} flows, drawn on {n_boards} boards. Each canvas page is one flow; each row is one step, with the web app, iPhone, desktop app and CLI next to each other. On the public site, the iPhone column is the same pages in Safari. By design means deliberately left to a computer: joining a computer, screen use, secrets, adding and removing computers. Later means not needed for v2.</span></div>
<div class="dl-table-wrap dl-group"><table class="dl-table" style="table-layout:fixed"><thead>{head_row}</thead><tbody>{rows}</tbody></table></div>'''), 1440, 1860)
