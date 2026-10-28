import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from shell import *
D = sys.argv[1] + '/project/components'
def card(name, grp, height, readme, body, width=None):
    os.makedirs(f'{D}/{name}', exist_ok=True)
    w = f' width={width}' if width else ''
    open(f'{D}/{name}/preview.html', 'w').write(f'<!-- @dsCard group="{grp}" height={height}{w} -->\n{FONT}\n<div class="dl-sheet" style="box-sizing:border-box;padding:24px;min-height:100%">\n{body}\n</div>\n')
    open(f'{D}/{name}/README.md', 'w').write(readme)
card('Button', 'Controls', 140, """# Button
Buttons are 32 px tall with 13 px medium text and an 8 px radius.

- `.dl-btn.primary` is near-black `action`: one per screen, for the next decision ("Merge and release", "Start tasks").
- `.dl-btn.secondary` is bordered, for the alternative ("Review").
- `.dl-btn.quiet` is plain text, to dismiss ("Not now").
- `.dl-icon-btn` is a 32 px icon action; give it an `aria-label`. Violet never fills a button.
""", '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + btn('Merge and release', 'primary') + btn('Review') + btn('Not now', 'quiet') + btn('Delete app', 'danger') + ib('more', 'More') + '</div><div style="display:flex;gap:8px;margin-top:12px;align-items:center">' + chip('deploy.local', 'folder') + chip('MacBook Pro', 'compute') + '<span class="dl-tag">Ready to merge</span>' + sw('On') + sw('Off', False) + '<div class="dl-seg"><a href="#" class="on">Open</a><a href="#">Merged</a></div></div>')
card('Sidebar', 'Navigation', 420, """# Sidebar
The one sidebar (256 px): start work at the top, what needs you below, settings at the foot.

- Rows are 32 px, 13 px `ink-soft`; the selected row fills with `selection`.
- Section labels are 12 px `muted`, sentence case: "Agents", "Waiting on you", "Today".
- Top: New task, Projects, Live, Computers. Live always shows a summary: \"7 running\", or a red dot and \"1 failing\".
- Waiting on you is the one inbox, with its count. Only its rows carry the attention glyph; agents and Live never do.
- Other rows carry at most a spinner while running.
- Below 820 px the sidebar hides behind a menu button.
""", '<div style="height:380px;display:flex;border:1px solid var(--line);border-radius:12px;overflow:hidden;width:256px">' + sidebar('task') + '</div>', 320)
card('WorkLog', 'Conversation', 200, """# Work log
An agent's steps fold into one line: "Worked for 9m ›". Open, they list as 13 px `ink-soft` rows on a thin left rule with 14 px icons. While running, the line shows a spinner and the current step.
""", worklog('Worked for 9m', [S('file', 'Read scripts/deploy-update.mjs'), S('search', 'Searched for releases/ in server', '9 results'), S('terminal', 'Ran node --test server/release', '18 passed')]) + '<div style="height:16px"></div>' + worklog('Running tests on MacBook Pro', [], True))
card('ApprovalCard', 'Conversation', 180, """# Approval card
The only boxed element in a conversation: a decision a person makes. An 18 px icon, a 15 px medium title, one line of reason, then a near-black primary, a bordered alternative and a quiet dismissal.
""", approval(i('merge', 18), 'Merge PR #18', 'Reviewed by GPT-6.1-Sol, 4 checks passed on this version.', btn('Merge and release', 'primary') + btn('Review') + btn('Not now', 'quiet')))
card('Message', 'Conversation', 200, """# Messages
The person's messages sit in an 18 px-radius `selection` bubble at 15 px. Agent replies are plain prose at 16/26 with no bubble.
""", '<div class="dl-thread" style="padding:0;max-width:640px">' + you('Merge #18. Yes to the pipeline.') + reply('#18 is live. The pipeline task is running, and I\'ll ask before it activates anything on SER.') + '</div>')
card('Composer', 'Conversation', 140, """# Composer
One prompt everywhere, 18 px radius, "Ask, build, or follow up…". Context chips (project, computer) sit beside attach; the model and send sit at the end. Local models are named as local; subscriptions by model.
""", composer(chip('deploy.local', 'folder') + chip('Any free computer', 'compute'), fid='c')[len('<div class="dl-dock">'):-len('</div>')])
card('ListGroup', 'Lists', 220, """# List group
Resources (projects, pull requests, computers, releases) sit in a 12 px-radius group with hairline rows: a 13 px medium title, a 12 px muted line, and at most one status and one time at the end. The whole row is the link.
""", group([item('SER', 'Coordinator · runs apps and local models', '<span class="dl-glyph plain">' + i('compute', 12) + '</span>', status('', 'Online') + c('Disk 61%'), '#'), item('MacBook Pro', 'Task worker · Claude', '<span class="dl-glyph plain">' + i('compute', 12) + '</span>', status('active', 'Running 1 task'), '#')], 'Computers'))
card('Settings', 'Lists', 180, """# Settings rows
Label and hint on the left, the control on the right, hairlines between, 32 px between sections. No boxed fields.
""", group(['<div class="dl-inset">' + setting('Merge a pull request', '', 'Ask me') + setting('Morning brief', '7:00 AM on weekdays', sw('Brief')) + '</div>']))
card('Status', 'Status', 120, """# Status
Work uses one glyph: `active` spinner, `success` check, `danger` cross. The `warning` attention glyph means \"you must decide\" and appears only on Waiting on you items and the same decision shown in context. Resources (apps, computers) use a 6 px dot with a sentence-case label. No colored fills or badges.
""", '<div style="display:flex;gap:20px;flex-wrap:wrap"><span class="dl-step">' + SPIN() + 'Running</span><span class="dl-step">' + ATTN() + 'Waiting on you</span><span class="dl-step">' + OK() + 'Ready</span><span class="dl-step">' + FAIL() + 'Failed</span></div><div style="display:flex;gap:20px;margin-top:12px">' + status('', 'Healthy') + status('active', 'Busy') + status('attention', 'Needs restart') + status('failed', 'Crashed') + status('inactive', 'Stopped') + '</div>')
card('Dialog', 'Overlays', 300, """# Dialog
16 px radius, 20 px padding, a 15 px semibold title with a close button, actions at the end. One per screen.
""", '<div class="dl-dialog"><div class="dl-dialog-head"><h2>Add a computer</h2>' + ib('x', 'Close') + '</div><p class="dl-soft" style="margin:0">Run this on the computer you want to add.</p><pre class="dl-term wrap">curl -fsSL https://deploy.local/install | sh -s -- --join 7KQ2-M9XD</pre><div class="dl-dialog-foot">' + btn('Copy command') + btn('Done', 'primary') + '</div></div>')
card('PhoneList', 'Phone', 300, """# Phone
Large title, 17 px rows in rounded groups, 13 px secondary lines, a bottom tab bar (Work, Projects, Live, Computers, Settings) and 44 px targets everywhere.
""", '<div style="max-width:390px">' + '<div class="dl-ph-group" style="margin:0">' + ph_row('Merge PR #18', 'Reviewed · 4 checks passed', ATTN(18), 'now') + ph_row('Self-release pipeline', 'Running tests · MacBook Pro', SPIN(18), '12m') + '</div><div style="height:12px"></div>' + tabbar('work').replace('class="dl-tabbar"', 'class="dl-tabbar" style="border:1px solid var(--line);border-radius:12px;padding-bottom:6px"') + '</div>')
card('States', 'Status', 300, """# Empty, loading, error
Empty states say what the place is for and offer one action. Loading keeps the layout with skeleton rows. Errors say what happened, what deploy.local is doing, and one thing you can do: `warning` while it retries, `danger` when something failed.
""", '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">' + group([f'<div class="dl-empty" style="padding:24px 16px"><span class="dl-glyph">{i("folder", 20)}</span><h3>No projects yet</h3><p>A project is a repository and the apps it runs.</p><div class="dl-actions">{btn("New project", "primary")}</div></div>']) + '<div style="display:flex;flex-direction:column;gap:10px">' + f'<div class="dl-banner warning">{i("cloud", 16)}<span class="dl-t"><span>Can\'t reach SER</span><span>Retrying in 8 s</span></span><span class="dl-end">{btn("Try now", "quiet")}</span></div>' + f'<div class="dl-banner danger">{i("x", 16)}<span class="dl-t"><span>Couldn\'t load logs</span><span>SER answered 502</span></span></div>' + group(['<div class="dl-item"><span class="dl-skel box"></span><span class="dl-t" style="gap:6px"><span class="dl-skel" style="width:50%"></span><span class="dl-skel" style="width:70%;height:8px"></span></span></div>']) + '</div></div>')
card('AgentControl', 'Overlays', 120, """# An agent at the controls
While an agent uses a screen, this bar stays on top: the agent, the app, elapsed time, Pause and Stop. Screen use is asked per task, for one app at a time.
""", '<div class="dl-control"><span class="dl-rec"></span><span>Scout is using Simulator</span><span class="dl-c">1:12</span><button type="button">Pause</button><button type="button" class="stop">Stop</button></div>')
open(f'{D}/Cover/preview.html', 'w').write(f'''<!-- @dsCard height=288 -->
{FONT}
<div class="dl-sheet" style="position:relative;width:960px;height:288px;overflow:hidden">
<style>.cv-side{{fill:var(--sidebar);stroke:var(--line)}}.cv-sel{{fill:var(--selection)}}.cv-surface{{fill:var(--surface);stroke:var(--line-strong)}}.cv-action{{fill:var(--action)}}.cv-accent{{fill:var(--accent)}}.cv-line{{fill:var(--line)}}</style>
<svg width="960" height="288" viewBox="0 0 960 288" aria-hidden="true" style="position:absolute;inset:0">
<!-- blocks: sidebar slab (sidebar), selected row (selection), composer (surface, radius-composer 18), action pill (action, radius-control 8), brand mark (accent, 6)
     arrangement: the product itself — one sidebar slab bleeding off the top and bottom, a composer floating right
     pattern: geometric, modular UI → 32 px sidebar rows as tiles (size-row), steps of space-2 8
     steps: space-2 8, space-4 16, space-8 32; radii 8, 12, 18 -->
<rect class="cv-side" x="496" y="-1" width="200" height="290"/>
<rect class="cv-accent" x="512" y="24" width="20" height="20" rx="6"/>
<rect class="cv-line" x="540" y="30" width="72" height="8" rx="4"/>
<rect class="cv-sel" x="504" y="64" width="184" height="32" rx="8"/>
<rect class="cv-line" x="520" y="76" width="96" height="8" rx="4"/>
<rect class="cv-line" x="520" y="116" width="120" height="8" rx="4"/>
<rect class="cv-line" x="520" y="148" width="80" height="8" rx="4"/>
<rect class="cv-line" x="520" y="180" width="108" height="8" rx="4"/>
<rect class="cv-line" x="520" y="212" width="64" height="8" rx="4"/>
<rect class="cv-surface" x="728" y="160" width="208" height="88" rx="18"/>
<rect class="cv-line" x="748" y="182" width="120" height="8" rx="4"/>
<rect class="cv-action" x="892" y="208" width="28" height="28" rx="14"/>
<rect class="cv-surface" x="728" y="40" width="208" height="96" rx="12"/>
<rect class="cv-line" x="748" y="60" width="140" height="8" rx="4"/>
<rect class="cv-action" x="748" y="96" width="76" height="24" rx="8"/>
</svg>
<div style="position:absolute;left:40px;bottom:40px;max-width:420px;display:flex;flex-direction:column;gap:12px">
<div style="font-size:72px;line-height:.92;font-weight:700;letter-spacing:-.04em">deploy.local</div>
<div class="dl-soft" style="font-size:14px;line-height:20px">Your apps and your agents, on computers you own.</div>
</div></div>
''')
print('cards v2')
