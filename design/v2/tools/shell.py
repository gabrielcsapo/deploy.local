# Shared pieces for the canvas boards (design system v2): page wrapper, sidebar, header, composer, work log.
from icons import i, SPIN, ATTN, OK, FAIL

FONT = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap">'

def page(title, root, w, h):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="ds/deploy-local/tokens.css">
<link rel="stylesheet" href="ds/deploy-local/components/bundle.css">
</head>
<body>
<x-dc>
<helmet>
{FONT}
<style>
body{{margin:0;background:#fafafb}}
</style>
</helmet>
{root}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
  renderVals() {{
    return {{}};
  }}
}}
</script>
</body>
</html>
'''

CUR = ' aria-current="page"'

def nav(label, href='#', on=False, lead='', end='', strong=False):
    cls = 'dl-nav' + (' on' if on else '') + (' strong' if strong else '')
    ld = f'<span class="dl-lead">{lead}</span>' if lead else ''
    e = f'<span class="dl-end">{end}</span>' if end else ''
    return f'<a href="{href}" class="{cls}"{CUR if on else ""}>{ld}<span class="dl-t">{label}</span>{e}</a>'

def label(text, action=''):
    return f'<div class="dl-side-label"><span>{text}</span>{action}</div>'

S_GLYPH = '<span class="dl-glyph">S</span>'
W_GLYPH = '<span class="dl-glyph warden">W</span>'

# One inbox. The ! glyph means "you must decide" and appears only on items in Waiting on you
# (and on the same item where it shows in context). Everything else shows state with a dot.
LIVE_CALM = '<span class="dl-c">7 running</span>'
LIVE_FAILING = '<span class="dl-status failed" style="color:var(--danger)"><span class="dl-dot"></span>1 failing</span>'
LIVE_SUMMARY = LIVE_FAILING

# Default sidebar state: Warden's rollback question is open. Boards for other moments pass their own.
INBOX = [('Roll back home-gym?', 'Warden.dc.html', 'rollback', 'now'), ('Merge PR #18', 'Review.dc.html', 'pr18', '4m'), ('Keep 3 or 5 releases?', 'Task.dc.html', 'question', '12m')]
TODAY = [('Self-release pipeline', 'Task.dc.html', 'task', 'spin', '12m'), ('Fix the sync migration', 'TaskStalled.dc.html', 'stalled', 'spin', '3m'),
         ('Show checks on merged PRs', 'TaskChanges.dc.html', 'ready', '', '40m'), ('Rename workouts.started safely', '#', '', '', '2h')]
GLYPHS = {'spin': SPIN, 'ok': OK, 'fail': FAIL}

def sidebar(sel=None, inbox=None, live=None, today=None, fresh=False, agents=()):
    on = lambda k: sel == k
    inbox = INBOX if inbox is None else inbox
    today = TODAY if today is None else today
    inbox_rows = ''.join(nav(t, h, on(k), ATTN(), w) for t, h, k, w in inbox) or '<div class="dl-meta" style="padding:6px 8px">Nothing needs you</div>'
    today_rows = ''.join(nav(t, h, on(k) if k else False, GLYPHS[g]() if g else '', w) for t, h, k, g, w in today)
    waiting = label('<a href="Inbox.dc.html">Waiting on you</a>', f'<span class="dl-c">{len(inbox)}</span>' if inbox else '')
    earlier = '' if fresh else label('Yesterday') + nav('Update from main after conflicts', '#') + nav('Keep leading zeros in SSH keys', '#') + nav('Queue runs per computer', '#')
    plus = '<button type="button" class="dl-icon-btn sm" aria-label="New">' + i('plus', 14) + '</button>'
    return f'''<nav class="dl-side" aria-label="deploy.local">
  <div class="dl-side-top"><span class="dl-brand"><span class="dl-mark">d</span>deploy.local</span><button type="button" class="dl-icon-btn" aria-label="Search">{i('search')}</button></div>
  <div class="dl-side-nav">
    {nav('New task', 'Home.dc.html', on('new'), i('edit'), '<span class="dl-kbd">⌘N</span>', True)}
    {nav('Projects', 'Projects.dc.html', on('projects'), i('folder'))}
    {nav('Live', 'Live.dc.html', on('live'), i('pulse'), live or LIVE_SUMMARY)}
    {nav('Computers', 'Compute.dc.html', on('compute'), i('compute'))}
  </div>
  <div class="dl-side-scroll">
    {label('Agents', '<a href="NewAgent.dc.html" class="dl-icon-btn sm" aria-label="New agent">' + i('plus', 14) + '</a>')}
    {nav('Scout', 'Main.dc.html', on('scout'), S_GLYPH)}
    {nav('Warden', 'Warden.dc.html', on('warden'), W_GLYPH)}
    {''.join(nav(n, h, on(k), g) for n, h, k, g in agents)}
    {waiting}
    {inbox_rows}
    {label('Today', plus)}
    {today_rows}
    {earlier}
  </div>
  <a href="Settings.dc.html" class="dl-side-foot"><span class="dl-avatar">G</span><span class="dl-who"><span class="dl-strong">Gabriel</span><span class="dl-meta">{'1 computer online' if fresh else '3 computers online'}</span></span><span class="dl-icon-btn{' on' if on('settings') else ''}" aria-hidden="true">{i('settings')}</span></a>
</nav>'''

def app(sel, main, panel='', **state):
    return f'<div class="dl-app">{sidebar(sel, **state)}<main class="dl-main">{main}</main>{panel}</div>'

MENU = f'<button type="button" class="dl-icon-btn dl-menu-btn" aria-label="Show sidebar">{i("menu")}</button>'

def head(title, sub='', end='', lead='', ruled=False):
    s = f'<span class="dl-sub">{sub}</span>' if sub else ''
    return f'<header class="dl-head{" ruled" if ruled else ""}">{MENU}{lead}<span class="dl-t">{title}</span>{s}<span class="dl-end">{end}</span></header>'

def ib(name, label, on=False, href=None):
    if href:
        return f'<a href="{href}" class="dl-icon-btn{" on" if on else ""}" aria-label="{label}">{i(name)}</a>'
    return f'<button type="button" class="dl-icon-btn{" on" if on else ""}" aria-label="{label}">{i(name)}</button>'

def btn(text, kind='secondary', href=None):
    if href:
        return f'<a href="{href}" class="dl-btn {kind}">{text}</a>'
    return f'<button type="button" class="dl-btn {kind}">{text}</button>'

def chip(text, icon=None):
    ic = i(icon, 14) if icon else ''
    return f'<span class="dl-chip">{ic}{text}</span>'

def composer(chips='', model='Opus', placeholder='Ask, build, or follow up…', fid='msg', note=''):
    n = f'<div class="dl-dock-note">{note}</div>' if note else ''
    return (f'<div class="dl-dock"><form class="dl-composer"><label for="{fid}" class="dl-sr">Message</label>'
            f'<input id="{fid}" type="text" placeholder="{placeholder}">'
            f'<div class="dl-composer-bar"><button type="button" class="dl-icon-btn sm" aria-label="Attach">{i("plus")}</button>{chips}'
            f'<span class="dl-grow"></span><button type="button" class="dl-model">{model} {i("chev", 12)}</button>'
            f'<button type="button" class="dl-icon-btn sm" aria-label="Voice">{i("mic")}</button>'
            f'<button type="button" class="dl-send" aria-label="Send">{i("up", 16, 2)}</button></div></form>{n}</div>')

def worklog(summary, steps, live=False):
    rows = ''.join(f'<li class="dl-step"><span class="dl-i">{ic}</span><span class="dl-t">{t}</span>{f"<span class=\"dl-x\">{x}</span>" if x else ""}</li>' for ic, t, x in steps)
    if live:
        top = f'<span class="dl-worklog-live">{SPIN()}<span>{summary}</span></span>'
    else:
        top = f'<span class="dl-worklog-toggle">{summary}{i("right", 14)}</span>'
    return f'<div class="dl-worklog">{top}<ul class="dl-steps">{rows}</ul></div>'

def S(icon, text, extra=''):
    return (i(icon, 14), text, extra)

def approval(icon, title, text, actions, well=''):
    w = f'<div class="dl-well">{well}</div>' if well else ''
    t = f'<p class="dl-approval-text">{text}</p>' if text else ''
    return (f'<div class="dl-approval"><div class="dl-approval-head">{icon}<div class="dl-t"><p class="dl-approval-title">{title}</p>{t}{w}</div></div>'
            f'<div class="dl-approval-actions">{actions}</div></div>')

def reply(*paras):
    return '<div class="dl-reply">' + ''.join(f'<p>{p}</p>' for p in paras) + '</div>'

def you(text):
    return f'<div class="dl-you">{text}</div>'

def item(title, sub='', lead='', end='', href=None, chev=True):
    tag = 'a' if href else 'div'
    hr = f' href="{href}"' if href else ''
    s = f'<span>{sub}</span>' if sub else ''
    ch = f'<span class="dl-chev">{i("right", 14)}</span>' if (href and chev) else ''
    return f'<{tag}{hr} class="dl-item">{lead}<span class="dl-t"><span>{title}</span>{s}</span>{end}{ch}</{tag}>'

def c(text):
    return f'<span class="dl-c">{text}</span>'

def status(tone, text):
    return f'<span class="dl-status {tone}"><span class="dl-dot"></span>{text}</span>'

def group(rows, head_text='', head_end=''):
    h = f'<div class="dl-group-head"><span>{head_text}</span>{f"<span class=\"dl-end\">{head_end}</span>" if head_end else ""}</div>' if head_text else ''
    return f'<div class="dl-group">{h}{"".join(rows)}</div>'

def setting(title, sub, value):
    s = f'<span>{sub}</span>' if sub else ''
    return f'<div class="dl-setting"><span class="dl-t"><span>{title}</span>{s}</span><span class="dl-v">{value}</span></div>'

def sw(label, on=True):
    return f'<button type="button" class="dl-switch{"" if on else " off"}" role="switch" aria-checked="{"true" if on else "false"}" aria-label="{label}"><span></span></button>'

def section(title, sub, body):
    s = f'<p class="dl-section-sub">{sub}</p>' if sub else '<div style="height: 12px"></div>'
    return f'<section class="dl-section"><h2 class="dl-section-title">{title}</h2>{s}{body}</section>'

def page_head(title, sub='', end=''):
    s = f'<span class="dl-meta">{sub}</span>' if sub else ''
    e = f'<span class="dl-end">{end}</span>' if end else ''
    return f'<div class="dl-page-head"><div class="dl-t"><h1 class="dl-title">{title}</h1>{s}</div>{e}</div>'

def tabs(items, on):
    out = []
    for key, text, href, n in items:
        nn = f'<span class="dl-n">{n}</span>' if n else ''
        out.append(f'<a href="{href}"{" class=\"on\" aria-current=\"page\"" if key == on else ""}>{text}{nn}</a>')
    return '<nav class="dl-tabs" aria-label="Sections">' + ''.join(out) + '</nav>'

# Releases, logs, variables and secrets belong to the project; an app page is only Overview and Settings.
def project_tabs(name='deploy.local'):
    prs, issues, apps = {'deploy.local': ('2', '5', '1'), 'home-gym': ('1', '1', '2')}.get(name, ('', '', ''))
    return [('overview', 'Overview', 'Project.dc.html', ''), ('code', 'Code', 'Code.dc.html', ''),
            ('pulls', 'Pull requests', 'PullRequests.dc.html', prs), ('issues', 'Issues', 'Issues.dc.html', issues),
            ('apps', 'Apps', 'App.dc.html', apps), ('releases', 'Releases', 'Deployments.dc.html', ''),
            ('logs', 'Logs', 'Logs.dc.html', ''), ('settings', 'Settings', 'ProjectSettings.dc.html', '')]

PROJECT_TABS = project_tabs()

def app_tabs(overview, settings, on):
    return tabs([('overview', 'Overview', overview, ''), ('settings', 'Settings', settings, '')], on)

def project_head(on):
    return head('deploy.local', 'Project', ib('search', 'Search') + ib('more', 'More'), '<span class="dl-glyph plain">' + i('folder', 12) + '</span>')

def diff(rows):
    out = []
    for kind, a, b, text in rows:
        cls = {'+': ' add', '-': ' del', '@': ' hunk', ' ': ''}[kind]
        mark = {'+': '+', '-': '−', '@': '', ' ': ' '}[kind]
        out.append(f'<div class="dl-line{cls}"><span class="dl-n">{a}</span><span class="dl-n">{b}</span><span>{mark} {text}</span></div>')
    return '<div class="dl-lines">' + ''.join(out) + '</div>'

# ---------- Phone ----------
SPACER = '<span style="width: 44px"></span>'
PLACES = [('work', 'Work', 'HomePhone.dc.html'), ('projects', 'Projects', 'ProjectPhone.dc.html'), ('live', 'Live', 'LivePhone.dc.html'), ('compute', 'Computers', 'ComputePhone.dc.html'), ('settings', 'Settings', '#')]

def tabbar(active):
    ON = ' class="on" aria-current="page"'
    return '<nav class="dl-tabbar" aria-label="Places">' + ''.join(
        f'<a href="{href}"{ON if key == active else ""}>{i({"work": "work", "projects": "folder", "live": "pulse", "compute": "compute", "settings": "settings"}[key], 22)}{label}</a>'
        for key, label, href in PLACES) + '</nav>'

def phone(title, body, tab=None, left='', right='', large='', bottom=''):
    lg = f'<div class="dl-ph-large">{large}</div>' if large else ''
    tb = tabbar(tab) if tab else ''
    return (f'<div class="dl-phone"><header class="dl-ph-top">{left or SPACER}<span class="dl-t">{title}</span>{right or SPACER}</header>'
            f'{lg}<div class="dl-ph-body">{body}</div>{bottom}{tb}</div>')

def ph_btn(name, label, href=None):
    if href:
        return f'<a href="{href}" class="dl-ph-btn" aria-label="{label}">{i(name, 22)}</a>'
    return f'<button type="button" class="dl-ph-btn" aria-label="{label}">{i(name, 22)}</button>'

def ph_row(title, sub='', lead='', end='', href='#'):
    s = f'<span>{sub}</span>' if sub else ''
    e = f'<span class="dl-c">{end}</span>' if end else ''
    return f'<a href="{href}" class="dl-ph-row">{lead}<span class="dl-t"><span>{title}</span>{s}</span>{e}</a>'

# Same parts as the desktop composer: attach on the left, the model beside send.
def ph_composer(text='Ask, build, or follow up…', model='Auto', attached=''):
    plus = f'<a href="AttachPhone.dc.html" class="dl-ph-btn" style="width:32px;height:32px;margin-left:-8px" aria-label="Attach">{i("plus", 20)}</a>'
    pill = f'<a href="ModelPhone.dc.html" style="flex:none;display:inline-flex;align-items:center;gap:2px;font-size:13px;color:var(--muted)">{model}{i("chev", 12)}</a>'
    send = f'<span class="dl-send" aria-hidden="true">{i("up", 16, 2)}</span>'
    row = f'{plus}<span class="dl-grow">{text}</span>{pill}{send}'
    if not attached:
        return f'<div class="dl-ph-composer">{row}</div>'
    return (f'<div class="dl-ph-composer" style="height:auto;flex-direction:column;align-items:stretch;padding:0;border-radius:20px">'
            f'<div style="display:flex;gap:8px;padding:10px 10px 0;flex-wrap:wrap">{attached}</div>'
            f'<div style="display:flex;align-items:center;gap:6px;height:46px;padding:0 6px 0 14px">{row}</div></div>')