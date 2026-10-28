from shell import *
import b_live, b_work

# The public surfaces: the product page, the household's app launcher, docs, changelog,
# signing in on the web, and the pages a browser lands on when an address is wrong or down.
B = {}
MARK = lambda s=28: f'<span class="dl-mark" style="width:{s}px;height:{s}px;border-radius:{round(s * .28)}px;font-size:{round(s * .47)}px">d</span>'
BRAND = f'<a href="Landing.dc.html" style="display:inline-flex;align-items:center;gap:10px;color:var(--ink)">{MARK()}<span class="dl-strong" style="font-size:15px">deploy.local</span></a>'
WRAP = 'width:100%;max-width:1120px;margin:0 auto;box-sizing:border-box'
INSTALL = 'curl -fsSL https://github.com/gabrielcsapo/deploy.local/releases/latest/download/install.sh | sh'

def topbar(on='', end=None, narrow=False, wide=False):
    if narrow:
        return f'<header style="display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;border-bottom:1px solid var(--line)">{BRAND}<span class="dl-grow" style="flex:1"></span>{end or ""}{ib("menu", "Menu")}</header>'
    links = ''.join(f'<a href="{h}" style="color:{"var(--ink)" if k == on else "var(--ink-soft)"};{"font-weight:600" if k == on else ""}">{t}</a>'
                    for k, t, h in (('docs', 'Docs', 'DocsHome.dc.html'), ('changelog', 'Changelog', 'Changelog.dc.html'), ('source', 'Source', '#')))
    end = end if end is not None else btn('Sign in', 'secondary', 'WebSignIn.dc.html')
    return (f'<header style="border-bottom:1px solid var(--line)"><div style="{WRAP};{'max-width:1280px;' if wide else ''}display:flex;align-items:center;gap:32px;height:64px;padding:0 32px">'
            f'{BRAND}<nav style="display:flex;gap:24px;font-size:14px">{links}</nav><span style="flex:1"></span>{end}</div></header>')

def copybox(cmd, narrow=False):
    return (f'<div style="display:flex;align-items:center;gap:8px;padding:{"10px 10px 10px 14px" if narrow else "8px 8px 8px 16px"};border-radius:12px;border:1px solid var(--line-strong);background:var(--surface);min-width:0">'
            f'<span class="dl-mono" style="flex:1;min-width:0;font-size:{12 if narrow else 13}px;line-height:20px;color:var(--ink);{"white-space:normal;word-break:break-all" if narrow else "white-space:nowrap;overflow:hidden;text-overflow:ellipsis"}">{cmd}</span>{ib("copy", "Copy")}</div>')

def shot(root, w_src, h_src, w, h):
    s = w / w_src
    return (f'<div style="width:{w}px;height:{h}px;overflow:hidden;border-radius:14px;box-shadow:0 0 0 1px var(--line-strong),0 24px 60px -24px rgba(20,18,26,.28);background:var(--paper)">'
            f'<div style="transform:scale({s:.4f});transform-origin:0 0;width:{w_src}px;height:{h_src}px;pointer-events:none">{root}</div></div>')

def footer(narrow=False):
    pad = '24px 16px' if narrow else '32px'
    return (f'<footer style="border-top:1px solid var(--line)"><div style="{WRAP};display:flex;flex-wrap:wrap;align-items:center;gap:24px;padding:{pad}" class="dl-meta">'
            f'<span>deploy.local</span><a href="DocsHome.dc.html">Docs</a><a href="Changelog.dc.html">Changelog</a><a href="#">Source on GitHub</a></div></footer>')

def safari(body, host='deploy.local'):
    # A web page at iPhone width: the page, then Safari's address bar at the bottom.
    return (f'<div class="dl-sheet" style="position:relative;width:390px;height:844px;overflow:hidden;display:flex;flex-direction:column">'
            f'<div style="height:47px;flex:none"></div><div style="flex:1;overflow:hidden">{body}</div>'
            f'<div style="flex:none;padding:10px 16px 30px;background:var(--sidebar);border-top:1px solid var(--line)"><div style="height:44px;border-radius:12px;background:var(--surface);box-shadow:0 0 0 1px var(--line);display:flex;align-items:center;justify-content:center;gap:6px;font-size:15px">{i("shield", 12)}{host}</div></div></div>')

# ---------- The main page ----------
ICON = lambda name: f'<span style="width:36px;height:36px;border-radius:10px;background:var(--selection);color:var(--accent);display:inline-flex;align-items:center;justify-content:center">{i(name, 18)}</span>'
PILLARS = (('work', 'Ask from anywhere', 'Type what you want on any device. A question gets an answer. A change becomes a task on a computer that is free.'),
           ('pr', 'Review, then ship', 'Every change arrives as a pull request with its checks and screenshots you ask for. Nothing goes live until you press Ship.'),
           ('pulse', 'Watched while it runs', 'Warden watches your apps and workers. When something breaks, it asks you, with the rollback ready to go.'))
ROLES = (('SER', 'The coordinator. Stays on.', ('Run apps',)), ('MacBook Pro', 'Your laptop, when it is awake', ('Take tasks', 'Use the screen')), ('bazzite', 'A desktop with a GPU', ('Run apps', 'Serve models', 'Take tasks')))
SURFACES = (('globe', 'Web', 'Everything, in any browser at home'), ('app', 'iPhone', 'Waiting on you, Live, and asking for work'),
            ('compute', 'Desktop app', 'Mac, Windows, Linux. Joins as a worker'), ('terminal', 'CLI', 'deploy, status, inbox, rollback'))
tagrow = lambda tags: ''.join(f'<span class="dl-tag">{t}</span>' for t in tags)
live_root = b_live.B['Live.dc.html'][2]

def landing_body(narrow=False):
    h1 = 'font-size:34px;line-height:38px' if narrow else 'font-size:60px;line-height:62px'
    pad = '40px 16px 32px' if narrow else '88px 32px 56px'
    hero = f'''<section style="{WRAP};padding:{pad};display:flex;flex-direction:column;gap:{20 if narrow else 24}px">
  <h1 style="margin:0;{h1};letter-spacing:-.025em;font-weight:600;max-width:820px">Build it with agents.<br>Run it at home.</h1>
  <p class="dl-soft" style="margin:0;font-size:{16 if narrow else 19}px;line-height:{24 if narrow else 30}px;max-width:640px">deploy.local runs on computers you already own. Ask for an app or a change, review what the agent did, and ship it when you are ready.</p>
  <div style="display:flex;flex-direction:column;gap:8px;max-width:{'100%' if narrow else '760px'}">
    {copybox(INSTALL, narrow)}
    <span class="dl-meta">Run it on the computer that stays on. Needs Docker; macOS, Linux or Windows.</span>
  </div>
  <div style="display:flex;gap:8px">{btn('Read the docs', 'secondary', 'DocsHome.dc.html')}{btn('View source', 'quiet')}</div>
</section>'''
    if narrow:
        return hero + f'<div style="display:flex;justify-content:center">{shot(b_live.B["LivePhone.dc.html"][2], 390, 844, 240, 300)}</div>'
    pillars = ''.join(f'<div style="display:flex;flex-direction:column;gap:12px">{ICON(ic)}<h3 style="margin:0;font-size:17px;line-height:24px;font-weight:600">{t}</h3><p class="dl-soft" style="margin:0;font-size:15px;line-height:24px">{d}</p></div>' for ic, t, d in PILLARS)
    roles = group([item(n, s, '<span class="dl-glyph plain">' + i('compute', 12) + '</span>', f'<span style="display:inline-flex;gap:6px">{tagrow(t)}</span>') for n, s, t in ROLES])
    surfaces = ''.join(f'<div style="display:flex;gap:12px;align-items:flex-start">{ICON(ic)}<span style="display:flex;flex-direction:column"><span class="dl-strong" style="font-size:15px;line-height:22px">{t}</span><span class="dl-meta">{d}</span></span></div>' for ic, t, d in SURFACES)
    H2 = 'margin:0;font-size:30px;line-height:36px;letter-spacing:-.015em;font-weight:600'
    return hero + f'''
<div style="{WRAP};padding:0 32px">{shot(live_root, 1440, 1100, 1056, 640)}</div>
<section style="{WRAP};padding:96px 32px 0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:48px">{pillars}</section>
<section style="{WRAP};padding:112px 32px 0;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:64px;align-items:center">
  <div style="display:flex;flex-direction:column;gap:12px"><h2 style="{H2}">On computers you already own.</h2>
  <p class="dl-soft" style="margin:0;font-size:15px;line-height:24px">One computer is enough to start. Add others and give each one a job. Models run where you choose: Claude or Codex with your own subscription, or an open model on your own GPU.</p></div>
  {roles}
</section>
<section style="{WRAP};padding:112px 32px 120px;display:flex;flex-direction:column;gap:32px">
  <h2 style="{H2}">Wherever you are.</h2>
  <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:32px">{surfaces}</div>
</section>{footer()}'''

B['Landing.dc.html'] = ('public', 'The main page: what deploy.local is, and the one install command',
                        f'<div class="dl-sheet" style="min-height:100%">{topbar()}{landing_body()}</div>', 1440, 2120)
B['LandingPhone.dc.html'] = ('phone', 'iPhone Safari — the main page at phone width', safari(topbar(narrow=True, end=btn('Sign in', 'quiet', 'WebSignIn.dc.html')) + landing_body(True), 'deploy.local'))

# ---------- Apps at home: what anyone on the network sees at deploy.local ----------
APPS = (('Immich', 'Photos', 'photos.deploy.local', '#4f7cac', ''), ('Vaultwarden', 'Passwords', 'vault.deploy.local', '#3f6b5a', ''),
        ('meal-planner', 'Meals for the week', 'meal-planner.deploy.local', '#b0602a', 'New'), ('home-gym', 'Workouts', 'home-gym.deploy.local', '#7a5aa8', ''),
        ('Miniflux', 'Reading', 'feeds.deploy.local', '#a05a6a', ''))
app_icon = lambda name, bg, s=40: f'<span style="width:{s}px;height:{s}px;flex:none;border-radius:{round(s * .25)}px;background:{bg};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:{round(s * .42)}px">{name[0].upper()}</span>'
def app_card(name, what, host, bg, tag):
    t = f'<span class="dl-tag">{tag}</span>' if tag else ''
    return (f'<a href="#" style="display:flex;flex-direction:column;gap:16px;padding:20px;border-radius:14px;background:var(--surface);box-shadow:0 0 0 1px var(--line);color:var(--ink)">'
            f'<span style="display:flex;align-items:center;gap:12px">{app_icon(name, bg)}<span style="display:flex;flex-direction:column;min-width:0;flex:1"><span class="dl-strong" style="font-size:15px">{what}</span><span class="dl-meta">{name}</span></span>{t}</span>'
            f'<span class="dl-meta dl-mono" style="font-size:12px">{host}</span></a>')
CERT = f'<div class="dl-notice">{i("shield", 16)}<span>First time on this device? Trust SER\'s certificate once, so apps open without a warning.</span><span class="dl-end">{btn("Set up this device", "quiet")}</span></div>'
HIDDEN = 'Apps only for you are not shown here. Sign in to see them.'
B['AppsHome.dc.html'] = ('public', 'Apps at home: anyone on the network opens apps from deploy.local', f'''<div class="dl-sheet" style="min-height:100%">
{topbar('', btn('Sign in', 'secondary', 'WebSignIn.dc.html'))}
<div style="{WRAP};padding:64px 32px;display:flex;flex-direction:column;gap:28px">
  <div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title" style="font-size:32px;line-height:38px">Apps at home</h1><span class="dl-soft" style="font-size:15px">Running on SER and bazzite. Open them from any phone or computer on your home network.</span></div>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px">{''.join(app_card(*a) for a in APPS)}</div>
  {CERT}
  <span class="dl-meta">{HIDDEN}</span>
</div></div>''')

rows = ''.join(f'<a href="#" class="dl-item" style="padding:12px 16px">{app_icon(n, bg, 36)}<span class="dl-t"><span style="font-size:15px">{w}</span><span>{n} · {h}</span></span>{"<span class=\"dl-tag\">" + t + "</span>" if t else ""}</a>' for n, w, h, bg, t in APPS)
B['AppsHomePhone.dc.html'] = ('phone', 'iPhone Safari — Apps at home: a launcher for everyone in the house', safari(f'''
{topbar(narrow=True, end=btn('Sign in', 'quiet', 'WebSignIn.dc.html'))}
<div style="padding:24px 16px;display:flex;flex-direction:column;gap:16px">
  <div style="display:flex;flex-direction:column;gap:4px"><h1 class="dl-title" style="font-size:26px;line-height:32px">Apps at home</h1><span class="dl-soft">Running on SER and bazzite.</span></div>
  {group([rows])}
  <div class="dl-notice">{i("shield", 16)}<span>New phone? <a class="dl-link" href="#">Trust SER's certificate</a> once.</span></div>
  <span class="dl-meta">{HIDDEN}</span>
</div>'''))

# ---------- Docs: the same words as the app ----------
DOCS_NAV = (('Start', (('start', 'Get started'), ('install', 'Install on a computer'), ('add', 'Add a computer'), ('devices', 'Your devices'))),
            ('Build', (('ask', 'Ask and build'), ('ship', 'Review and ship'), ('shots', 'Screenshots and markup'))),
            ('Run', (('live', 'Live and incidents'), ('releases', 'Releases and rollback'), ('projects', 'Projects and apps'), ('backups', 'Backups and restore'), ('updates', 'Updates'))),
            ('Agents', (('agents', 'Agents'), ('approvals', 'Approvals'), ('models', 'Models'))),
            ('Reference', (('cli', 'CLI'), ('yaml', 'deploy.yaml'), ('arch', 'How it works'), ('trouble', 'Troubleshooting'))))
HREF = {'start': 'DocsHome.dc.html', 'releases': 'DocsArticle.dc.html'}
def docs_nav(on):
    out = f'<div style="display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border-radius:8px;box-shadow:0 0 0 1px var(--line);color:var(--muted);margin-bottom:20px">{i("search", 14)}<span style="flex:1">Search docs</span><span class="dl-kbd">⌘K</span></div>'
    for g, items in DOCS_NAV:
        out += f'<div class="dl-meta" style="padding:0 10px 4px;font-weight:600">{g}</div>'
        out += ''.join(f'<a href="{HREF.get(k, "#")}" style="display:block;padding:5px 10px;border-radius:7px;font-size:14px;line-height:20px;{"background:var(--selection);color:var(--ink);font-weight:600" if k == on else "color:var(--ink-soft)"}">{t}</a>' for k, t in items)
        out += '<div style="height:16px"></div>'
    return f'<nav aria-label="Docs" style="width:232px;flex:none;padding:32px 16px 32px 0">{out}</nav>'
def toc(items, on=0):
    links = ''.join(f'<a href="#" style="display:block;padding:3px 0 3px 12px;margin-left:-1px;border-left:1px solid {"var(--accent)" if n == on else "transparent"};color:{"var(--ink)" if n == on else "var(--muted)"}">{t}</a>' for n, t in enumerate(items))
    return f'<aside style="width:200px;flex:none;padding:40px 0"><div class="dl-meta" style="font-weight:600;margin-bottom:8px">On this page</div><div style="border-left:1px solid var(--line);font-size:13px;line-height:20px">{links}</div></aside>'
P = 'margin:0;font-size:15px;line-height:26px;color:var(--ink-soft)'
H2 = 'margin:16px 0 0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em'
def docs_page(on, article, toc_items, toc_on=0):
    return (f'<div class="dl-sheet" style="min-height:100%">{topbar("docs", wide=True)}<div style="{WRAP};max-width:1280px;display:flex;gap:56px;padding:0 32px">'
            f'{docs_nav(on)}<article style="flex:1;min-width:0;max-width:720px;padding:40px 0 96px;display:flex;flex-direction:column;gap:16px">{article}</article>{toc(toc_items, toc_on)}</div></div>')
def step(n, title, body):
    return (f'<div style="display:grid;grid-template-columns:32px minmax(0,1fr);gap:16px"><span style="width:28px;height:28px;border-radius:14px;background:var(--selection);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-weight:600">{n}</span>'
            f'<div style="display:flex;flex-direction:column;gap:10px;padding-top:3px"><h3 style="margin:0;font-size:16px;line-height:24px;font-weight:600">{title}</h3>{body}</div></div>')
WORDS = (('Project', 'A repository and the apps it runs. Releases, logs and secrets belong to it.'), ('Task', 'Work an agent does on one of your computers. It ends in a pull request.'),
         ('Release', 'One version of a whole project, shipped by you, verified before it goes live.'), ('Waiting on you', 'Decisions only you can make. The only place a ! appears.'),
         ('Live', 'Everything running right now, by computer.'), ('Scout and Warden', 'Scout takes on work. Warden watches what runs. Neither ships without you.'))
start = f'''<span class="dl-meta">Start</span><h1 style="margin:0;font-size:36px;line-height:42px;letter-spacing:-.02em;font-weight:600">Get started</h1>
<p style="{P}">deploy.local runs on a computer at home that stays on. These docs call it SER; yours can have any name. Setup takes about ten minutes.</p>
<div style="display:flex;flex-direction:column;gap:28px;margin-top:12px">
{step(1, 'Install on the computer that stays on', f'<p style="{P}">It needs Docker. The installer checks the computer, then asks one question: start fresh, or recover from a backup.</p>{copybox(INSTALL)}')}
{step(2, 'Finish setup in a browser', f'<p style="{P}">On any computer at home, open <span class="dl-mono">deploy.local/setup</span> and enter the code the installer printed. You make the first account with a passkey.</p>')}
{step(3, 'Add your other computers', f'<p style="{P}">Install the desktop app on a Mac, Windows or Linux computer and it joins as a worker. Pick what it does: take tasks, run apps, serve models, or use the screen.</p>')}
{step(4, 'Ask for something', f'<p style="{P}">Type what you want on Home. A question gets an answer. A change becomes a task, then a pull request you review. Nothing ships until you press Ship.</p>')}
</div>
<h2 style="{H2}">Words you will see</h2>
<div class="dl-group"><div class="dl-inset">{''.join(setting(w, d, '') for w, d in WORDS)}</div></div>
<div style="display:flex;justify-content:flex-end;margin-top:24px">{btn('Install on a computer →', 'quiet')}</div>'''
B['DocsHome.dc.html'] = ('public', 'Docs: Get started, in the same words as the app', docs_page('start', start, ['Install', 'Finish setup', 'Add computers', 'Ask for something', 'Words you will see']), 1440, 1420)

term_lines = ('<span style="color:var(--muted)">~/code/home-gym</span> deploy releases\n'
              '  <b>81be0d2</b>  Oct 25  PR #42  web app, sync worker      <span style="color:var(--muted)">previous</span>\n'
              '  <b>9c3e1fa</b>  Today   PR #43  web app, sync worker, 0042 <span style="color:var(--danger)">live · failing</span>\n\n'
              '<span style="color:var(--muted)">~/code/home-gym</span> deploy rollback\n'
              'Roll back home-gym to 81be0d2? Both apps move and migration 0042 is undone. [y/N]')
release_steps = ''.join(f'<li class="dl-step"><span class="dl-i">{i(ic, 14)}</span><span class="dl-t"><b>{t}</b> · {d}</span></li>' for ic, t, d in (
    ('rocket', 'Prepare', 'build every app in the project'), ('shield', 'Verify', 'start the release on a copy and check that it answers'),
    ('bolt', 'Activate', 'switch traffic and run migrations'), ('pulse', 'Watch', 'Warden watches it for 10 minutes')))
article = f'''<span class="dl-meta">Run</span><h1 style="margin:0;font-size:36px;line-height:42px;letter-spacing:-.02em;font-weight:600">Releases and rollback</h1>
<p style="{P}">A release is one version of a whole project: every app in it, plus its database migrations. You start every release, by pressing Ship or merging a pull request.</p>
<h2 style="{H2}">How a release runs</h2>
<ul class="dl-steps" style="margin:0">{release_steps}</ul>
<p style="{P}">If verify fails, nothing changes; the project stays on the release it had. You can follow each step in the project's Releases, on iPhone, or with <span class="dl-mono">deploy releases</span>.</p>
<h2 style="{H2}">Rolling back</h2>
<p style="{P}">Rollback moves the whole project back to an earlier release, so its apps never run different versions. Migrations made since are undone when they can be.</p>
<div class="dl-notice">{i('shield', 16)}<span>When a migration can't be undone, rollback restores the backup taken just before that release, and tells you what data from after it would be lost before you confirm.</span></div>
<h2 style="{H2}">When Warden rolls back by itself</h2>
<p style="{P}">By default Warden asks first. You can let it roll back on its own in Approvals, per project, for a release in its first 10 minutes.</p>
<h2 style="{H2}">From the CLI</h2>
<pre class="dl-term" style="font-size:13px;line-height:20px">{term_lines}</pre>
<div style="display:flex;justify-content:space-between;margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">{btn('← Live and incidents', 'quiet')}{btn('Projects and apps →', 'quiet')}</div>
<span class="dl-meta">Edit this page on GitHub</span>'''
B['DocsArticle.dc.html'] = ('public', 'A docs article: releases and rollback, with the CLI next to the app', docs_page('releases', article, ['How a release runs', 'Rolling back', 'When Warden rolls back', 'From the CLI'], 1), 1440, 1240)

B['DocsPhone.dc.html'] = ('phone', 'iPhone Safari — a docs article: menu for the sections, contents inline', safari(f'''
{topbar(narrow=True)}
<div style="padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px" class="dl-meta">Run<span>›</span><span style="color:var(--ink)">Releases and rollback</span></div>
<div style="padding:20px 16px;display:flex;flex-direction:column;gap:14px">
  <h1 style="margin:0;font-size:28px;line-height:34px;letter-spacing:-.02em;font-weight:600">Releases and rollback</h1>
  <p style="{P}">A release is one version of a whole project: every app in it, plus its database migrations. You start every release, by pressing Ship or merging a pull request.</p>
  <div style="border-radius:12px;box-shadow:0 0 0 1px var(--line);padding:10px 14px;display:flex;align-items:center;justify-content:space-between"><span class="dl-strong">On this page</span>{i('chev', 14)}</div>
  <h2 style="{H2}">How a release runs</h2>
  <ul class="dl-steps" style="margin:0">{release_steps}</ul>
</div>''', 'deploy.local/docs/releases'))

# ---------- Changelog ----------
REL = (('7f3b2d4', 'Today', (('Fixed', 'Cancelling work on a repository no longer stalls.', 'PR #18'),)),
       ('2a91c0e', 'Today', (('Fixed', 'An agent\'s deploy tools now trust your workers\' certificates.', 'PR #17'),)),
       ('0d96f82', 'Yesterday', (('New', 'Releases started by a pipeline see apps created after deploy.local starts.', 'PR #16'), ('Fixed', 'Review diffs include files in new folders.', 'PR #15'))),
       ('3179c28', 'Oct 24', (('New', 'Each release records what verify checked, and when.', 'PR #14'), ('Fixed', 'Diffs keep the source they came from after a merge.', 'PR #13'))))
TAGC = {'New': 'background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)', 'Fixed': ''}
entries = ''.join(
    f'''<div style="display:grid;grid-template-columns:160px minmax(0,1fr);gap:32px;padding:28px 0;border-top:1px solid var(--line)">
  <div style="display:flex;flex-direction:column;gap:2px"><span class="dl-strong">{d}</span><span class="dl-meta dl-mono">{v}</span></div>
  <div style="display:flex;flex-direction:column;gap:12px">{''.join(f'<div style="display:flex;gap:12px;align-items:baseline"><span class="dl-tag" style="{TAGC[k]};width:44px;justify-content:center">{k}</span><span style="font-size:15px;line-height:24px;flex:1">{t}</span><span class="dl-meta">{pr}</span></div>' for k, t, pr in items)}</div>
</div>''' for v, d, items in REL)
B['Changelog.dc.html'] = ('public', 'Changelog: each deploy.local release in plain words', f'''<div class="dl-sheet" style="min-height:100%">{topbar('changelog')}
<div style="{WRAP};max-width:880px;padding:64px 32px 96px;display:flex;flex-direction:column;gap:28px">
  <div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title" style="font-size:32px;line-height:38px">Changelog</h1>
  <span class="dl-soft" style="font-size:15px">Your computers update themselves within 10 minutes of a release, never in the middle of a task.</span></div>
  <div>{entries}</div>
</div></div>''', 1440, 1100)

# ---------- Signing in on the web ----------
def bare(body, w=400):
    return f'<div class="dl-sheet" style="min-height:100vh;display:flex;justify-content:center;padding:96px 24px;box-sizing:border-box"><div style="width:100%;max-width:{w}px;display:flex;flex-direction:column;gap:20px">{body}</div></div>'
LOCKUP = f'<div style="display:flex;align-items:center;gap:10px">{MARK(32)}<span class="dl-strong" style="font-size:15px">deploy.local</span></div>'
B['WebSignIn.dc.html'] = ('public', 'Signing in on the web: a passkey first', bare(f'''
{LOCKUP}
<div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">Sign in</h1><span class="dl-soft">To deploy.local on SER.</span></div>
<div style="display:flex;flex-direction:column;gap:8px">{btn('Sign in with a passkey', 'primary')}{btn('Use a password instead', 'quiet')}</div>
<span class="dl-meta">Your passkey comes from your phone, your password manager, or a security key.</span>
<div style="border-top:1px solid var(--line);padding-top:16px" class="dl-meta">Just opening an app? <a class="dl-link" href="AppsHome.dc.html">Apps at home</a></div>'''))

task_root = b_work.B['Task.dc.html'][2]
B['SessionExpired.dc.html'] = ('public', 'Signed out after 30 days: sign in and land where you were', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden"><div style="filter:blur(10px);opacity:.6;height:100%">{task_root}</div>
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="Sign in again" style="max-width:420px">
  <div class="dl-dialog-head"><h2>Sign in again</h2></div>
  <p class="dl-soft" style="margin:0">This browser was signed out after 30 days. After you sign in, you come back to this task.</p>
  <div class="dl-dialog-foot">{btn('Use a password', 'quiet')}{btn('Sign in with a passkey', 'primary')}</div>
</div></div></div>''')

# ---------- Wrong address, or the app is down ----------
B['AppNotFound.dc.html'] = ('public', 'No app at that address: the closest match, and every app', bare(f'''
{LOCKUP}
<div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">No app at <span class="dl-mono" style="font-size:.9em">meal-plan.deploy.local</span></h1><span class="dl-soft">Did you mean this one?</span></div>
{group([f'<a href="#" class="dl-item">{app_icon("meal-planner", "#b0602a", 32)}<span class="dl-t"><span>Meals for the week</span><span class="dl-mono">meal-planner.deploy.local</span></span><span class="dl-chev">{i("right", 14)}</span></a>'])}
{btn('All apps at home', 'secondary', 'AppsHome.dc.html')}''', 460))

B['AppUnavailable.dc.html'] = ('public', 'An app that is rolling back: what is happening and when it is back', bare(f'''
{app_icon('home-gym', '#7a5aa8', 44)}
<div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">Workouts is being restored</h1><span class="dl-soft">home-gym is going back to its previous version. It should be back in about a minute; this page reloads by itself.</span></div>
<div style="display:flex;align-items:center;gap:8px" class="dl-meta">{SPIN(14)}<span>Rolling back on SER · started 2:46 PM</span></div>
<div style="border-top:1px solid var(--line);padding-top:16px" class="dl-meta">Other apps are running. <a class="dl-link" href="AppsHome.dc.html">Apps at home</a></div>''', 460))

B['Restarting.dc.html'] = ('public', 'deploy.local restarting during its own update: apps keep running', bare(f'''
{LOCKUP}
<div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">Updating SER</h1><span class="dl-soft">deploy.local is restarting on 7f3b2d4. Your apps keep running. This page comes back by itself, usually within a minute.</span></div>
<div style="display:flex;align-items:center;gap:8px" class="dl-meta">{SPIN(14)}<span>Waiting for SER · 24 s</span></div>
<div style="border-top:1px solid var(--line);padding-top:16px" class="dl-meta">Not back after 5 minutes? Check that SER is on, then run <span class="dl-mono">deploy status</span> on it.</div>''', 460))
