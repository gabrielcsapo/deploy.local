from shell import *
import b_live, b_desktop
from b_desktop import CSS, menubar, tray, LIGHTS
from b_overview import sheet, block

B = {}
W_LG = W_GLYPH.replace('dl-glyph', 'dl-glyph lg')
INBOX_AFTER = [('Merge PR #18', 'Review.dc.html', 'pr18', '4m'), ('Keep 3 or 5 releases?', 'Task.dc.html', 'question', '12m')]
LIVE_ROLLING = '<span class="dl-status active" style="color:var(--active)"><span class="dl-dot"></span>Rolling back</span>'

def answered(icon, title, text, answer):
    return (f'<div class="dl-approval answered"><div class="dl-approval-head">{icon}<div class="dl-t"><p class="dl-approval-title">{title}</p>'
            f'<p class="dl-approval-text">{text}</p></div></div><div class="dl-approval-answer">{i("check", 14, 2)}<span>{answer}</span></div></div>')

def steps(rows):
    return '<ul class="dl-steps">' + ''.join(f'<li class="dl-step"><span class="dl-i">{ic}</span><span class="dl-t">{t}</span>{f"<span class=\"dl-x\">{x}</span>" if x else ""}</li>' for ic, t, x in rows) + '</ul>'

# ---------- 1. After you approve: the rollback runs, Warden reports, the decision is recorded ----------
progress = f'''<div class="dl-approval"><div class="dl-approval-head">{W_LG}<div class="dl-t"><p class="dl-approval-title">Rolling back home-gym to 81be0d2</p>
<p class="dl-approval-text">You approved this at 2:33 PM from the menu bar. 24 s so far, about 40 s in all.</p>
<div style="margin-top:12px">{steps([(OK(14), 'Undid migration 0042', '3 s'), (OK(14), 'Switched the home-gym web app to 81be0d2', 'GET /healthz 200'), (SPIN(14), 'Switching home-gym sync to 81be0d2', ''), (i('clock', 14), 'Retry 1,240 queued jobs', ''), (i('shield', 14), 'Warden watches health for 10 minutes', '')])}</div></div></div></div>'''
ser_rolling = [
    ('home-gym sync', 'Worker · home-gym', b_live.health('active', 'Rolling back', 'Switching to 81be0d2'), b_live.traffic('0 jobs/min', '1,240 queued'), '9c3e1fa', '→ 81be0d2', 'Worker.dc.html'),
    b_live.SER[1],
    ('home-gym', 'Web app · home-gym.deploy.local', b_live.health('', 'Healthy', 'GET /healthz 200'), b_live.traffic('12 req/min', 'p95 36 ms'), '81be0d2', 'now', 'App.dc.html'),
    b_live.SER[3],
]
B['RollingBack.dc.html'] = ('live', 'After you approve: the rollback runs where you asked for it', b_live.live_app(
    progress, ser_rolling, '7 apps on 2 computers · 1 rolling back · 1 high memory · checked 2 s ago', inbox=INBOX_AFTER, live=LIVE_ROLLING), 1440, 1100)

warden_panel = f'''<aside class="dl-panel" aria-label="Warden is watching">
  <div class="dl-panel-head">Watching</div>
  <div class="dl-panel-body">
    <div class="dl-panel-label">Apps</div>
    <div class="dl-panel-item"><span class="dl-t"><span>home-gym sync</span><span>Worker · 81be0d2</span></span>{status('', 'Healthy')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>home-gym</span><span>Web app · 81be0d2</span></span>{status('', 'Healthy')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>Immich</span><span>Memory 92% of 4 GB</span></span>{status('attention', 'High memory')}</div>
    <div class="dl-panel-item"><span class="dl-t"><span>deploy.local</span><span>2a91c0e · 6 h</span></span>{status('', 'Healthy')}</div>
    <div class="dl-panel-label">Answered today</div>
    <a href="Inbox.dc.html" class="dl-panel-item">{i('check', 14)}<span class="dl-t"><span>Roll back home-gym</span><span>Approved · 2:33 PM</span></span></a>
  </div>
</aside>'''
B['WardenReport.dc.html'] = ('live', 'Warden reports back in the conversation it came from', app('warden', f'''
{head('Warden', 'Watches your apps and computers', ib('eye', 'Watching', True) + ib('settings', 'Tune Warden'), W_GLYPH)}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  <div class="dl-turn">
    {worklog('Worked for 40s · 2:14 PM', [S('pulse', 'home-gym sync: 38% of jobs failing since the 1:58 PM release'), S('logs', 'Read the worker logs on SER and the release diff'), S('team', 'Asked Scout to fix it forward', 'Fix the sync migration')])}
    {answered(i('undo', 18), 'Roll back home-gym to 81be0d2?', 'Moves the web app and the sync worker back together and undoes migration 0042.', 'You approved · 2:33 PM · from the menu bar')}
  </div>
  <div class="dl-turn">
    {worklog('Worked for 11m · 2:33 PM', [S('undo', 'Rolled back home-gym to 81be0d2', '41 s'), S('terminal', 'Retried 1,240 queued jobs', '0 failed'), S('shield', 'Watched health for 10 minutes', 'no errors')])}
    {reply('home-gym is back on 81be0d2 and healthy. The queued jobs ran in 6 minutes with no errors, and migration 0042 is undone.', 'Scout\'s fix makes the worker read <code>started_at</code> too. It will reach you as home-gym PR #43 once it passes review, and that release ships both apps together again.')}
  </div>
</div></div></div>
{composer(chip('All apps', 'app'), placeholder='Ask Warden…', fid='warden-msg', model='Qwen3-8B · local')}
''', warden_panel, inbox=INBOX_AFTER, live=LIVE_CALM))

def decision(glyph, title, how, answer, outcome='', href='Warden.dc.html'):
    end = (status('', outcome) if outcome else '') + f'<span class="dl-tag">{answer}</span>'
    return item(title, how, glyph, end, href)

SG, WG = S_GLYPH, W_GLYPH
inbox_tabs = tabs([('waiting', 'Waiting', 'Inbox.dc.html', '2'), ('answered', 'Answered', 'Inbox.dc.html', '')], 'answered')
B['Inbox.dc.html'] = ('work', 'Waiting on you: every decision and how you answered', app('inbox', f'''
{head('Waiting on you', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page">
  {page_head('Waiting on you', 'Every decision your agents asked for. Answering anywhere (Mac, iPhone, menu bar) answers everywhere.')}
  {inbox_tabs}
  {section('Today', '', group([
    decision(WG, 'Roll back home-gym to 81be0d2', 'Warden asked at 2:14 PM · you answered at 2:33 PM from the menu bar', 'Approved', 'Healthy after 10 min', 'WardenReport.dc.html'),
    decision(SG, 'Start the self-release pipeline', 'Scout asked at 9:12 AM · you answered on this Mac: "have Warden review the rollback plan first"', 'Approved with a change', '', 'Main.dc.html'),
    decision(SG, 'Launch the bazzite app one way, not two', 'Scout asked at 9:12 AM · you answered on this Mac', 'Not now', '', 'Main.dc.html'),
    decision(SG, 'Merge PR #17', 'Scout asked at 7:40 AM · you answered at 8:02 AM on iPhone', 'Approved', 'Released 0d96f82', 'Review.dc.html'),
    decision(WG, 'Restart Vaultwarden', 'It stopped answering at 6:12 AM · your rule: Warden may restart an app that stops answering', 'Allowed by rule', 'Healthy', 'Warden.dc.html')]))}
  {section('Yesterday', '', group([
    decision(SG, 'Use your screen to check the iOS build', 'Scout asked at 11:20 AM · Simulator only, for one task', 'Allowed', 'Ended after 6 min', 'ScreenAsk.dc.html'),
    decision(SG, 'Merge PR #16', 'Scout asked at 3:55 PM · you answered at 4:10 PM on this Mac', 'Approved', 'Released d279f45', 'Review.dc.html')]))}
</div></div>''', inbox=INBOX_AFTER, live=LIVE_CALM), 1440, 1000)

# ---------- 2. Failure and offline ----------
stalled_inbox = [('Move the sync fix?', 'TaskStalled.dc.html', 'stalled', 'now')] + INBOX
stalled_today = [t if t[2] != 'stalled' else ('Fix the sync migration', 'TaskStalled.dc.html', 'stalled-task', '', 'Paused') for t in TODAY]
B['TaskStalled.dc.html'] = ('work', 'A computer goes offline in the middle of a task', app('stalled-task', f'''
{head('Fix the sync migration', 'home-gym · bazzite · paused', ib('diff', 'Changes') + ib('more', 'More'))}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  <div class="dl-banner warning">{i('cloud', 16)}<span class="dl-t"><span>bazzite went offline at 2:44 PM</span><span>Last heartbeat 3 min ago. The task is paused at checkpoint 3; nothing is lost.</span></span></div>
  {you('Fix forward: make the sync worker read <code>started_at</code>, add a test that runs the worker against the migrated schema, and open a PR.')}
  <div class="dl-turn">
    {worklog('Worked for 7m · checkpoint 3 saved', [S('file', 'Read src/sync/workouts.ts and migration 0042'), S('edit', 'Edited 2 files', '<span class="dl-add">+24</span> <span class="dl-del">−6</span>'), S('terminal', 'Started pnpm test src/sync', 'interrupted')])}
    {approval(i('compute', 18), 'Move this task to MacBook Pro?', 'It continues from checkpoint 3 with the same model. If bazzite comes back, its copy is set aside, not merged.', btn('Move to MacBook Pro', 'primary') + btn('Wait for bazzite') + btn('Stop task', 'quiet'))}
  </div>
</div></div></div>
{composer(chip('home-gym', 'folder') + chip('bazzite · offline', 'compute'), fid='stalled-msg')}
''', inbox=stalled_inbox, today=stalled_today))

failed_today = [('Cache Discover images on SER', 'TaskFailed.dc.html', 'failed', 'fail', '22m')] + TODAY
B['TaskFailed.dc.html'] = ('work', 'A task that fails says so, and why', app('failed', f'''
{head('Cache Discover images on SER', 'deploy.local · MacBook Pro · stopped', ib('diff', 'Changes') + ib('more', 'More'))}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  {you('Cache Discover images on SER so installs don\'t pull from the internet every time.')}
  <div class="dl-turn">
    {worklog('Worked for 22m', [S('file', 'Read server/catalog/preflight.ts and service.ts'), S('edit', 'Added a local image cache', '<span class="dl-add">+96</span> <span class="dl-del">−4</span>'), (FAIL(14), 'Ran pnpm test server/catalog', '3 failed'), S('refresh', 'Tried a content-addressed cache instead'), (FAIL(14), 'Ran pnpm test server/catalog', '3 failed')])}
    {reply('I couldn\'t get this working. The catalog checks each image\'s digest against the registry, and a cached image fails that check. I stopped after two approaches instead of loosening the check.', 'My changes are saved on <code>scout/discover-cache</code>. There is no pull request.')}
    {approval(i('idea', 18), 'What next?', 'The real fix is to record digests at install time. That changes preflight.ts, which Warden reviews.', btn('Try that with Opus', 'primary') + btn('Make an issue') + btn('Stop', 'quiet'))}
  </div>
</div></div></div>
{composer(chip('deploy.local', 'folder') + chip('MacBook Pro', 'compute'), fid='failed-msg')}
''', inbox=INBOX + [('What next for the cache?', 'TaskFailed.dc.html', 'failed-q', '1m')], today=failed_today))

# The desktop window when SER doesn't answer: a local page, not a blank window.
offline_tray = '<span class="dk-tray"><span class="dk-tray-mark" style="border-style:dashed;opacity:.55">d</span></span>'
B['Offline.dc.html'] = ('desktop', 'When SER does not answer: a local page, not a blank window', f'''{CSS}<div class="dk-desk dl-sheet">
{menubar('deploy.local', offline_tray)}
<div class="dk-win" style="left:50%;top:72px;transform:translateX(-50%);width:880px">
  <div class="dk-title" style="border-bottom:0">{LIGHTS.replace('top:18px', 'top:14px')}</div>
  <div style="max-width:520px;margin:0 auto;padding:8px 24px 32px;display:flex;flex-direction:column;gap:16px">
    <div class="dl-empty" style="padding:24px 0 8px"><span class="dl-glyph">{i('cloud', 20)}</span><h3>Can't reach SER</h3>
      <p>deploy.local runs on SER at deploy.local. It stopped answering at 2:41 PM. Retrying every 10 s; next try in 8 s.</p>
      <div class="dl-actions">{btn('Try now', 'primary')}{btn('Use another coordinator', 'quiet')}</div></div>
    {section('On this computer', '', group([
      item('Your task', 'Self-release pipeline, paused at its last checkpoint', i('clock', 16), status('active', 'Paused')),
      item('Last known', '3 waiting on you · 7 running · 1 failing, at 2:41 PM', i('clock', 16), c('Saved')),
      item('Drafts', 'Messages you write now are sent when SER is back', i('edit', 16), c('Kept'))]))}
    <span class="dl-meta">Nothing is lost while SER is offline. If it stays down, check its power and network, or run deploy status on SER.</span>
  </div>
</div>
</div>''')

# States in the design system: empty, loading, error.
skel_row = '<div class="dl-item" style="cursor:default"><span class="dl-skel box"></span><span class="dl-t" style="gap:6px"><span class="dl-skel" style="width:{a}%"></span><span class="dl-skel" style="width:{b}%;height:8px"></span></span><span class="dl-skel" style="width:56px"></span></div>'
skel = group([skel_row.format(a=a, b=b) for a, b in ((38, 62), (52, 44), (30, 56))])
field = f'''<div><label class="dl-field-label" for="dom">Domain</label><label class="dl-field invalid"><input id="dom" type="text" value="photos.deploy.local" aria-invalid="true" aria-describedby="dom-err"></label><p id="dom-err" class="dl-field-error">photos.deploy.local is already used by Immich. Try photos2.deploy.local.</p></div>'''
B['States.dc.html'] = ('overview', 'Empty, loading and error', sheet(1440, 720, f'''
<div class="dl-t" style="display:flex;flex-direction:column;gap:8px"><span class="dl-meta">Design system · states</span><h1 class="dl-title" style="font-size:40px;line-height:44px;letter-spacing:-.02em">Say what happened, and the one thing to do.</h1>
<span class="dl-soft" style="font-size:15px;line-height:24px;max-width:780px">Empty states say what a place is for and offer one action. Loading keeps the layout. Errors say what happened, what deploy.local is already doing about it, and one thing you can do. Raw errors belong in Logs.</span></div>
<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px">
  {block('Empty', 'A new install: no projects yet.', group([f'<div class="dl-empty"><span class="dl-glyph">{i("folder", 20)}</span><h3>No projects yet</h3><p>A project is a repository and the apps it runs. Start from code you have, or install an app.</p><div class="dl-actions">{btn("New project", "primary")}{btn("Discover apps")}</div></div>']) + '<div style="height:16px"></div>' + group([f'<div class="dl-empty" style="padding:20px 16px"><h3 style="font-size:13px;line-height:20px">Nothing needs you</h3><p style="font-size:12px;line-height:16px">Agents ask here when they need a decision.</p></div>']))}
  {block('Loading', 'Skeleton rows in the real layout. After 10 s, say what is slow.', skel + '<div style="height:16px"></div><div class="dl-notice">' + SPIN() + '<span>Connecting to SER… taking longer than usual</span></div><div style="height:12px"></div>' + worklog('Reading the release diff', [], True))}
  {block('Error', 'Warning while deploy.local retries or works around it; danger when something failed.', '<div style="display:flex;flex-direction:column;gap:10px">'
     + f'<div class="dl-banner warning">{i("cloud", 16)}<span class="dl-t"><span>Can\'t reach SER</span><span>Retrying in 8 s. Your drafts are kept.</span></span><span class="dl-end">{btn("Try now", "quiet")}</span></div>'
     + f'<div class="dl-banner warning">{i("clock", 16)}<span class="dl-t"><span>Claude\'s weekly limit is used up</span><span>Resets Thursday 9 AM. Coding tasks use Codex until then.</span></span><span class="dl-end">{btn("Change", "quiet")}</span></div>'
     + f'<div class="dl-banner danger">{i("x", 16)}<span class="dl-t"><span>Couldn\'t load logs for home-gym</span><span>SER answered 502. Logs for other apps still load.</span></span><span class="dl-end">{btn("Try again", "quiet")}</span></div>'
     + field + '</div>')}
</div>'''), 1440, 720)

# ---------- 3. Agents using the screen ----------
scope = f'''<div class="dl-scope">
  <div><span class="dl-k">Can use</span><div class="dl-seg" style="margin-left:0"><a class="on">Simulator only</a><a>Whole screen</a></div></div>
  <div><span class="dl-k">For</span><span>This task, up to 15 minutes</span></div>
  <div><span class="dl-k">You can stop</span><span>Anytime, from the bar at the top of your screen</span></div>
</div>'''
screen_ask = (f'<div class="dl-approval"><div class="dl-approval-head">{i("eye", 18)}<div class="dl-t"><p class="dl-approval-title">Use your screen for this task?</p>'
              f'<p class="dl-approval-text">Scout wants to open the Live screen in Simulator and take a screenshot. You see everything it does.</p>{scope}</div></div>'
              f'<div class="dl-approval-actions">{btn("Allow", "primary", "ScreenWatch.dc.html")}{btn("Don\'t allow")}{btn("Answer in chat", "quiet")}</div></div>')
screen_today = [('Check Live on iPhone', 'ScreenAsk.dc.html', 'screen-task', 'spin', '4m')] + TODAY
B['ScreenAsk.dc.html'] = ('work', 'An agent asks to use your screen, one app at a time', app('screen-task', f'''
{head('Check Live on iPhone', 'deploy.local · MacBook Pro', ib('diff', 'Changes') + ib('more', 'More'))}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  {you('Build the iOS app and check the new Live screen in Simulator. Send me a screenshot.')}
  <div class="dl-turn">
    {worklog('Worked for 4m', [S('terminal', 'Built Deploy for the iPhone 18 Pro simulator', 'succeeded'), S('app', 'Installed it in Simulator')])}
    {reply('The build passed. To check the Live screen I need to tap through it in Simulator on this Mac.')}
    {screen_ask}
  </div>
</div></div></div>
{composer(chip('deploy.local', 'folder') + chip('MacBook Pro', 'compute'), fid='screen-msg')}
''', inbox=[('Use your screen?', 'ScreenAsk.dc.html', 'screen-q', 'now')] + INBOX, today=screen_today))

# Setup step 3: the OS permissions. Having them doesn't let agents in; each task still asks.
perm_steps = '<div class="dk-steps"><span style="display:inline-flex;align-items:center;gap:6px">' + OK() + 'Sign in</span><span class="dk-line"></span><span style="display:inline-flex;align-items:center;gap:6px">' + OK() + 'This computer</span><span class="dk-line"></span><b>Permissions</b></div>'
B['Permissions.dc.html'] = ('desktop', 'Setup step 3: screen permissions, and what they do not allow', f'''{CSS}<div class="dk-desk dl-sheet">
{menubar('deploy.local', tray('3', True))}
<div class="dk-win" style="left:50%;top:64px;transform:translateX(-50%);width:720px">
  <div class="dk-title" style="border-bottom:0">{LIGHTS.replace('top:18px', 'top:14px')}</div>
  <div style="max-width:520px;margin:0 auto;padding:28px 24px 32px;display:flex;flex-direction:column;gap:20px">
    {perm_steps}
    <div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">Let agents use the screen?</h1>
    <span class="dl-soft">Optional. macOS needs two permissions before an agent can see and control an app on this Mac, such as Simulator for checking an iPhone build.</span></div>
    {group([item('Screen Recording', 'See the one app a task is allowed to use', '<span class="dl-glyph plain">' + i('eye', 12) + '</span>', status('', 'Allowed')),
            item('Accessibility', 'Click and type in that app', '<span class="dl-glyph plain">' + i('bolt', 12) + '</span>', btn('Open System Settings'))])}
    <div class="dl-notice">{i('shield', 16)}<span>deploy.local can't turn these on itself, and they don't let agents in on their own. Each task still asks you, for one app at a time.</span></div>
    <div style="display:flex;justify-content:flex-end;gap:8px">{btn('Skip for now', 'quiet')}{btn('Finish', 'primary')}</div>
  </div>
</div>
</div>''')

# Watching: the agent works in its one allowed window; the control bar is always on top.
sim_phone = b_live.B['LivePhone.dc.html'][2]
cursor = ('<div style="position:absolute;left:150px;top:398px;display:flex;align-items:flex-start;gap:4px;z-index:3;pointer-events:none">'
          '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 1.5 L15 9 L9 10.2 L6.4 16 Z" fill="var(--accent)" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>'
          '<span style="margin-top:12px;padding:2px 6px;border-radius:6px;background:var(--accent);color:#fff;font-size:11px;line-height:14px;font-weight:600">Scout</span></div>')
task_side = app('screen-task', f'''
{head('Check Live on iPhone', 'MacBook Pro', ib('more', 'More'))}
<div class="dl-scroll"><div class="dl-col"><div class="dl-thread">
  {answered(i('eye', 18), 'Use your screen for this task?', 'Simulator only, up to 15 minutes.', 'You allowed · 2:51 PM')}
  <div class="dl-turn">{worklog('Using Simulator · 1:12', [S('app', 'Opened Live in Deploy'), S('pulse', 'Tapped home-gym sync', 'worker page'), S('eye', 'Checking the rollback card layout')], True)}</div>
</div></div></div>''', inbox=INBOX, today=screen_today)
B['ScreenWatch.dc.html'] = ('desktop', 'Watching an agent use the screen, with Stop always on top', f'''{CSS}<div class="dk-desk dl-sheet">
{menubar('Simulator', '<span style="display:inline-flex;color:var(--accent)">' + i('eye', 16) + '</span>' + tray('3', True))}
<div style="position:absolute;top:42px;left:50%;transform:translateX(-50%);z-index:5"><div class="dl-control"><span class="dl-rec"></span><span>Scout is using Simulator</span><span class="dl-c">1:12</span><button type="button">Pause</button><button type="button" class="stop">Stop</button></div></div>
<div class="dk-win" style="left:96px;top:110px;width:720px;height:640px">{LIGHTS}{task_side}</div>
<div class="dk-win" style="left:900px;top:104px;width:340px;height:720px;background:#1c1b1f;box-shadow:0 0 0 2px var(--accent),0 0 0 6px color-mix(in srgb,var(--accent) 22%,transparent),0 24px 64px -16px rgba(20,18,26,.35)">
  <div class="dk-title" style="height:36px;color:#c5c1cc;border-bottom-color:#2e2c33">{LIGHTS.replace('top:18px', 'top:12px')}iPhone 18 Pro</div>
  <div style="position:relative;margin:12px auto 0;width:304px;height:658px;border-radius:40px;overflow:hidden;background:var(--paper)"><div style="transform:scale(.78);transform-origin:0 0;width:390px;height:844px">{sim_phone}</div></div>
  {cursor}
</div>
</div>''')
