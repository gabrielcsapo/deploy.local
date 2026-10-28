from shell import *
import b_cli as T
from b_setup import field

B = {}
BACK = lambda href: ph_btn('back', 'Back', href)

# ---------- Installing deploy.local on SER: the very first step ----------
install_lines = [
    T.prompt('curl -fsSL https://github.com/gabrielcsapo/deploy.local/\\', 'gabriel@ser ~'),
    '    releases/latest/download/install.sh | sh',
    f'{T.BO("deploy.local")} {T.D("· installing the coordinator on this computer")}',
    '',
    f'  {T.OKc()} Docker 27.3                   {T.D("running")}',
    f'  {T.OKc()} Ports 80 and 443              {T.D("free")}',
    f'  {T.OKc()} Disk                          {T.D("950 GB, 580 GB free")}',
    '',
    f'Start fresh, or recover from a backup? {T.D("[F/r]")} {T.BO("f")}',
    f'Name this computer: {T.BO("SER")}',
    '',
    f'  {T.OKc()} Installed deploy.local 2a91c0e  {T.D("as a system service")}',
    f'  {T.OKc()} Made a certificate authority  {T.D("for *.deploy.local")}',
    f'  {T.OKc()} Announced deploy.local        {T.D("on your network")}',
    '',
    f'{T.OKc()} {T.BO("SER is ready.")} Finish setup from any computer at home:',
    f'  {T.AC("https://deploy.local/setup")}   code {T.BO("4QX7-PL2M")}',
    f'  {T.D("Certificate: 4F:A2:19:C7:0B:E3 · 88:D1:5E:42:9C:07")}',
]
recover_lines = [
    T.prompt('curl -fsSL …/install.sh | sh', 'gabriel@new-ser ~'),
    f'Start fresh, or recover from a backup? {T.D("[F/r]")} {T.BO("r")}',
    '',
    f'Where is the backup?',
    f'  {T.AC("›")} bazzite:/mnt/backup        {T.D("found on your network · last night 3:00 AM")}',
    f'    USB drive or another folder',
    f'Recovery passphrase: {T.D("••••••••••••")}',
    '',
    f'  {T.OKc()} Unlocked the backup           {T.D("Oct 27, 3:00 AM")}',
    f'  {T.OKc()} Restored projects and secrets {T.D("6 projects")}',
    f'  {T.OKc()} Restored certificate          {T.D("phones and computers trust it already")}',
    f'  {T.RU()} Restoring app data            {T.D("Immich 212 GB · 41%")}',
    '',
    f'{T.D("Apps start one at a time as their data lands.")}',
    f'{T.D("Follow along at")} {T.AC("https://deploy.local/recover")}',
]
B['InstallSer.dc.html'] = ('cli', 'CLI — installing deploy.local on SER, or recovering it', T.board('first install', 'One command on SER, then a browser.',
    'The installer checks the computer, asks one question (start fresh or recover), and makes its own certificate. Setup finishes in a browser on any computer at home, using the code it prints, so no password is typed into a terminal.',
    f'''<div class="t-row" style="grid-template-columns:repeat(2,minmax(0,1fr))">
  <div>{T.cap('Start fresh', 'Installs the service, the certificate authority, and announces deploy.local')}{T.term('ser — ssh', install_lines, 440)}</div>
  <div>{T.cap('Recover from a backup', 'After losing SER: same installer, the backup on bazzite, your passphrase')}{T.term('new-ser — ssh', recover_lines, 440)}</div>
</div>''', 780), 1440, 780)

# The browser step: create the first account on SER.
def bare(body):
    return f'<div class="dl-sheet" style="min-height:100vh;display:flex;justify-content:center;padding:72px 24px"><div style="width:100%;max-width:440px;display:flex;flex-direction:column;gap:20px">{body}</div></div>'
B['FirstAccount.dc.html'] = ('start', 'Finishing setup in a browser: the first account on SER', bare(f'''
<div style="display:flex;align-items:center;gap:10px"><span class="dl-mark" style="width:32px;height:32px;border-radius:9px;font-size:15px">d</span><span class="dl-strong" style="font-size:15px">deploy.local</span></div>
<div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">Set up SER</h1><span class="dl-soft">SER is running deploy.local. Create the first account; it owns everything here.</span></div>
{group([item('SER', 'Coordinator · deploy.local 2a91c0e · just installed', '<span class="dl-glyph plain">' + i('compute', 12) + '</span>', status('', 'Ready'))])}
{field('code', 'Setup code from SER', '4QX7-PL2M', end=OK(), mono=True, hint='Printed by the installer. It works once, for 30 minutes.')}
{field('name', 'Your name', 'Gabriel')}
{field('user', 'Username', 'gabriel')}
{field('pw', 'Password', '••••••••••••••', kind='password', hint='At least 12 characters. It always works, on any device.')}
{btn('Create account', 'primary')}
<span class="dl-meta">Next, your browser asks to trust SER's certificate. The fingerprint is the one the installer printed. Once it does, you can add a passkey.</span>'''))

# After the browser trusts SER: offered once, on Home, never required.
home = __import__('b_work').B['Home.dc.html'][2]
offer = f'''<div style="padding:12px 24px 0"><div class="dl-banner">{i('key', 16)}<span class="dl-t" style="flex:1">This browser now trusts SER, so you can sign in with a passkey instead of your password.</span>{btn('Not now', 'quiet')}{btn('Add a passkey', 'primary')}</div></div>'''
anchor = '<div class="dl-scroll"'
B['PasskeyOffer.dc.html'] = ('start', 'After the certificate is trusted: a passkey is offered once, never required', home.replace(anchor, offer + anchor, 1))

# The browser while SER recovers: what is back, what is still coming.
def rrow(name, sub, state):
    lead = {'done': OK(), 'run': SPIN(), 'wait': f'<span style="display:inline-flex;color:var(--muted)">{i("clock", 16)}</span>'}[state]
    end = {'done': status('', 'Running'), 'run': status('active', 'Restoring'), 'wait': c('Waiting')}[state]
    return item(name, sub, lead, end)
B['RecoverWeb.dc.html'] = ('start', 'Recovering SER: apps come back one at a time', bare(f'''
<div style="display:flex;align-items:center;gap:10px"><span class="dl-mark" style="width:32px;height:32px;border-radius:9px;font-size:15px">d</span><span class="dl-strong" style="font-size:15px">deploy.local</span></div>
<div style="display:flex;flex-direction:column;gap:6px"><h1 class="dl-title">Recovering SER</h1><span class="dl-soft">From last night's backup on bazzite. Your account, projects, agents and secrets are already back; app data is landing now.</span></div>
{group([rrow('deploy.local', 'Coordinator · 2a91c0e', 'done'), rrow('home-gym', 'Web app and sync worker · 81be0d2 · Postgres 1.2 GB', 'done'),
        rrow('Vaultwarden', 'On bazzite, untouched', 'done'), rrow('Immich', 'Photos 212 GB · 41% · about 18 min left', 'run'),
        rrow('Miniflux', 'Waiting for Immich to finish', 'wait'), rrow('recipes', 'Was stopped; stays stopped', 'wait')], 'Projects')}
<div class="dl-notice">{i('shield', 16)}<span>Warden checks each app as it starts. Your phones and computers reconnect on their own; the certificate is the same one.</span></div>
{btn('Sign in', 'primary')}'''))

# ---------- iPhone when SER can't be reached ----------
grey = lambda html: f'<div style="opacity:.55">{html}</div>'
B['OfflinePhone.dc.html'] = ('phone', 'iPhone — SER can\'t be reached: last known state, and why', phone('', f'''
<div style="padding:0 16px"><div class="dl-banner warning">{i('cloud', 16)}<span class="dl-t"><span>Can't reach SER</span><span>Last heard from at 2:41 PM. Retrying.</span></span></div></div>
<div class="dl-ph-label">Waiting on you · last known</div>
{grey(f'<div class="dl-ph-group">{ph_row("Roll back home-gym?", "Warden · sync worker failing", ATTN(18), "2:14")}{ph_row("Merge PR #18", "Scout · reviewed", ATTN(18), "2:28")}</div>')}
<span class="dl-meta" style="display:block;padding:8px 32px 0;font-size:13px;line-height:18px">You can read these, but answers need SER. Anything you write is sent when it's back.</span>
<span class="dl-meta" style="display:block;padding:12px 32px 0;font-size:13px;line-height:18px">deploy.local works on your home network. Away from home, this is what you'll see.</span>
''', 'work', '', '', 'Work', ph_composer('Sends when SER is back')))

# ---------- iPhone: a release that fails verification ----------
SKIP = lambda: f'<span style="display:inline-flex;color:var(--muted)">{i("x", 14)}</span>'
B['ReleaseFailedPhone.dc.html'] = ('phone', 'iPhone — a release failed verification: nothing changed', phone('home-gym releases', f'''
<div style="padding:0 16px"><div class="dl-banner danger">{i('x', 16)}<span class="dl-t"><span>Verify failed. Nothing changed.</span><span>home-gym is still on 81be0d2.</span></span></div></div>
<div class="dl-ph-label">b81e4c0 · Add rest-timer sounds</div>
<div style="padding:0 20px"><ul class="dl-steps">{''.join(f'<li class="dl-step"><span class="dl-i">{ic}</span><span class="dl-t">{t}</span></li>' for ic, t in ((OK(14), 'Prepared both apps'), (FAIL(14), 'Web app returned 500 on the copy'), (SKIP(), 'Activate · skipped'), (SKIP(), 'Watch · skipped')))}</ul></div>
<pre class="dl-term wrap" style="margin:12px 16px 0;font-size:12px;line-height:18px">Error: REST_SOUNDS_URL is not set
  at loadConfig (src/config.ts:12)</pre>
<span class="dl-meta" style="display:block;padding:10px 32px 0;font-size:13px;line-height:18px">Variables are changed on a computer, in the project's settings.</span>
''', 'projects', BACK('ProjectPhone.dc.html'), '', '', f'<div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">{btn("Ask Scout to fix it", "primary")}{btn("Full log")}</div>'))
