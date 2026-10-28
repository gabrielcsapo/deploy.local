from shell import *
from b_projects import project
from b_compute import settings, compute_tabs, PC
import b_live

B = {}
APPG = '<span class="dl-glyph plain">' + i('app', 12) + '</span>'
DBG = '<span class="dl-glyph plain">' + i('chip', 12) + '</span>'
glyph = lambda name: f'<span class="dl-glyph plain">{i(name, 12)}</span>'
WAIT = lambda: f'<span style="display:inline-flex;color:var(--muted)">{i("clock", 14)}</span>'
AUTO = '<span class="dl-tag">Automatic</span>'
RADIO = lambda on: f'<span style="width:16px;height:16px;flex:none;box-sizing:border-box;border-radius:8px;border:{"5px solid var(--action)" if on else "1.5px solid var(--line-strong)"}" aria-hidden="true"></span>'

def steps(rows):
    return '<ul class="dl-steps">' + ''.join(f'<li class="dl-step"><span class="dl-i">{ic}</span><span class="dl-t">{t}</span>{f"<span class=\"dl-x\">{x}</span>" if x else ""}</li>' for ic, t, x in rows) + '</ul>'

def dialog(base, label, body, h=None):
    return f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{base}
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="{label}">{body}</div></div></div>'''

# ---------- A release in progress, on the project ----------
# After "Merge and release" the release runs on the project's Releases tab; the task and Live link here.
rels = [('7f3b2d4', 'Releasing', 'now · from PR #18', True), ('2a91c0e', 'Live', '6 h ago · you, from the CLI', False),
        ('0d96f82', '', 'yesterday · PR #17', False), ('d279f45', '', '2 days ago · PR #16', False)]
rel_nav = ''.join(f'<a href="#" class="dl-nav{" on" if sel else ""}" style="height:auto;padding:8px;align-items:flex-start">{i("rocket", 14)}<span class="dl-t" style="white-space:normal"><span class="dl-strong dl-mono">{sha}</span> <span class="dl-meta" style="display:block">{meta}</span></span>{f"<span class=\"dl-tag\">{tag}</span>" if tag else ""}</a>' for sha, tag, meta, sel in rels)
progress = f'''<div class="dl-approval" style="box-shadow:none"><div class="dl-approval-head">{SPIN(18)}<div class="dl-t"><p class="dl-approval-title">Verifying 7f3b2d4</p>
<p class="dl-approval-text">You merged PR #18 at 2:41 PM. 52 s so far; about 2 min in all.</p>
<div style="margin-top:12px">{steps([(OK(14), 'Prepared', 'built for SER and the task workers · 41 s'), (SPIN(14), 'Verifying on SER', 'GET /healthz 200 · a sample task is running on bazzite'), (WAIT(), 'Activate', 'switch SER first, then each worker when it is idle'), (WAIT(), 'Watch', 'Warden, for 10 minutes')])}</div></div></div>
<div class="dl-approval-actions">{btn('Stop before activating', 'quiet')}</div></div>'''
in_release = group([item('Coordinator', 'SER · 2a91c0e → 7f3b2d4', APPG, c('Switches first')),
                    item('Task workers', 'MacBook Pro and bazzite', PC, c('After their current tasks'))], 'In this release')
INBOX_AFTER_MERGE = [t for t in INBOX if t[2] != 'pr18']
B['ReleaseLive.dc.html'] = ('projects', 'A release in progress: on the project, linked from the task and Live', project('releases', f'''
<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
  <nav aria-label="Releases" style="flex:1 1 240px;max-width:280px;display:flex;flex-direction:column">{rel_nav}</nav>
  <div style="flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:16px">
    <div class="dl-page-head"><div class="dl-t"><span class="dl-strong" style="font-size:15px;line-height:24px">Stop the repositories cancellation test timing out</span><span class="dl-meta">7f3b2d4 · PR #18 · merged by you</span></div></div>
    {progress}
    {in_release}
    <span class="dl-meta">You can leave this page. The result shows in the PR #18 task; you only hear about it again if something needs you.</span>
  </div>
</div>''', True, inbox=INBOX_AFTER_MERGE))

# ---------- Backups and restore ----------
def backup_row(name, what, where, size, href='RestoreData.dc.html'):
    return item(name, f'{what} · {where}', APPG if name != 'deploy.local' else glyph('shield'), c(size) + btn('Restore…', 'quiet', href))
backups_body = f'''
{section('Backups', 'Every project\'s data, copied every night and before every release that changes data.', group([
    item('Last backup', 'Tonight at 3:00 AM · 6 projects · 1.3 GB changed', OK(), btn('Back up now', 'quiet')),
    item('Last restore test', '6 days ago · home-gym restored to a scratch copy and answered its health check', OK(), btn('Test a restore', 'quiet'))]))}
{section('Where backups go', '', group([f'<div class="dl-inset">{setting("bazzite", "/mnt/backup · encrypted with your recovery passphrase", status("", "410 GB free"))}</div>']))}
<div class="dl-banner warning">{i('cloud', 16)}<span class="dl-t"><span>Every copy is in this house</span><span>A fire or theft could take SER and bazzite together. Add a copy somewhere else.</span></span><span class="dl-end">{btn('Add off-site copy', 'quiet')}</span></div>
{section('What is backed up', '', group([
    backup_row('home-gym', 'Postgres 17 · nightly and before releases, 30 kept', 'from SER', '1.2 GB'),
    backup_row('Immich', 'Photos and database · nightly, 14 kept', 'from SER', '212 GB'),
    backup_row('Vaultwarden', 'Database · every hour, 7 days kept', 'from bazzite', '40 MB'),
    backup_row('deploy.local', 'Projects, tasks, settings and secrets · nightly', 'from SER', '3.4 GB')]))}
{section('If SER is lost', 'Install deploy.local on a new computer, choose "Recover from a backup", and enter your recovery passphrase. Projects, apps and data come back as they were last night.', group([f'<div class="dl-inset">{setting("Recovery passphrase", "Only you have it. Confirmed 2 months ago.", btn("Check it", "quiet"))}</div>']))}'''
B['Backups.dc.html'] = ('settings', 'Backups: what is copied, where, and the last time a restore was tested', settings('backups', backups_body), 1440, 1240)

restore = f'''
  <div class="dl-dialog-head"><h2>Restore home-gym's database?</h2>{ib('x', 'Close')}</div>
  <div><span class="dl-field-label">Restore to</span>{group([
    item('Today, 1:57 PM', 'Taken automatically just before release 9c3e1fa and migration 0042', RADIO(True), c('Before the release')),
    item('Today, 3:00 AM', 'Nightly backup', RADIO(False)),
    item('Yesterday, 3:00 AM', 'Nightly backup', RADIO(False))])}</div>
  <div class="dl-scope" style="margin-top:0">
    <div><span class="dl-k">Downtime</span><span>Both home-gym apps stop for about a minute</span></div>
    <div><span class="dl-k">Undo</span><span>Today's data is saved as a backup first</span></div>
    <div><span class="dl-k">Lost</span><span>12 workouts and 3 sessions written since 1:57 PM; they stay in that backup</span></div>
  </div>
  <div class="dl-notice">{i('undo', 16)}<span>This restores data only. To move the code back too, roll back the release, which also undoes migration 0042.</span></div>
  <div class="dl-dialog-foot">{btn('Cancel', 'quiet')}{btn('Restore database', 'primary')}</div>'''
B['RestoreData.dc.html'] = ('settings', 'Restoring one app\'s data: pick a point, see what is lost, undo stays possible', dialog(settings('backups', backups_body), 'Restore home-gym database', restore))

# ---------- Updates ----------
upd_list = group([
    item('SER', 'Coordinator · runs apps · serves models', PC, status('', 'Online') + c('7f3b2d4'), 'Computer.dc.html'),
    item('MacBook Pro', 'Takes tasks · updated itself 2 min ago', PC, status('', 'Up to date') + c('7f3b2d4')),
    item('bazzite', 'Takes tasks · runs apps · updates when its task finishes', PC, status('active', 'Waiting') + c('2a91c0e') + btn('Update now', 'quiet'))])
B['SelfUpdate.dc.html'] = ('compute', 'deploy.local updating itself: SER releases, other computers follow', app('compute', f'''
{head('Computers', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page" style="padding-top:8px">
  {compute_tabs('computers')}
  {page_head('Computers', '3 online · 1 updating', btn('Add a computer', 'primary', 'AddComputer.dc.html'))}
  <div class="dl-notice">{i('rocket', 16)}<span>deploy.local 7f3b2d4 is live on SER. The other computers update themselves to match, never in the middle of a task.</span><span class="dl-end">{btn('Release notes', 'quiet', 'ReleaseLive.dc.html')}</span></div>
  {upd_list}
  {section('How deploy.local updates', '', group([f'<div class="dl-inset">{setting("SER", "Released like any project: prepare, verify, activate, roll back", btn("deploy.local releases", "quiet", "ReleaseLive.dc.html"))}{setting("Other computers", "Update within 10 minutes of a release, when idle", sw("Auto-update computers"))}{setting("Desktop and iPhone apps", "Update on next launch; the desktop app updates its worker too", AUTO)}</div>']))}
</div></div>''', inbox=INBOX_AFTER_MERGE))

immich = b_live.B['ImmichApp.dc.html'][2]
update_body = f'''
  <div class="dl-dialog-head"><h2>Update Immich to 1.123.0?</h2>{ib('x', 'Close')}</div>
  <p class="dl-soft" style="margin:0">From the Immich publisher: faster face detection and shared albums. You are on 1.122.3.</p>
  {group([
    item('Back up first', 'Photos database, about 2 minutes', glyph('download'), c('Automatic')),
    item('Database migration', 'Can\'t be undone by switching versions, which is why the backup comes first', glyph('file'), c('Included')),
    item('Verify', 'Starts 1.123.0 on a copy and checks that it answers', glyph('shield'), c('Automatic')),
    item('Keep 1.122.3', 'Roll back to it, with that backup, for 7 days', glyph('undo'), c('7 days'))])}
  <div class="dl-notice">{i('clock', 16)}<span>Immich keeps running until the switch, then is unavailable for about 30 seconds. Warden checks it afterwards.</span></div>
  <div class="dl-dialog-foot">{btn('Not now', 'quiet')}{btn('Update Immich', 'primary')}</div>'''
B['UpdateApp.dc.html'] = ('projects', 'Updating an app from Discover: backup, verify, and a way back', dialog(immich, 'Update Immich', update_body))

# ---------- Removing a computer ----------
bazzite = app('compute', f'''
{head('bazzite', 'Computer', ib('terminal', 'Terminal') + ib('more', 'More'), PC)}
<div class="dl-scroll"><div class="dl-page">
  <div class="dl-page-head"><div class="dl-t"><h1 class="dl-title" style="display:flex;align-items:center;gap:10px">bazzite {status('', 'Online')}</h1><span class="dl-meta">Takes tasks · runs apps · AMD Ryzen 7 7840HS · 32 GB · deploy.local 2a91c0e</span></div>
  <span class="dl-end">{btn('Remove computer', 'danger')}</span></div>
  <div class="dl-cols">
    {section('Runs', '', group([item('Vaultwarden', 'App', APPG, status('', 'Healthy')), item('Miniflux', 'App and fetcher', APPG, status('', 'Healthy')), item('Fix the sync migration', 'Task · Codex', SPIN(), status('active', 'Running')), item('Backups', 'Destination for every project', glyph('download'), c('214 GB'), 'Backups.dc.html')]))}
    {section('Roles', '', group([f'<div class="dl-inset">{setting("Take tasks", "Codex signed in", sw("Take tasks"))}{setting("Run apps", "", sw("Run apps"))}{setting("Serve models", "", sw("Serve models", False))}{setting("Use the screen", "", sw("Use the screen", False))}</div>']))}
  </div>
</div></div>''')
remove_body = f'''
  <div class="dl-dialog-head"><h2>Remove bazzite?</h2>{ib('x', 'Close')}</div>
  <p class="dl-soft" style="margin:0">bazzite runs 2 apps, has 1 task, and holds your backups. These move first.</p>
  {group([
    item('Vaultwarden and Miniflux', 'Move to SER with their data · SER has room', APPG, c('Move')),
    item('Fix the sync migration', 'Pauses at its checkpoint and continues on MacBook Pro', SPIN(), c('Move')),
    item('Backups', 'Choose where they go next. Until you do, bazzite stays.', glyph('download'), btn('Choose…', 'quiet', 'Backups.dc.html'))])}
  <div class="dl-notice">{i('key', 16)}<span>Its key stops working right away. Nothing is erased from bazzite's disk; do that yourself if you are giving it away.</span></div>
  <div class="dl-dialog-foot">{btn('Cancel', 'quiet')}{btn('Move everything and remove', 'danger')}</div>'''
B['RemoveComputer.dc.html'] = ('compute', 'Removing a computer: what moves first, and what blocks it', dialog(bazzite, 'Remove bazzite', remove_body))
