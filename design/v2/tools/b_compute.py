from shell import *

B = {}
PC = '<span class="dl-glyph plain">' + i('compute', 12) + '</span>'

def compute_tabs(on):
    return tabs([('computers', 'Computers', 'Compute.dc.html', '3'), ('models', 'Models', 'Models.dc.html', ''), ('add', 'Add a computer', 'AddComputer.dc.html', '')], on)

computers = group([
    item('SER', 'Coordinator · runs apps · serves models · Ryzen AI 9 HX 470, 45 GB', PC, status('', 'Online') + c('Disk 61%'), 'Computer.dc.html'),
    item('MacBook Pro', 'Takes tasks · Claude signed in · uses the screen when asked', PC, status('active', 'Running 1 task') + c('Self-release pipeline'), 'Computer.dc.html'),
    item('bazzite', 'Takes tasks · runs apps · Codex signed in', PC, status('active', 'Running 1 task') + c('Fix the sync migration'), 'Computer.dc.html')])

B['Compute.dc.html'] = ('compute', 'Computers', app('compute', f'''
{head('Computers', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page" style="padding-top:8px">
  {compute_tabs('computers')}
  {page_head('Computers', '3 online · 2 of 3 busy', btn('Add a computer', 'primary', 'AddComputer.dc.html'))}
  {computers}
  <div class="dl-notice">{i('chip', 16)}<span>A task goes to any free computer that takes tasks and is signed in to the model it needs. Which model does what is set once, on Models.</span><span class="dl-end">{btn('Models', 'quiet', 'Models.dc.html')}</span></div>
</div></div>'''))

B['Computer.dc.html'] = ('compute', 'One computer', app('compute', f'''
{head('SER', 'Computer', ib('terminal', 'Terminal') + ib('more', 'More'), PC)}
<div class="dl-scroll"><div class="dl-page">
  <div class="dl-page-head"><div class="dl-t"><h1 class="dl-title" style="display:flex;align-items:center;gap:10px">SER {status('', 'Online')}</h1><span class="dl-meta">Coordinator · Linux · Ryzen AI 9 HX 470 · Radeon 890M · 45 GB · deploy.local 2a91c0e</span></div>
  <span class="dl-end">{btn('Open terminal')}</span></div>
  <div class="dl-stats">
    <div class="dl-stat"><span class="dl-meta">CPU</span><span class="dl-v">14%</span><div class="dl-bar"><span style="width: 14%"></span></div></div>
    <div class="dl-stat"><span class="dl-meta">Memory</span><span class="dl-v">17 of 45 GB</span><div class="dl-bar"><span style="width: 38%"></span></div></div>
    <div class="dl-stat"><span class="dl-meta">Disk</span><span class="dl-v">580 of 950 GB</span><div class="dl-bar"><span style="width: 61%"></span></div></div>
  </div>
  <div class="dl-cols">
    {section('Runs', '', group([item('deploy.local', 'App · 2a91c0e', i('app', 16), status('', 'Healthy')), item('home-gym', 'Web app and sync worker · 9c3e1fa', i('app', 16), status('failed', '1 of 2 failing'), 'App.dc.html'), item('recipes', 'App', i('app', 16), status('inactive', 'Stopped')), item('Lemonade', 'Local models · 4 loaded', i('chip', 16), status('', 'Serving'), 'Models.dc.html')]))}
    {section('Roles', '', group([f'<div class="dl-inset">{setting("Coordinator", "Runs deploy.local itself · edge on 443 and 80", "<span class=\"dl-tag\">Always on</span>")}{setting("Take tasks", "Not signed in to Claude or Codex here", sw("Take tasks", False))}{setting("Run apps", "", sw("Run apps"))}{setting("Serve models", "Lemonade · 4 loaded", sw("Serve models"))}{setting("Use the screen", "", sw("Use the screen", False))}</div>']))}
  </div>
  <div class="dl-notice">{i('rocket', 16)}<span>deploy.local 2a91c0e runs the coordinator here. Its releases, updates and rollbacks are on the deploy.local project, like any other project.</span><span class="dl-end">{btn('Releases', 'quiet', 'Deployments.dc.html')}</span></div>
</div></div>'''))

B['Models.dc.html'] = ('compute', 'Models and subscriptions', app('compute', f'''
{head('Models', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page" style="padding-top:8px">
  {compute_tabs('models')}
  {section('On your computers', 'Free. Runs on SER with Lemonade.', group([
    item('Qwen3-8B', 'Chat and tools · about 15 tokens a second · used by Scout and Warden for tracking', i('chip', 16), '<span class="dl-tag">Default local</span>'),
    item('Whisper Large v3 Turbo', 'Speech to text · voice messages', i('mic', 16), c('Loaded')),
    item('Kokoro', 'Text to speech', i('chip', 16), c('Loaded')),
    item('Flux', 'Images', i('chip', 16), c('Not loaded') + btn('Load', 'quiet'))], 'SER · Lemonade 11.9', status('', 'Serving')))}
  {section('Subscriptions', 'Counted against your plan limits.', group([
    item('Claude', 'Opus · on MacBook Pro', '<span class="dl-glyph plain">C</span>', '<span style="width:120px" class="dl-bar"><span style="width: 42%"></span></span>' + c('42% of weekly limit')),
    item('Codex', 'GPT-6.1-Sol · on bazzite', '<span class="dl-glyph plain">X</span>', '<span style="width:120px" class="dl-bar"><span style="width: 18%"></span></span>' + c('18% of weekly limit'))]))}
  {section('Who used them this week', 'Subscription use by agent. Local models are free and not counted.', group([
    item('Scout', '12 coding tasks on Claude · 9 reviews on Codex', S_GLYPH, '<span style="width:96px" class="dl-bar"><span style="width: 90%"></span></span>' + c('38% Claude · 18% Codex')),
    item('You', '2 tasks you started', '<span class="dl-avatar" style="width:20px;height:20px;font-size:10px">G</span>', '<span style="width:96px" class="dl-bar"><span style="width: 10%"></span></span>' + c('4% Claude')),
    item('Warden', 'Health checks and rollback plans on Qwen3-8B', W_GLYPH, c('Local · free'))]))}
  {section('Which model does what', 'The one place this is set. Agents use it unless an override is listed below.', group([f'<div class="dl-inset">{setting("Tracking, briefs and triage", "", "Qwen3-8B · local")}{setting("Writing code", "", "Opus")}{setting("Reviewing", "Always a different model than the author", "GPT-6.1-Sol")}{setting("If a subscription runs out", "", "Queue until it resets")}</div>']))}
  {section('Agent overrides', '', group([item('Scout', 'Uses the settings above', S_GLYPH, btn('Add override', 'quiet')), item('Warden', 'Qwen3-8B for everything, so watching costs nothing', W_GLYPH, '<span class="dl-tag">1 override</span>' + btn('Edit', 'quiet'))]))}
</div></div>'''))

B['AddComputer.dc.html'] = ('compute', 'Add a computer', f'''<div style="position:relative;height:100vh;min-height:560px;overflow:hidden">{app('compute', f"""
{head('Computers', '', ib('search', 'Search'))}
<div class="dl-scroll"><div class="dl-page" style="padding-top:8px">{compute_tabs('add')}{page_head('Computers', '3 online · 2 of 3 busy', btn('Add a computer', 'primary'))}{computers}</div></div>""")}
<div class="dl-scrim"><div class="dl-dialog dl-sheet" role="dialog" aria-label="Add a computer">
  <div class="dl-dialog-head"><h2>Add a computer</h2>{ib('x', 'Close')}</div>
  <p class="dl-soft" style="margin:0">Install the deploy.local app on the computer you want to add and sign in. It asks which roles to take: Take tasks, Run apps, Serve models, Use the screen.</p>
  <div style="display:flex;gap:8px;flex-wrap:wrap">{btn('Download for Mac', 'primary')}{btn('Linux')}{btn('Windows')}</div>
  <div><span class="dl-field-label">For a server without a screen</span><pre class="dl-term wrap" style="margin:0">curl -fsSL https://deploy.local/install | sh -s -- --join 7KQ2-M9XD</pre>
  <p class="dl-meta" style="margin:6px 0 0">Same as deploy computer join. Roles are chosen on the computer's page once it connects.</p></div>
  <div class="dl-notice">{SPIN()}<span>Waiting for a computer to connect with code 7KQ2-M9XD…</span></div>
  <div class="dl-dialog-foot">{btn('Copy command', 'quiet')}{btn('Done')}</div>
</div></div></div>''')

def settings(on, body, **state):
    cats = [('general', 'General', 'Settings.dc.html', 'settings'), ('account', 'Account and SSH keys', 'Settings.dc.html', 'key'), ('agents', 'Agents and approvals', 'SettingsAgents.dc.html', 'shield'), ('notifications', 'Notifications', '#', 'bell'), ('backups', 'Backups', 'Backups.dc.html', 'download'), ('design', 'Design system', 'DesignSystem.dc.html', 'app')]
    nav_ = ''.join(nav(t, h, k == on, i(ic)) for k, t, h, ic in cats)
    return app('settings', f'''
{head('Settings')}
<div class="dl-scroll"><div class="dl-page" style="flex-direction:row;flex-wrap:wrap;gap:32px;align-items:flex-start">
  <nav aria-label="Settings" style="flex:0 1 200px;display:flex;flex-direction:column">{nav_}</nav>
  <div style="flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:32px">{body}</div>
</div></div>''', **state)

B['Settings.dc.html'] = ('settings', 'Settings', settings('general', f'''
{section('Appearance', '', group([f'<div class="dl-inset">{setting("Theme", "", "<div class=\"dl-seg\"><a href=\"#\">Light</a><a href=\"#\">Dark</a><a href=\"#\" class=\"on\">System</a></div>")}{setting("Text size", "In conversations", "<div class=\"dl-seg\"><a href=\"#\">Small</a><a href=\"#\" class=\"on\">Default</a><a href=\"#\">Large</a></div>")}</div>']))}
{section('Account', '', group([f'<div class="dl-inset">{setting("Gabriel J. Csapo", "Signed in on 3 computers and 1 phone", btn("Sign out", "quiet"))}</div>']))}
{section('SSH keys', 'For Git over SSH to deploy.local.', group([item('MacBook Pro', 'ssh-ed25519 · SHA256:q9T…4kE · added Oct 21', i('key', 16), btn('Remove', 'quiet')), item('bazzite', 'ssh-ed25519 · SHA256:Lm2…x8A · added Oct 19', i('key', 16), btn('Remove', 'quiet'))], 'Keys', btn('Add key', 'quiet')))}'''))

B['SettingsAgents.dc.html'] = ('settings', 'Agents and approvals', settings('agents', f'''
{section('Approvals', 'What every agent asks before doing. Each agent can be stricter.', group([f'<div class="dl-inset">{setting("Merge a pull request", "", "Ask me")}{setting("Roll back a release", "Every app in the project goes back together", "Ask me")}{setting("Start a task", "", "Allowed")}{setting("Use a computer\'s screen", "", "Ask me each time")}</div>']))}
{section('Agents', '', group([item('Scout', 'Dev loop · deploy.local · morning brief at 7:00', S_GLYPH, btn('Tune', 'quiet', 'Configure.dc.html')), item('Warden', 'Ops · all apps and computers · checks every minute', W_GLYPH, btn('Tune', 'quiet'))], 'Your agents', btn('New agent', 'quiet')))}
{section('When something needs you', '', group([f'<div class="dl-inset">{setting("Notify on this Mac", "", sw("Mac"))}{setting("Notify on iPhone", "", sw("Phone"))}{setting("Quiet hours", "10 PM to 7 AM, except rollbacks", sw("Quiet"))}</div>']))}'''))

B['Models.dc.html'] = B['Models.dc.html'] + (1440, 1300)
