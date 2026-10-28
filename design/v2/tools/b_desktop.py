from shell import *
import b_live

B = {}

# Desktop shell (Electron on Mac, Linux, Windows): the window loads deploy.local from your
# coordinator; the shell adds the tray, notifications, the bundled worker and the control helper.
# The dk-* classes draw the operating system around it and are not part of the design system.
CSS = '''<style>
.dk-desk{position:relative;width:100%;height:100vh;min-height:560px;overflow:hidden;font-family:var(--font-sans);color:var(--ink);background:linear-gradient(160deg,#e3e5ec 0%,#d2d6df 55%,#c4cad5 100%)}
.dk-desk.linux{background:linear-gradient(160deg,#2b2a33 0%,#22212a 60%,#1b1a21 100%)}
.dk-bar{position:absolute;top:0;left:0;right:0;height:30px;display:flex;align-items:center;gap:18px;padding:0 14px;font-size:13px;line-height:20px;background:rgba(246,246,248,.74);backdrop-filter:blur(20px);border-bottom:1px solid rgba(0,0,0,.06);z-index:3}
.dk-bar b{font-weight:600}
.dk-bar .dl-end{margin-left:auto;display:flex;align-items:center;gap:14px;color:var(--ink)}
.dk-tray{position:relative;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 6px;border-radius:6px;font-weight:600}
.dk-tray.on{background:rgba(0,0,0,.1)}
.dk-tray-mark{width:15px;height:15px;border-radius:4px;border:1.5px solid currentColor;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;font-size:9px;line-height:1;font-weight:700}
.dk-tray-dot{position:absolute;top:2px;left:16px;width:6px;height:6px;border-radius:3px;background:var(--danger);box-shadow:0 0 0 1.5px #eceef2}
.dk-win{position:absolute;border-radius:12px;overflow:hidden;background:var(--paper);box-shadow:0 0 0 1px rgba(0,0,0,.08),0 24px 64px -16px rgba(20,18,26,.35)}
.dk-win .dl-app{height:100%;min-height:0}
.dk-win .dl-side-top{padding-left:84px}
.dk-lights{position:absolute;top:18px;left:18px;display:flex;gap:8px;z-index:2}
.dk-lights span{width:12px;height:12px;border-radius:6px;background:#ff5f57}
.dk-lights span:nth-child(2){background:#febc2e}
.dk-lights span:nth-child(3){background:#28c840}
.dk-title{height:40px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--ink-soft);border-bottom:1px solid var(--line);position:relative}
.dk-ctl{position:absolute;right:12px;top:8px;display:flex;gap:8px}
.dk-ctl span{width:24px;height:24px;border-radius:12px;background:var(--selection);display:inline-flex;align-items:center;justify-content:center;color:var(--ink-soft)}
.dk-menu{position:absolute;width:340px;box-sizing:border-box;border-radius:12px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-xl);padding:6px;font-size:13px;line-height:20px;z-index:4}
.dk-label{display:flex;justify-content:space-between;padding:8px 10px 4px;font-size:12px;line-height:16px;color:var(--muted)}
.dk-row{display:flex;align-items:center;gap:10px;min-height:32px;padding:6px 10px;border-radius:8px;box-sizing:border-box}
.dk-row.hover{background:var(--selection)}
.dk-row .dl-t{flex:1;min-width:0;display:flex;flex-direction:column}
.dk-row .dl-t span+span{font-size:12px;line-height:16px;color:var(--muted)}
.dk-sep{height:1px;background:var(--line);margin:6px 4px}
.dk-key{font-size:12px;line-height:16px;color:var(--muted)}
.dk-note{position:absolute;width:368px;box-sizing:border-box;border-radius:16px;padding:12px 14px;background:rgba(250,250,251,.9);backdrop-filter:blur(24px);border:1px solid rgba(0,0,0,.06);box-shadow:0 12px 32px -12px rgba(20,18,26,.32);display:flex;gap:12px;font-size:13px;line-height:18px;z-index:4}
.dk-note .dl-mark{width:32px;height:32px;border-radius:8px;font-size:15px}
.dk-note .dl-t{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dk-note .dk-app{display:flex;justify-content:space-between;font-size:12px;line-height:16px;color:var(--muted)}
.dk-note .dk-acts{display:flex;gap:8px;margin-top:8px}
.dk-note .dk-acts .dl-btn{flex:1;justify-content:center}
.dk-steps{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;color:var(--muted)}
.dk-steps b{font-weight:600;color:var(--ink)}
.dk-steps .dk-line{width:24px;height:1px;background:var(--line-strong)}
</style>'''

def menubar(app_name, tray):
    items = ''.join(f'<span>{x}</span>' for x in ('File', 'Edit', 'View', 'Window', 'Help'))
    return (f'<div class="dk-bar"><b>{app_name}</b>{items}<span class="dl-end">{i("cloud", 16)}{i("search", 15)}'
            f'{tray}<span>Tue Oct 27&nbsp;&nbsp;2:32 PM</span></span></div>')

# The tray icon: a count of Waiting on you, and a red dot while something is failing.
def tray(count='', failing=False, on=False):
    dot = '<span class="dk-tray-dot"></span>' if failing else ''
    return f'<span class="dk-tray{" on" if on else ""}"><span class="dk-tray-mark">d</span>{count}{dot}</span>'

LIGHTS = '<div class="dk-lights"><span></span><span></span><span></span></div>'

def row(title, sub='', lead='', end='', hover=False):
    s = f'<span>{sub}</span>' if sub else ''
    return f'<div class="dk-row{" hover" if hover else ""}">{lead}<span class="dl-t"><span>{title}</span>{s}</span>{end}</div>'

def key(k):
    return f'<span class="dk-key">{k}</span>'

# ---------- Tray menu ----------
menu = f'''<div class="dk-menu" style="top:36px;right:150px" role="menu" aria-label="deploy.local">
  <div class="dk-row" style="padding-top:8px;padding-bottom:8px"><span class="dl-mark">d</span><span class="dl-t"><span class="dl-strong">deploy.local</span><span>SER · 3 computers online</span></span>{status('', 'Connected')}</div>
  <div class="dk-sep"></div>
  <div class="dk-label"><span>Waiting on you</span><span>3</span></div>
  {row('Roll back home-gym?', 'Warden · sync worker failing', ATTN(), key('now'), True)}
  {row('Merge PR #18', 'Scout · 4 checks passed', ATTN(), key('4m'))}
  {row('Keep 3 or 5 releases?', 'Scout · self-release pipeline', ATTN(), key('12m'))}
  <div class="dk-sep"></div>
  <div class="dk-label"><span>Live</span><span>7 running</span></div>
  {row('home-gym sync', '38% of jobs error since 1:58 PM', i('app', 16), status('failed', 'Failing'))}
  {row('Immich', 'Memory 92% of 4 GB', i('app', 16), status('attention', 'High memory'))}
  <div class="dk-sep"></div>
  <div class="dk-label"><span>This computer</span><span>MacBook Pro</span></div>
  {row('Running 1 task', 'Self-release pipeline · 12m', SPIN(), '')}
  {row('Take new tasks', 'Pauses on battery below 20%', i('compute', 16), sw('Take new tasks'))}
  <div class="dk-sep"></div>
  {row('New task', '', i('edit', 16), key('⌘N'))}
  {row('Open deploy.local', '', i('panel', 16), key('⌘O'))}
  {row('Quit', 'The worker stops until you open the app again', '', key('⌘Q'))}
</div>'''

def legend_icon(label, t):
    return f'<div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start"><span style="background:rgba(246,246,248,.9);border:1px solid var(--line);border-radius:8px;padding:5px 8px;font-size:13px">{t}</span><span class="dl-meta">{label}</span></div>'

legend = (f'<div class="dl-group" style="position:absolute;left:64px;bottom:48px;padding:16px 20px;display:flex;flex-direction:column;gap:12px;width:440px;box-sizing:border-box">'
          f'<span class="dl-strong">Menu bar icon</span><span class="dl-meta" style="margin-top:-8px">The same rule as the sidebar: a count for decisions, a dot for state.</span>'
          f'<div style="display:flex;gap:28px">{legend_icon("All healthy", tray())}{legend_icon("3 waiting on you", tray("3"))}{legend_icon("Something failing", tray("3", True))}</div></div>')

B['Tray.dc.html'] = ('desktop', 'Menu bar: the inbox and Live without opening the app', f'''{CSS}<div class="dk-desk dl-sheet">
{menubar('deploy.local', tray('3', True, True))}
<div class="dk-win" style="left:64px;top:72px;width:1000px;height:600px">{LIGHTS}{b_live.live_app()}</div>
{menu}
{legend}
</div>''')

# ---------- A desktop notification ----------
term = '''<pre class="dl-term" style="margin:0;border:0;border-radius:0;height:100%;box-sizing:border-box;padding:16px 18px;font-size:12px;line-height:20px">~/code/home-gym on main
$ git pull
Already up to date.
$ pnpm test src/sync
 ✓ readWorkouts maps started_at (14 ms)
 ✓ batches of 50 (9 ms)
$ ▍</pre>'''

note_main = f'''<div class="dk-note" style="top:42px;right:16px">
  <span class="dl-mark">d</span>
  <div class="dl-t">
    <span class="dk-app"><span>deploy.local · Warden</span><span>now</span></span>
    <span class="dl-strong">Roll back home-gym?</span>
    <span class="dl-soft">home-gym sync fails 38% of jobs since 1:58 PM. Both apps go back to 81be0d2 and migration 0042 is undone.</span>
    <div class="dk-acts">{btn('Review', 'primary')}{btn('Not now')}</div>
  </div>
</div>'''
note_second = f'''<div class="dk-note" style="top:212px;right:16px">
  <span class="dl-mark">d</span>
  <div class="dl-t">
    <span class="dk-app"><span>deploy.local · Scout</span><span>4m</span></span>
    <span class="dl-strong">Merge PR #18?</span>
    <span class="dl-soft">Reviewed by GPT-6.1-Sol. 4 checks passed on this version.</span>
  </div>
</div>'''

B['Notification.dc.html'] = ('desktop', 'A notification: only for decisions and failures', f'''{CSS}<div class="dk-desk dl-sheet">
{menubar('Terminal', tray('3', True))}
<div class="dk-win" style="left:120px;top:96px;width:760px;height:520px;background:var(--surface)"><div class="dk-title" style="height:36px">{LIGHTS.replace('top:18px', 'top:12px')}home-gym — zsh</div><div style="height:calc(100% - 36px)">{term}</div></div>
{note_main}
{note_second}
</div>''')

# ---------- This computer: installing the app makes it a worker ----------
def setup(name, hw, accounts, apps_on, apps_sub, linux=False):
    chrome = (f'<div class="dk-title">deploy.local<span class="dk-ctl"><span>–</span><span>□</span><span>{i("x", 12)}</span></span></div>' if linux
              else f'<div class="dk-title" style="border-bottom:0">{LIGHTS.replace("top:18px", "top:14px")}</div>')
    steps = '<div class="dk-steps"><span style="display:inline-flex;align-items:center;gap:6px">' + OK() + 'Sign in</span><span class="dk-line"></span><b>This computer</b><span class="dk-line"></span><span>Permissions</span></div>'
    found = group([item(name, hw, '<span class="dl-glyph plain">' + i('compute', 12) + '</span>', c('This computer'))] + accounts)
    choices = group([f'''<div class="dl-inset">
      {setting('Take tasks', 'Coding agents work here in their own folders, with the accounts above.', sw('Take tasks'))}
      {setting('Run apps', apps_sub, sw('Run apps', apps_on))}
      {setting('Serve models', 'Run local models for agents, like SER does', sw('Serve models', False))}
      {setting('Use the screen', 'Asks you each time. Needs Screen Recording and Accessibility.' if not linux else 'Asks you each time.', sw('Use the screen', False))}
    </div>'''])
    body = f'''<div style="max-width:520px;margin:0 auto;padding:28px 24px 32px;display:flex;flex-direction:column;gap:20px">
  {steps}
  <div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">Let {name} help?</h1>
  <span class="dl-soft">You're signed in to deploy.local on SER. {name} can also do work for your agents. It joins Computers, and you can change this there anytime.</span></div>
  {found}
  {choices}
  <span class="dl-meta">The worker keeps running when you close the window. Pause or quit it from the {"tray" if linux else "menu bar"}.</span>
  <div style="display:flex;justify-content:flex-end;gap:8px">{btn('Just use the app', 'quiet')}{btn(f'Add {name}', 'primary')}</div>
</div>'''
    return f'''{CSS}<div class="dk-desk dl-sheet{" linux" if linux else ""}">
{"" if linux else menubar("deploy.local", tray("3", True))}
<div class="dk-win" style="left:50%;top:{56 if linux else 64}px;transform:translateX(-50%);width:720px">{chrome}{body}</div>
</div>'''

CL = '<span class="dl-glyph plain">C</span>'
CX = '<span class="dl-glyph plain">X</span>'
B['Setup.dc.html'] = ('desktop', 'This computer, on a Mac: installing the app adds a worker', setup(
    'MacBook Pro', 'Apple M4 Pro · 48 GB · macOS 27',
    [item('Claude', 'Signed in on this Mac · Opus', CL, OK()), item('Codex', 'Signed in on this Mac · GPT-6.1-Sol', CX, OK())],
    False, 'Host apps from Projects. Best on an always-on computer like SER.'))
B['SetupLinux.dc.html'] = ('desktop', 'This computer, on Linux (bazzite)', setup(
    'bazzite', 'AMD Ryzen 7 7840HS · 32 GB · Bazzite 42',
    [item('Codex', 'Signed in · GPT-6.1-Sol', CX, OK()), item('Claude', 'Not signed in on this computer', CL, btn('Sign in', 'quiet'))],
    True, 'This computer stays on, so it can host apps too.', True))
