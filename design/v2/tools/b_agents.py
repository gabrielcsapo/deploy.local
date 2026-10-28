from shell import *
from b_compute import settings
from b_setup import ASK, ALLOW, NEVER, TD, meta, rules, suggest, always, matrix_stack

B = {}
# A new agent: describe the job, Scout drafts it, and it starts trusted with nothing.
K_GLYPH = '<span class="dl-glyph" style="background:color-mix(in srgb,var(--warning) 16%,transparent);color:var(--warning)">K</span>'
KEEPER = [('Keeper', 'Configure.dc.html', 'keeper', K_GLYPH)]

def stepper(n):
    names = ('Describe the job', 'Review the draft', 'Start asking')
    out = []
    for k, t in enumerate(names):
        if k < n:
            out.append(f'<span style="display:inline-flex;align-items:center;gap:6px">{OK()}{t}</span>')
        elif k == n:
            out.append(f'<span class="dl-strong" style="font-weight:600">{t}</span>')
        else:
            out.append(f'<span>{t}</span>')
    line = '<span style="width:24px;height:1px;background:var(--line-strong)"></span>'
    return f'<div class="dl-meta" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">{line.join(out)}</div>'

def setup_page(n, body, actions):
    return app('newagent', f'''
{head('New agent', '', ib('x', 'Close'))}
<div class="dl-scroll"><div class="dl-col" style="padding-top:24px;padding-bottom:40px;display:flex;flex-direction:column;gap:24px">
  {stepper(n)}
  {body}
  <div style="display:flex;justify-content:flex-end;gap:8px">{actions}</div>
</div></div>''')

PROSE = 'font-family:var(--font-sans);font-size:15px;line-height:24px;min-height:132px'
starters = ''.join(f'<span class="dl-chip">{i("idea", 14)}{t}</span>' for t in ('Keep dependencies current', 'Watch disk space', 'Write release notes', 'Triage new issues'))
B['NewAgent.dc.html'] = ('work', 'New agent, step 1: describe the job in your own words', setup_page(0, f'''
<div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">What should this agent keep doing?</h1>
<span class="dl-soft">An agent is a standing job: it works on a schedule or when something happens, and asks you before it acts. Scout drafts the rest from this.</span></div>
<div><label for="job" class="dl-sr">The job</label><textarea id="job" class="dl-textarea" style="{PROSE}">Watch disk space on SER and bazzite. Tell me a week before a disk fills, say which app is growing, and suggest what to clean up. Never delete anything yourself.</textarea></div>
<div style="display:flex;flex-wrap:wrap;gap:8px"><span class="dl-meta" style="align-self:center">Or start from</span>{starters}</div>
<div class="dl-notice">{i('edit', 16)}<span>Something to do once, like "clean up Immich's cache"? Start a task instead; it ends when the work is done.</span><span class="dl-end">{btn('New task', 'quiet', 'Home.dc.html')}</span></div>''',
    btn('Cancel', 'quiet') + btn('Draft it', 'primary', 'NewAgentDraft.dc.html')))

draft_instr = 'Watch disk space on every computer.\n- Each morning, check free space on SER and bazzite and how fast each app is growing.\n- If a disk will fill within 7 days, tell me which app is growing and suggest what to clean up.\n- Never delete files or data. Suggest; I decide.'
B['NewAgentDraft.dc.html'] = ('work', 'New agent, step 2: Scout\'s draft, ready to edit', setup_page(1, f'''
<div class="dl-who-line">{S_GLYPH}Scout<span class="dl-meta">drafted this from your description · edit anything</span></div>
<div style="display:flex;align-items:center;gap:12px">{K_GLYPH.replace('class="dl-glyph"', 'class="dl-glyph lg"')}<span style="display:flex;flex-direction:column"><span class="dl-title" style="font-size:22px;line-height:28px">Keeper</span><span class="dl-meta">Watches disk space · suggests clean-ups</span></span><span style="margin-left:auto">{btn('Rename', 'quiet')}</span></div>
{section('Instructions', 'What Keeper is for and how it works. This is most of its tuning.', f'<label for="kinstr" class="dl-sr">Instructions</label><textarea id="kinstr" class="dl-textarea" rows="5">{draft_instr}</textarea>')}
{section('When Keeper works', '', group([f'<div class="dl-inset">{setting("Every morning", "8:00 AM", sw("Morning"))}{setting("A disk passes 80%", "On any computer", sw("Disk"))}{setting("@Keeper mentions", "In any conversation", sw("Mentions"))}</div>']))}
{section('Covers', '', group([f'<div class="dl-inset">{setting("Computers", "", "SER, bazzite")}{setting("Apps", "Reads their size, never their data", "All apps")}</div>']))}
{section('Set elsewhere', 'Shared with every agent.', group([item('What Keeper may do', 'Starts with every action set to Ask me', i('shield', 16), '', 'SettingsAgentsNew.dc.html'), item('Which models Keeper uses', 'Qwen3-8B on SER for everything · free', i('chip', 16), '', 'Models.dc.html')]))}''',
    btn('Back', 'quiet', 'NewAgent.dc.html') + btn('Create Keeper', 'primary', 'SettingsAgentsNew.dc.html')), 1440, 1200)

# The Approvals table grows a column; the new agent starts with Ask me everywhere it can act.
def matrix3():
    head_cell = lambda g, n, extra='': f'<th style="width:112px{extra}"><span style="display:inline-flex;align-items:center;gap:6px">{g}{n}</span></th>'
    new_bg = ';background:color-mix(in srgb,var(--warning) 6%,transparent)'
    rows = ''.join(f'<tr><td {TD}><span style="display:flex;flex-direction:column"><span class="dl-strong" style="font-weight:500">{a}</span>{meta(w)}</span></td>'
                   f'<td {TD}>{s}</td><td {TD}>{wv}</td><td style="white-space:normal;height:auto;padding:10px 16px{new_bg}">{ASK}</td></tr>' for a, w, s, wv in rules)
    return (f'<div class="dl-matrix-table dl-table-wrap dl-group"><table class="dl-table" style="table-layout:fixed"><thead><tr><th>Action</th>'
            f'{head_cell(S_GLYPH, "Scout")}{head_cell(W_GLYPH, "Warden", ";width:136px")}{head_cell(K_GLYPH, "Keeper", new_bg)}</tr></thead><tbody>{rows}</tbody></table></div>'
            + matrix_stack([(S_GLYPH, 'Scout', [r[2] for r in rules]), (W_GLYPH, 'Warden', [r[3] for r in rules]), (K_GLYPH, 'Keeper · new', [ASK] * len(rules))]))
B['SettingsAgentsNew.dc.html'] = ('settings', 'Approvals after adding Keeper: a new column that asks for everything', settings('agents', f'''
<div class="dl-notice">{K_GLYPH}<span>Keeper is new, so it asks you before every action. As you answer, it will suggest what to allow, the same way Warden did.</span></div>
{section('What agents may do', 'Each agent starts by asking. Trust grows one action at a time, and every answer is in Waiting on you › Answered.', matrix3())}
{section('Suggested from your answers', '', suggest)}
{section('Always yours', 'These stay with you no matter how much you trust an agent.', always)}
{section('Agents', '', group([item('Scout', 'Dev loop · deploy.local · morning brief at 7:00', S_GLYPH, btn('Tune', 'quiet', 'Configure.dc.html')), item('Warden', 'Ops · all apps and computers · checks every minute', W_GLYPH, btn('Tune', 'quiet')), item('Keeper', 'Disk space · SER and bazzite · every morning', K_GLYPH, '<span class="dl-tag">New</span>' + btn('Tune', 'quiet'))], 'Your agents', btn('New agent', 'quiet', 'NewAgent.dc.html')))}''', agents=KEEPER), 1440, 1320)
