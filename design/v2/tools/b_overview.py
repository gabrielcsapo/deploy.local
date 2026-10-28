from shell import *
import json, os

B = {}
TOK = json.load(open(os.path.join(os.path.dirname(os.path.dirname(__file__)), 'ds/project/tokens.json')))
DS_URL = 'https://claude.ai/artifact/5Sv6UWeiDvpgnenyfDurkZ'

def sheet(w, h, body):
    return f'<div class="dl-sheet" style="width: {w}px; height: {h}px; box-sizing: border-box; padding: 56px 64px; display: flex; flex-direction: column; gap: 40px; overflow: hidden">{body}</div>'

def block(title, sub, body):
    s = f'<p class="dl-meta" style="margin:0 0 16px">{sub}</p>' if sub else '<div style="height: 16px"></div>'
    return f'<section><h2 class="dl-section-title">{title}</h2>{s}{body}</section>'

swatches = ''.join(
    f'<div style="display:flex;flex-direction:column;gap:6px"><div style="height:44px;border-radius:8px;border:1px solid var(--line);background:var(--{t["name"]})"></div><span class="dl-strong">{t["name"]}</span><span class="dl-meta dl-mono">{t["value"]["light"]}</span></div>'
    for t in TOK['color']['tokens'] if t['name'] not in ('focus', 'on-action'))
type_rows = ''.join(
    f'<div style="display:grid;grid-template-columns:120px minmax(0,1fr);gap:16px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--line)"><span class="dl-meta">{s["name"]} · {s["fontSize"].replace("px", "")}</span><span style="font-size:{s["fontSize"]};line-height:{s["lineHeight"]};font-weight:{s["fontWeight"]};{"font-family:var(--font-mono);" if s.get("family") == "mono" else ""}{"letter-spacing:" + s["letterSpacing"] + ";" if s.get("letterSpacing") else ""}">{s["sample"]}</span></div>'
    for s in TOK['type']['groups'][0]['styles'])

B['DesignSystem.dc.html'] = ('overview', 'Design system', sheet(1440, 1360, f'''
<div class="dl-page-head" style="align-items:flex-start"><div class="dl-t"><span class="dl-meta">deploy.local design system · v2</span><h1 class="dl-title" style="font-size:40px;line-height:44px;letter-spacing:-.02em">Quiet by default. One decision at a time.</h1>
<span class="dl-soft" style="font-size:15px;line-height:24px;max-width:720px">Four type sizes, neutral greys, one near-black action and deploy.local violet for the brand. Every screen on this canvas loads these tokens and components.</span></div>
<span class="dl-end"><a href="{DS_URL}" class="dl-btn secondary">Open the full system</a></span></div>
<div style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:56px">
  {block('Type', 'Hanken Grotesk. Nothing in the app is larger than 22.', type_rows)}
  {block('Color', 'Light first, with a matching dark theme. Violet never fills a button.', f'<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px 12px">{swatches}</div>')}
</div>
<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px">
  {block('Buttons', 'Near-black for the next decision, bordered for the alternative, plain text to dismiss.', '<div style="display:flex;gap:8px;flex-wrap:wrap">' + btn('Merge and release', 'primary') + btn('Review') + btn('Not now', 'quiet') + '</div><div style="display:flex;gap:8px;margin-top:12px;align-items:center">' + chip('deploy.local', 'folder') + '<span class="dl-tag">Ready to merge</span>' + sw('On') + sw('Off', False) + '</div>')}
  {block('Status', 'The ! glyph means you must decide, and only Waiting on you uses it. Everything else is state: a spinner, a check, a dot.', '<div style="display:flex;flex-direction:column;gap:8px"><span class="dl-step">' + SPIN() + 'Running</span><span class="dl-step">' + ATTN() + 'Waiting on you</span><span class="dl-step">' + OK() + 'Ready</span><div style="display:flex;gap:16px;margin-top:4px">' + status('', 'Healthy') + status('active', 'Busy') + status('inactive', 'Stopped') + '</div><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px"><div style="display:flex;flex-direction:column;gap:4px"><span class="dl-meta">Live, all healthy</span><div style="background:var(--sidebar);border:1px solid var(--line);border-radius:12px;padding:4px">' + nav('Live', '#', False, i('pulse'), LIVE_CALM) + '</div></div><div style="display:flex;flex-direction:column;gap:4px"><span class="dl-meta">Live, something failing</span><div style="background:var(--sidebar);border:1px solid var(--line);border-radius:12px;padding:4px">' + nav('Live', '#', False, i('pulse'), LIVE_FAILING) + '</div></div></div></div>')}
  {block('Shape', 'Radius 8 for controls, 12 for cards, 16 for dialogs, 18 for the composer.', '<div style="display:flex;gap:12px;align-items:flex-end">' + ''.join(f'<div style="display:flex;flex-direction:column;gap:6px;align-items:center"><div style="width:64px;height:64px;border:1px solid var(--line-strong);background:var(--surface);border-radius:{r}px"></div><span class="dl-meta">{r}</span></div>' for r in (8, 12, 16, 18)) + '</div>')}
</div>
<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:56px">
  {block('Agent work', 'Steps fold into one line. Decisions are cards with one dark button.', '<div style="display:flex;flex-direction:column;gap:12px">' + worklog('Worked for 3m', [S('file', 'Read server/release/activate.ts'), S('terminal', 'Ran node --test server/release', '18 passed')]) + approval(i('merge', 18), 'Merge PR #18', 'Reviewed by GPT-6.1-Sol, 4 checks passed on this version.', btn('Merge and release', 'primary') + btn('Review') + btn('Not now', 'quiet')) + '</div>')}
  {block('Composer', 'The same prompt everywhere: "Ask, build, or follow up…". Context sits beside attach; the model sits beside send.', '<div style="display:flex;flex-direction:column;gap:16px">' + composer(chip('deploy.local', 'folder') + chip('Any free computer', 'compute'), fid='ds-msg')[len('<div class="dl-dock">'):-len('</div>')] + you('Merge #18 and start the pipeline.') + '</div>')}
</div>'''), 1440, 1360)

places = [('Work', 'edit', 'New task, agents, Waiting on you and today\'s tasks. Waiting on you is the one inbox.', ['New task', 'Scout · Warden', 'Waiting on you', 'Today, Yesterday']),
          ('Projects', 'folder', 'A repository and everything it runs, as tabs.', ['Overview · Code', 'Pull requests · Issues', 'Apps · Releases · Logs', 'Discover']),
          ('Live', 'pulse', 'Every running app, grouped by computer, with health in plain words.', ['Health and its reason', 'Traffic and release', 'Workers: jobs, queue, heartbeat', 'Roll back a whole release']),
          ('Computers', 'compute', 'Where agents and apps run, and what it costs. Settings sit at the foot.', ['Computers and roles', 'Local models on SER', 'Claude and Codex limits', 'Add a computer'])]
cols = ''.join(f'<div class="dl-group" style="padding:20px;display:flex;flex-direction:column;gap:10px"><span class="dl-glyph plain lg">{i(ic, 14)}</span><span class="dl-strong" style="font-size:15px;line-height:24px">{n}</span><span class="dl-soft">{d}</span><div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">' + ''.join(f'<span class="dl-meta">{x}</span>' for x in xs) + '</div></div>' for n, ic, d, xs in places)
B['Structure.dc.html'] = ('overview', 'Structure', sheet(1440, 620, f'''
<div class="dl-t" style="display:flex;flex-direction:column;gap:8px"><span class="dl-meta">Structure</span><h1 class="dl-title" style="font-size:40px;line-height:44px;letter-spacing:-.02em">One sidebar, four places.</h1>
<span class="dl-soft" style="font-size:15px;line-height:24px;max-width:760px">Today deploy.local has eight destinations on a rail. Agents work across all of them, so the product folds into one sidebar like a chat app: start work at the top, see what needs you below, settings at the foot.</span></div>
<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">{cols}</div>
<div class="dl-notice" style="font-size:15px;line-height:24px">One inbox: every decision any agent needs from you is one row in Waiting on you, and it is the only place the ! glyph appears. When the same decision shows in context, such as a rollback card on Live, answering either answers both. A release covers the whole project, so rolling back moves every app together.</div>'''), 1440, 620)

loop = [('Signal', 'A gap, failed check, app alert or your message', 'local'), ('Triage', 'The agent finds the project and what\'s known', 'local'), ('Proposal', 'What, why, and how it\'s tested', 'local'), ('You approve', 'Start it, make an issue, or dismiss', 'you'),
        ('Task', 'Codes on a computer, runs tests, saves a checkpoint', 'sub'), ('Pull request', 'Agent-written title and summary', 'sub'), ('Review', 'A different model reviews; the author fixes', 'sub'), ('Merge', 'You approve, or auto-merge once trusted', 'you'),
        ('Release', 'Prepare, verify, activate, roll back on failure', 'you'), ('Verify', 'Warden watches health after release', 'local'), ('Report', 'Back in the conversation it came from', 'local'), ('Learn', 'Corrections saved to the agent\'s instructions', 'local')]
lab = {'local': 'Local model', 'sub': 'Subscription', 'you': 'You'}
cards = ''.join(f'<div class="dl-group" style="padding:16px;display:flex;flex-direction:column;gap:6px{";border-color:var(--ink)" if k == "you" else ""}"><span class="dl-meta">{n + 1:02d} · {lab[k]}</span><span class="dl-strong" style="font-size:15px;line-height:24px">{t}</span><span class="dl-soft">{d}</span></div>' for n, (t, d, k) in enumerate(loop))
B['Flow.dc.html'] = ('overview', 'The loop', sheet(1440, 720, f'''
<div class="dl-t" style="display:flex;flex-direction:column;gap:8px"><span class="dl-meta">The loop</span><h1 class="dl-title" style="font-size:40px;line-height:44px;letter-spacing:-.02em">From a signal to a verified release.</h1>
<span class="dl-soft" style="font-size:15px;line-height:24px;max-width:760px">Twelve steps, three of them yours. Light steps run free on SER; coding and review use your subscriptions. Your steps start as "ask me" and loosen as trust builds.</span></div>
<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">{cards}</div>'''), 1440, 720)
