from shell import *
from b_projects import project
import b_live
from b_states import answered, steps, INBOX_AFTER

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)
W_LG = W_GLYPH.replace('dl-glyph', 'dl-glyph lg')
S_LG = S_GLYPH.replace('dl-glyph', 'dl-glyph lg')
RADIO = lambda on: f'<span style="width:20px;height:20px;flex:none;box-sizing:border-box;border-radius:10px;border:{"6px solid var(--action)" if on else "1.5px solid var(--line-strong)"}" aria-hidden="true"></span>'
TAG = lambda t: f'<span class="dl-tag">{t}</span>'
pad = lambda html: f'<div style="padding:0 16px">{html}</div>'

# ---------- Lock screen: a decision arrives; actions open it, they never act blind ----------
note = lambda who, when, title, body, extra='': (
    f'<div style="border-radius:22px;padding:12px 14px;background:rgba(250,250,251,.82);backdrop-filter:blur(24px);display:flex;gap:10px;color:#1c1b1f">'
    f'<span class="dl-mark" style="width:34px;height:34px;border-radius:9px;font-size:15px">d</span><div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">'
    f'<span style="display:flex;justify-content:space-between;font-size:13px;line-height:18px;color:#55525b"><span>deploy.local · {who}</span><span>{when}</span></span>'
    f'<span style="font-size:15px;line-height:20px;font-weight:600">{title}</span><span style="font-size:15px;line-height:20px">{body}</span>{extra}</div></div>')
actions = ('<div style="margin-top:10px;border-radius:14px;overflow:hidden;background:rgba(255,255,255,.7);font-size:16px;line-height:22px">'
           '<div style="padding:11px 14px;border-bottom:1px solid rgba(0,0,0,.08)">Review</div><div style="padding:11px 14px">Not now</div></div>')
B['LockScreen.dc.html'] = ('phone', 'iPhone — a decision on the lock screen', f'''<div class="dl-phone" style="background:linear-gradient(170deg,#3a3550 0%,#22202c 55%,#151419 100%);color:#fff;position:relative">
  <div style="text-align:center;padding-top:96px"><div style="font-size:18px;line-height:24px;font-weight:600;opacity:.85">Tuesday, October 27</div>
  <div style="font-size:88px;line-height:96px;font-weight:600;letter-spacing:-.02em">2:32</div></div>
  <div style="margin-top:auto;padding:0 10px 110px;display:flex;flex-direction:column;gap:8px">
    {note('Warden', 'now', 'Roll back home-gym?', 'The sync worker fails 38% of jobs since 1:58 PM. Both apps go back to 81be0d2.', actions)}
    {note('Scout', '4m', 'Merge PR #18?', 'Reviewed by GPT-6.1-Sol. 4 checks passed.')}
  </div>
</div>''')

# ---------- Sign in on iPhone: scan a code from a signed-in computer ----------
finder = ('<div style="margin:8px auto 0;width:240px;height:240px;border-radius:24px;background:#1c1b1f;position:relative">'
          + ''.join(f'<span style="position:absolute;{v}:22px;{h}:22px;width:36px;height:36px;border-{v}:4px solid #fff;border-{h}:4px solid #fff;border-{v}-{h}-radius:12px"></span>' for v in ('top', 'bottom') for h in ('left', 'right'))
          + '</div>')
B['SignInPhone.dc.html'] = ('phone', 'iPhone — sign in by scanning a code', phone('', f'''
<div style="padding:0 24px;display:flex;flex-direction:column;gap:16px">
  <span class="dl-soft" style="font-size:17px;line-height:24px">On a computer that is signed in, open Settings › Account › Add iPhone, then scan the code it shows.</span>
  {finder}
  <span class="dl-meta" style="font-size:13px;line-height:18px;text-align:center">The code carries SER's address, its certificate and a one-time sign-in, so there is nothing to type or check.</span>
</div>
<div class="dl-ph-group" style="margin-top:20px">{ph_row('Sign in with a password', 'You will check SER\'s certificate by hand', i('key', 18))}</div>
''', None, '', '', 'Sign in'))

# ---------- Rollback progress, in Warden's conversation ----------
B['RollbackPhone.dc.html'] = ('phone', 'iPhone — the rollback you approved, as it runs', phone('Warden', f'''
<div class="dl-ph-thread">
  {answered(i('undo', 18), 'Roll back home-gym?', 'Both apps go back to 81be0d2 and migration 0042 is undone.', 'You approved · 2:33 PM · on iPhone')}
  {worklog('Rolling back · 24 s', [], True)}
  {steps([(OK(14), 'Undid migration 0042', '3 s'), (OK(14), 'Web app on 81be0d2', 'healthy'), (SPIN(14), 'Sync worker switching', ''), (i('clock', 14), 'Retry 1,240 queued jobs', ''), (i('shield', 14), 'Watch for 10 minutes', '')])}
  <span class="dl-meta" style="font-size:13px">You can close the app. Warden reports back here, and only notifies you if something else needs you.</span>
</div>''', None, BACK('HomePhone.dc.html'), ph_btn('more', 'More'), '', ph_composer('Ask Warden…', 'Qwen3-8B')))

# ---------- Waiting on you › Answered ----------
seg = '<div class="dl-seg" style="display:flex"><a style="flex:1;justify-content:center">Waiting 2</a><a class="on" style="flex:1;justify-content:center">Answered</a></div>'
glyph = lambda g: g.replace('dl-glyph', 'dl-glyph lg')
B['AnsweredPhone.dc.html'] = ('phone', 'iPhone — every decision and how you answered', phone('', f'''
{pad(seg)}
<div class="dl-ph-label">Today</div>
<div class="dl-ph-group">{ph_row('Roll back home-gym', 'Menu bar · healthy after 10 min', glyph(W_GLYPH), TAG('Approved'))}{ph_row('Self-release pipeline', 'This Mac · with a change', glyph(S_GLYPH), TAG('Approved'))}{ph_row('Merge PR #17', 'This iPhone · released 0d96f82', glyph(S_GLYPH), TAG('Approved'))}{ph_row('Restart Vaultwarden', 'Your rule · healthy', glyph(W_GLYPH), TAG('By rule'))}</div>
<div class="dl-ph-label">Yesterday</div>
<div class="dl-ph-group">{ph_row('Use your screen', 'Simulator only · ended after 6 min', glyph(S_GLYPH), TAG('Allowed'))}{ph_row('Merge PR #16', 'This Mac · released d279f45', glyph(S_GLYPH), TAG('Approved'))}</div>
''', 'work', '', ph_btn('search', 'Search'), 'Waiting on you'))

# ---------- A project's releases ----------
B['ReleasesPhone.dc.html'] = ('phone', 'iPhone — a project\'s releases, with every app inside', phone('home-gym releases', f'''
<div class="dl-ph-label">Live now</div>
<div class="dl-ph-group">{ph_row('9c3e1fa', 'Rename workouts.started · 34 min ago', i('rocket', 18), status('failed', '1 of 2 failing'))}</div>
<div class="dl-ph-label">In 9c3e1fa</div>
<div class="dl-ph-group">{ph_row('home-gym', 'Web app', i('app', 18), status('', 'Healthy'))}{ph_row('home-gym sync', 'Worker', i('app', 18), status('failed', 'Failing'), 'Worker.dc.html')}{ph_row('Migration 0042', 'Renamed workouts.started', i('file', 18), 'Applied')}</div>
<div class="dl-ph-label">Earlier</div>
<div class="dl-ph-group">{ph_row('81be0d2', 'Weekly summary email · 9 days ago', i('rocket', 18))}{ph_row('4c2a7d1', 'Refresh Strava tokens · 12 days ago', i('rocket', 18))}</div>
''', 'projects', BACK('ProjectPhone.dc.html'), ph_btn('more', 'More'), '', f'<div style="padding:12px 16px">{btn("Roll back to 81be0d2…", "primary", "RollbackPhone.dc.html")}</div>'))

# ---------- Restoring data: allowed on iPhone because it can be undone ----------
backups = phone('', f'''
<div class="dl-ph-group">{ph_row('Last backup', 'Tonight 3:00 AM · 6 projects', OK(18))}{ph_row('Restore test', '6 days ago · passed', OK(18))}</div>
<div class="dl-ph-label">Projects</div>
<div class="dl-ph-group">{ph_row('home-gym', 'Postgres · 1.2 GB', i('app', 18))}{ph_row('Immich', 'Photos and database · 212 GB', i('app', 18))}{ph_row('Vaultwarden', 'Every hour · 40 MB', i('app', 18))}</div>
''', 'settings', BACK('SettingsPhone.dc.html'), '', 'Backups')
sheet = f'''<div style="position:absolute;inset:0;background:rgba(20,18,26,.32);display:flex;align-items:flex-end">
<div class="dl-sheet" style="width:100%;box-sizing:border-box;border-radius:20px 20px 0 0;background:var(--surface);padding:8px 16px 34px;display:flex;flex-direction:column;gap:12px;font-size:15px;line-height:22px">
  <span style="align-self:center;width:36px;height:5px;border-radius:3px;background:var(--line-strong)"></span>
  <span style="font-size:20px;line-height:26px;font-weight:600">Restore home-gym's database?</span>
  <div class="dl-ph-group" style="margin:0">{ph_row('Today, 1:57 PM', 'Just before release 9c3e1fa', RADIO(True))}{ph_row('Today, 3:00 AM', 'Nightly', RADIO(False))}</div>
  <span class="dl-soft" style="font-size:15px">Both apps stop for about a minute. Today's data is backed up first, so you can undo. 12 workouts written since 1:57 PM are set aside.</span>
  {btn('Restore database', 'primary')}{btn('Cancel', 'quiet')}
</div></div>'''
B['RestorePhone.dc.html'] = ('phone', 'iPhone — restoring data, with undo', f'<div style="position:relative;width:390px;height:844px;overflow:hidden">{backups}{sheet}</div>')

# ---------- The Settings tab ----------
B['SettingsPhone.dc.html'] = ('phone', 'iPhone — the Settings tab', phone('', f'''
<div class="dl-ph-group">{ph_row('Gabriel', 'Signed in on 3 computers and this iPhone', '<span class="dl-avatar" style="width:32px;height:32px">G</span>')}</div>
<div class="dl-ph-label">Notify me about</div>
<div class="dl-ph-group">{ph_row('Decisions', 'Everything in Waiting on you', i('bell', 18), sw('Decisions'))}{ph_row('Failing apps', 'When Live turns red', i('pulse', 18), sw('Failing'))}{ph_row('Quiet hours', '10 PM to 7 AM, except rollbacks', i('clock', 18), sw('Quiet'))}</div>
<div class="dl-ph-group" style="margin-top:20px">{ph_row('What agents may do', 'Scout, Warden, Keeper', i('shield', 18), '', 'SettingsAgents.dc.html')}{ph_row('Backups', 'Last 3:00 AM · tested 6 days ago', i('download', 18), '', 'RestorePhone.dc.html')}{ph_row('Appearance', 'System', i('settings', 18))}</div>
<div class="dl-ph-label">On a computer only</div>
<div class="dl-ph-group">{ph_row('Screen use, removing data, secrets', 'Kept off the phone on purpose', i('compute', 18))}</div>
''', 'settings', '', '', 'Settings'))

# ---------- In the app: a release that fails verification changes nothing ----------
rels = [('b81e4c0', 'Verify failed', 'now · Scout · PR #44', True), ('81be0d2', 'Live', 'rolled back to at 2:34 PM', False),
        ('9c3e1fa', 'Rolled back', '1:58 PM · Scout · PR #42', False), ('4c2a7d1', '', '12 days ago · PR #39', False)]
rel_nav = ''.join(f'<a href="#" class="dl-nav{" on" if sel else ""}" style="height:auto;padding:8px;align-items:flex-start">{i("rocket", 14)}<span class="dl-t" style="white-space:normal"><span class="dl-strong dl-mono">{sha}</span> <span class="dl-meta" style="display:block">{meta}</span></span>{f"<span class=\"dl-tag\">{tag}</span>" if tag else ""}</a>' for sha, tag, meta, sel in rels)
SKIP = lambda: f'<span style="display:inline-flex;color:var(--muted)">{i("x", 14)}</span>'
B['ReleaseFailed.dc.html'] = ('projects', 'A release that fails verification: nothing changes, and it says why', project('releases', f'''
<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
  <nav aria-label="Releases" style="flex:1 1 240px;max-width:280px;display:flex;flex-direction:column">{rel_nav}</nav>
  <div style="flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:16px">
    <div class="dl-page-head"><div class="dl-t"><span class="dl-strong" style="font-size:15px;line-height:24px">Add rest-timer sounds</span><span class="dl-meta">b81e4c0 · PR #44 by Scout · merged by you at 3:10 PM</span></div></div>
    <div class="dl-banner danger">{i('x', 16)}<span class="dl-t"><span>Verify failed. Nothing changed.</span><span>home-gym is still on 81be0d2, and both apps stayed up the whole time.</span></span></div>
    {group([f'<div style="padding:12px 16px">{steps([(OK(14), "Prepared both apps", "19.4 s"), (FAIL(14), "Verify: web app GET /healthz returned 500", "on the copy"), (SKIP(), "Activate", "skipped"), (SKIP(), "Watch", "skipped")])}</div>'])}
    <pre class="dl-term wrap">Error: REST_SOUNDS_URL is not set
  at loadConfig (src/config.ts:12)
  at start (src/server.ts:8)</pre>
    <div style="display:flex;gap:8px;flex-wrap:wrap">{btn('Add the variable', 'primary', 'ProjectSettings.dc.html')}{btn('Ask Scout to fix it')}{btn('Full log', 'quiet', 'Logs.dc.html')}</div>
    <span class="dl-meta">Scout was told in PR #44's task. Nothing is in Waiting on you, because nothing changed.</span>
  </div>
</div>''', True, name='home-gym', inbox=INBOX_AFTER, live=LIVE_CALM))

# ---------- In the app: Warden rolls back on its own, once you allow it ----------
auto_card = (f'<div class="dl-approval"><div class="dl-approval-head">{W_LG}<div class="dl-t"><p class="dl-approval-title">Warden rolled back home-gym to 81be0d2</p>'
             '<p class="dl-approval-text">The sync worker failed 38% of jobs after the 1:58 PM release, so Warden rolled back at 2:16 PM under your rule. Both apps and migration 0042 went back together; 1,240 queued jobs ran again with no errors.</p>'
             '<span class="dl-meta" style="display:block;margin-top:4px">Allowed by rule · nothing is waiting on you</span></div></div>'
             f'<div class="dl-approval-actions">{btn("See the report", "secondary", "WardenReport.dc.html")}{btn("Undo the rollback", "quiet")}{btn("Edit the rule", "quiet", "RuleEdit.dc.html")}</div></div>')
ser_auto = [
    ('home-gym sync', 'Worker · home-gym', b_live.health('', 'Healthy', 'Queue drained · 0 failures since 2:16 PM'), b_live.traffic('31 jobs/min', 'queue empty'), '81be0d2', '16m', 'Worker.dc.html'),
    b_live.SER[1],
    ('home-gym', 'Web app · home-gym.deploy.local', b_live.health('', 'Healthy', 'GET /healthz 200'), b_live.traffic('12 req/min', 'p95 37 ms'), '81be0d2', '16m', 'App.dc.html'),
    b_live.SER[3]]
B['AutoRollback.dc.html'] = ('live', 'When Warden may roll back on its own: it acts, then tells you', b_live.live_app(
    auto_card, ser_auto, '7 apps on 2 computers · 1 high memory · checked 20 s ago', inbox=INBOX_AFTER, live=LIVE_CALM), 1440, 1100)
