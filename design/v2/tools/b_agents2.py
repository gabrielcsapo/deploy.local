from shell import *
from b_agents import K_GLYPH, KEEPER
import b_live

B = {}
K_LG = K_GLYPH.replace('class="dl-glyph"', 'class="dl-glyph lg"')

# ---------- An agent after it is created: Keeper's first morning ----------
keeper_inbox = [('Keep 14 backups?', 'KeeperPage.dc.html', 'keeper-q', '8:01')] + INBOX
keeper_panel = f'''<aside class="dl-panel" aria-label="Keeper is watching">
  <div class="dl-panel-head">Watching</div>
  <div class="dl-panel-body">
    <div class="dl-panel-label">Disks</div>
    <div class="dl-panel-item"><span class="dl-t"><span>SER</span><span>61% · full in about 96 days</span></span>{status('', 'Fine')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>bazzite</span><span>72% · full in about 19 days</span></span>{status('attention', 'Watch')}</div>
    <div class="dl-panel-label">Growing fastest</div>
    <div class="dl-panel-item"><span class="dl-t"><span>Immich</span><span>+3.1 GB a day · on SER</span></span></div>
    <div class="dl-panel-item"><span class="dl-t"><span>Backups</span><span>+1.3 GB a day · on bazzite</span></span></div>
    <div class="dl-panel-label">Next</div>
    <div class="dl-panel-item">{i('clock', 14)}<span class="dl-t"><span>Tomorrow at 8:00 AM</span><span>Or when a disk passes 80%</span></span></div>
  </div>
</aside>'''
B['KeeperPage.dc.html'] = ('work', 'A new agent\'s first report: Keeper the morning after', app('keeper', f'''
{head('Keeper', 'Watches disk space', ib('eye', 'Watching', True) + ib('settings', 'Tune Keeper', href='TuneWarden.dc.html'), K_GLYPH)}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  <div class="dl-meta" style="text-align:center">You created Keeper yesterday at 3:20 PM · it asks before every action</div>
  <div class="dl-turn">
    {worklog('Worked for 30s · 8:00 AM · morning check', [S('compute', 'Checked free space on SER and bazzite'), S('pulse', 'Compared growth with the last 7 days')])}
    {reply('Good morning. SER is at 61% and gains about 4 GB a day, mostly Immich imports. At that rate it fills in about 96 days, so there is nothing to do yet.', 'bazzite is at 72%. Backups grew 9 GB this week because home-gym keeps 30 nightly copies. At this rate bazzite fills in about 19 days.')}
    {approval(i('download', 18), 'Keep 14 home-gym backups instead of 30?', 'Frees about 11 GB on bazzite and moves the full date out to about 5 weeks. The oldest copy would then be from October 13.', btn('Keep 14', 'primary') + btn('Keep 30') + btn('Not now', 'quiet'))}
  </div>
</div></div></div>
{composer(chip('All computers', 'compute'), placeholder='Ask Keeper…', fid='keeper-msg', model='Qwen3-8B · local')}
''', keeper_panel, agents=KEEPER, inbox=keeper_inbox))

# ---------- Tuning an agent other than Scout, with pause and archive ----------
w_instr = 'Watch every app and computer.\n- Check health every minute and for 10 minutes after each release.\n- When something fails, find the release or change that caused it.\n- Propose the smallest fix: a restart, a rollback, or handing it to Scout.\n- Never touch data without asking.'
B['TuneWarden.dc.html'] = ('work', 'Tuning any agent: the same page, plus pause and archive', app('warden', f'''
{head('Tune Warden', '', btn('Save', 'primary'), W_GLYPH, True)}
<div class="dl-scroll"><div class="dl-page" style="max-width:768px;gap:32px">
  {section('Instructions', 'What Warden is for and how it works. This is most of its tuning.', f'<label for="winstr" class="dl-sr">Instructions</label><textarea id="winstr" class="dl-textarea" rows="6">{w_instr}</textarea>')}
  {section('When Warden works', '', group([f'<div class="dl-inset">{setting("Health checks", "Every minute", sw("Checks"))}{setting("After a release", "Watch for 10 minutes", sw("After release"))}{setting("@Warden mentions", "In any conversation", sw("Mentions"))}</div>']))}
  {section('Set elsewhere', 'Shared with every agent.', group([item('What Warden may do', '1 allowed · 2 ask you · from the Approvals table', i('shield', 16), '', 'SettingsAgents.dc.html'), item('Which models Warden uses', 'Qwen3-8B for everything · 1 override', i('chip', 16), '', 'Models.dc.html')]))}
  {section('Learned from you', '', group([item('Roll back instead of restarting when a release is under an hour old', 'From the home-gym rollback today', end=btn('Forget', 'quiet')), item('Don\'t flag Immich memory below 95%', 'From last week', end=btn('Forget', 'quiet'))]))}
  {section('Status', '', group([f'<div class="dl-inset">{setting("Active", "Watching 7 apps on 2 computers", sw("Active"))}{setting("Archive Warden", "Stops it for good. Its conversation and history stay readable.", btn("Archive", "danger"))}</div>']))}
  <div class="dl-banner warning">{i('pulse', 16)}<span class="dl-t"><span>While Warden is paused, nobody watches health</span><span>Live still shows each app's state, but nothing rolls back or tells you about failures.</span></span></div>
</div></div>'''), 1440, 1240)

# ---------- Search and ⌘K: one box for places, things and actions ----------
def prow(lead, title, sub='', end='', on=False):
    s = f'<span class="dl-meta" style="margin-left:8px">{sub}</span>' if sub else ''
    return (f'<div class="dl-nav{" on" if on else ""}" style="height:40px">{f"<span class=\"dl-lead\">{lead}</span>"}'
            f'<span class="dl-t">{title}{s}</span>{f"<span class=\"dl-end\">{end}</span>" if end else ""}</div>')
plabel = lambda t: f'<div class="dl-side-label" style="padding:12px 10px 4px">{t}</div>'
kbd = lambda k: f'<span class="dl-kbd">{k}</span>'
palette = f'''<div class="dl-dialog dl-sheet" role="dialog" aria-label="Search and commands" style="max-width:640px;padding:0;gap:0;overflow:hidden">
  <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)">{i('search', 18)}<span style="flex:1;font-size:15px;line-height:24px">home<span style="display:inline-block;width:1.5px;height:18px;background:var(--ink);vertical-align:-3px;margin-left:1px"></span></span>{kbd('esc')}</div>
  <div style="padding:4px 8px 8px;max-height:520px;overflow:hidden">
    {plabel('Waiting on you')}
    {prow(ATTN(), 'Roll back home-gym?', 'Warden · now', kbd('↵'), True)}
    {plabel('Projects and apps')}
    {prow(i('folder', 16), 'home-gym', 'Project · 1 of 2 apps failing')}
    {prow(i('app', 16), 'home-gym sync', 'Worker · Failing')}
    {prow(i('app', 16), 'home-gym', 'Web app · Healthy')}
    {plabel('Tasks')}
    {prow(SPIN(), 'Fix the sync migration', 'Scout · bazzite · 3m')}
    {prow('', 'Rename workouts.started safely', 'Scout · done 2h ago')}
    {plabel('Actions')}
    {prow(i('logs', 16), 'Open home-gym logs')}
    {prow(i('edit', 16), 'New task in home-gym', '', kbd('⌘N'))}
    {plabel('Ask')}
    {prow(S_GLYPH, 'Ask Scout about "home"', '', kbd('⌘↵'))}
  </div>
  <div class="dl-meta" style="display:flex;gap:16px;padding:10px 16px;border-top:1px solid var(--line)"><span>↑↓ move</span><span>↵ open</span><span>⌘↵ ask an agent</span><span style="margin-left:auto">? all shortcuts</span></div>
</div>'''
B['CommandPalette.dc.html'] = ('work', 'Search and ⌘K: places, things and actions in one box', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{b_live.live_app()}
<div class="dl-scrim" style="align-items:flex-start;padding-top:88px">{palette}</div></div>''')
