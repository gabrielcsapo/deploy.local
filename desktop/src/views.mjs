import { liveLabel, shortFingerprint, trayModel } from './model.mjs';
export const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const button = (label, action, primary = false) =>
  `<button name="action" value="${action}" class="${primary ? 'primary' : ''}">${escape(label)}</button>`;
const row = (title, detail, end = '') =>
  `<div class="row"><span><b>${escape(title)}</b><small title="${escape(detail)}">${escape(detail)}</small></span>${end}</div>`;
const steps = (active) =>
  `<nav class="steps">${['Sign in', 'This computer', 'Permissions'].map((s, i) => `<span class="${i === active ? 'current' : ''}">${i < active ? '✓ ' : ''}${s}</span>`).join('<i></i>')}</nav>`;
export function render(state) {
  const error = state.error ? `<p role="alert" class="error">${escape(state.error)}</p>` : '';
  const name = escape(state.name || 'This computer');
  let content;
  if (state.page === 'connect')
    content = `${steps(0)}<h1>Connect to deploy.local</h1><p>Find your coordinator on your home network, or enter its address.</p><form><label>Coordinator<input name="address" required value="${escape(state.origin || 'https://deploy.local')}" autocomplete="url"></label><footer>${button('Find coordinator', 'connect', true)}</footer></form>`;
  else if (state.page === 'trust')
    content = `${steps(0)}<h1>Trust this coordinator?</h1><p>Compare this SHA-256 certificate fingerprint with the one shown on SER before continuing.</p><section>${row('Coordinator', state.origin)}${row('Certificate fingerprint', state.certificate?.fingerprint)}${row('Valid until', state.certificate?.expires)}</section><p class="notice">Trust applies only to this coordinator and this certificate. A changed certificate asks you again.</p><form><label class="check"><input name="confirmed" type="checkbox" required>I compared the fingerprint on the coordinator.</label><footer>${button('Back', 'back')}${button('Trust and continue', 'trust', true)}</footer></form>`;
  else if (state.page === 'signin')
    content = `${steps(0)}<h1>Sign in</h1><p>${escape(state.origin)}</p><form><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><footer>${button('Sign in', 'signin', true)}</footer></form>`;
  else if (state.page === 'takeover') {
    const local = state.appWorker || {};
    content = `${steps(1)}<h1>${escape(local.name || state.name)} already helps, from the command line</h1><p>A worker was installed on this Mac with the deploy command. This app can look after it instead. ${escape(local.name || state.name)} keeps its name in Computers, its apps and their addresses.</p><section>${row(local.name || state.name, 'In Computers · runs apps', `<small>${local.computer?.online ? 'Online' : 'Offline'}</small>`)}${(local.apps || []).map((app) => row(app.name, `${app.address || app.summary} · keeps answering during the move`, `<small>${escape(app.state === 'healthy' ? 'Healthy' : app.state)}</small>`)).join('')}${leftovers(local, false)}</section><p>Nothing changes until you choose. After the move, this app installs, updates and repairs the worker, and the deploy agent commands are no longer used on this Mac.</p><form><footer>${button('Leave it as it is', 'leave-worker')}${button('Move it to this app', 'take-over', true)}</footer></form>`;
  } else if (state.page === 'setup') {
    const selection = state.roles || { takeTasks: true };
    const mac = state.platform === 'darwin';
    const docker = state.appWorker?.docker;
    const hasDocker = mac && docker?.found;
    const runtime =
      { colima: 'Colima', 'docker-desktop': 'Docker Desktop', orbstack: 'OrbStack' }[
        docker?.runtime
      ] || 'Docker';
    const role = (key, title, detail, disabled = false) =>
      row(
        title,
        detail,
        `<input class="switch" type="checkbox" role="switch" aria-label="${title}" name="${key}" ${key === 'runApps' ? 'data-action="setup-run-apps"' : ''} ${selection[key] && (key !== 'runApps' || !disabled) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`,
      );
    content = `${steps(1)}<h1>Let ${name} help?</h1><p>You're signed in to deploy.local on ${escape(state.coordinatorName || new URL(state.origin).hostname)}. ${name} can also do work for your agents. It joins Computers, and you can change this ${mac ? 'there' : 'here'} anytime.</p><section>${row(state.name, state.hardware, '<small>This computer</small>')}${hasDocker ? row('Docker', `${runtime} is ${docker.answering ? 'running' : 'not running'} on this Mac`) : row('Claude', 'Availability is checked by the worker after joining') + row('Codex', 'Availability is checked by the worker after joining')}${leftovers(state.appWorker, true)}</section><form><section>${role('takeTasks', 'Take tasks', hasDocker ? 'Coding agents work here in their own folders. Sign in to Claude or Codex on this Mac first.' : 'Coding agents work here in their own folders, with your local accounts.')}${role('runApps', 'Run apps', mac ? (hasDocker ? 'Host apps from Projects, with the Docker above. They keep running when you quit this app and start again after a restart.' : 'Install Docker on this Mac to run apps.') : 'Not supported here yet.', !hasDocker)}${role('serveModels', 'Serve models', 'Needs runtime setup; the coordinator cannot enable this role yet.', true)}${role('useScreen', 'Use the screen', state.screenSupported ? 'Asks you each time. Needs Screen Recording and Accessibility.' : state.platform === 'darwin' ? (state.arch === 'x64' ? 'Use the screen is not supported in this Intel build yet.' : 'The macOS control helper is not included in this build.') : 'Not supported on Windows or Linux yet.', !state.screenSupported)}</section><small class="footnote">${hasDocker ? 'This app installs the worker and looks after it: updates, repairs and removal all happen here, and its state is in the menu bar.' : 'The worker keeps running when you close the window. Pause or quit it from the tray.'}</small><footer>${button('Just use the app', 'skip')}${button(`Add ${state.name}`, 'join', true)}</footer></form>`;
  } else if (state.page === 'permissions')
    content = `${steps(2)}<h1>Let agents use the screen?</h1><p>Optional. macOS needs two permissions before an agent can see and control an app on this Mac, such as Simulator for checking an iPhone build.</p><form><section>${row('Screen Recording', 'See the one app a task is allowed to use', button('Open System Settings', 'screen-settings'))}${row('Accessibility', 'Click and type in that app', button('Open System Settings', 'accessibility-settings'))}</section><p class="notice">deploy.local can't turn these on itself, and they don't let agents in on their own. Each task still asks you, for one app at a time.</p><footer>${button('Skip for now', 'finish')}${button('Finish', 'finish', true)}</footer></form>`;
  else if (state.page === 'certificate-changed') {
    const certificate = state.certificate || {};
    const host = new URL(state.origin).hostname;
    const coordinator = escape(state.coordinatorName || host);
    const day = (value) =>
      new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const since = (value) => {
      const date = new Date(value);
      const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return new Date().toDateString() === date.toDateString()
        ? `today at ${time}`
        : `${day(value)} at ${time}`;
    };
    content = `<h1>${coordinator} has a new certificate</h1><p>This app only talks to ${coordinator} when its certificate is the one you trusted. ${coordinator} now shows a different one, so deploy.local is paused on this Mac until you check it.</p><section>${row(state.coordinatorName || host, [host, certificate.address].filter((v, i, all) => v && all.indexOf(v) === i).join(' · '), '<span class="status"><span class="dot"></span>Answering</span>')}<div class="row"><span><b>Trusted before</b><small class="mono">${escape(shortFingerprint(certificate.previous))}</small></span></div>${certificate.issued ? row('Shown now', `New since ${since(certificate.issued)} · valid until ${day(certificate.expires)}`) : ''}</section><div class="approval"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg><div><h2>Trust ${coordinator}'s new certificate?</h2><p>This is expected after ${coordinator} renews its certificate or deploy.local is reinstalled there. Check that these characters match the ones on ${coordinator}'s screen, or run <code>deploy status --fingerprint</code> on ${coordinator}.</p><div class="well mono" title="${escape(certificate.fingerprint)}">${escape(shortFingerprint(certificate.fingerprint))}</div><p>If they don't match, or nothing changed on ${coordinator}, don't trust it: something else may be answering at this address.</p><form>${button('They match · trust it', 'trust-changed', true)}<button name="action" value="switch" class="quiet">Use another address</button></form></div></div><small class="footnote">You stay signed in. The worker on this Mac reconnects with the new certificate too.</small>`;
  } else if (state.page === 'offline')
    content = `<div class="empty"><span class="glyph">☁</span><h2>Can't reach ${escape(state.coordinatorName || 'your coordinator')}</h2><p>deploy.local runs on ${escape(state.coordinatorName || 'your coordinator')} at ${escape(new URL(state.origin).hostname)}. It stopped answering${state.lastSeen ? ` at ${escape(new Date(state.lastSeen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}. Retrying every 10 s.</p><form>${button('Try now', 'retry', true)}${button('Use another coordinator', 'switch')}</form></div><h2>On this computer</h2><section>${state.runningTask ? row('Your task', `${state.runningTask.title ? state.runningTask.title + ' · ' : ''}Paused at its last checkpoint`, '<small>Paused</small>') : row('Worker', state.worker?.state || 'Unavailable')}${row('Last known', state.lastSeen ? `${state.inbox?.length || 0} waiting on you · ${liveLabel(state.summary)}` : 'Unavailable', '<small>Saved</small>')}${row('Drafts', 'Return to the web app when the coordinator reconnects.')}</section><small>If it stays down, check its power and network, or run deploy status on the coordinator.</small>`;
  else if (state.page === 'tray') content = renderTray(state);
  else if (state.page === 'decision')
    content = `<h1>${escape(state.item?.title)}</h1><p>${escape(state.item?.text)}</p><small>From ${escape(state.item?.from)} · Waiting on you</small><form><input type="hidden" name="itemId" value="${escape(state.item?.id)}">${state.item?.kind === 'question' ? '<label>Your answer<textarea name="note"></textarea></label>' : ''}<footer>${(state.item?.actions || []).map((action) => `<button name="action" value="answer:${escape(action.id)}" class="${action.primary ? 'primary' : ''}">${escape(action.label)}</button>`).join('')}${button('Back', 'home')}</footer></form>`;
  else if (state.page === 'watch')
    content = `<div class="control-bar"><span class="recording"></span><span>${escape(state.control?.label || 'Agent is using the screen')}</span><span>${escape(state.control?.elapsed || '')}</span><form>${button('Pause', 'pause-control')}${button('Stop', 'stop-control', true)}</form></div>`;
  if (state.workerProgress && ['setup', 'takeover', 'tray'].includes(state.page))
    content = content?.replace(/<(button|input)\b/g, '<$1 disabled');
  return `<main class="${state.page === 'tray' ? (state.platform === 'darwin' && state.appWorker?.install && state.appWorker.install !== 'none' ? 'tray runs-apps' : 'tray') : state.page === 'watch' ? 'watch' : ''}">${content || ''}${state.workerProgress ? `<p role="status" class="notice">${escape(state.workerProgress)}</p>` : ''}${error}</main>`;
}

function leftovers(local, removable) {
  return (local?.leftover || [])
    .map((entry) =>
      row(
        'An older copy that no longer starts',
        `Installed for all users. Removing it asks for your Mac password. ${entry.path}`,
        removable && local.install === 'desktop'
          ? `<form><input type="hidden" name="path" value="${escape(entry.path)}">${button('Remove older copy', 'remove-leftover')}</form>`
          : '<small>Left over</small>',
      ),
    )
    .join('');
}

const paths = {
  attention: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  running: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  new: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  open: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
};
const icon = (name) =>
  `<svg class="icon ${name}" width="${name === 'attention' || name === 'running' ? 14 : 16}" height="${name === 'attention' || name === 'running' ? 14 : 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${name === 'attention' ? 'role="img" aria-label="Needs you"' : 'aria-hidden="true"'}>${paths[name]}</svg>`;
const trayText = (title, detail) =>
  `<span class="tray-text"><span>${escape(title)}</span>${detail ? `<small title="${escape(detail)}">${escape(detail)}</small>` : ''}</span>`;
const status = (label, kind = '') =>
  `<span class="status ${kind}"><span class="dot"></span>${escape(label)}</span>`;
const trayAction = (content, action, hidden = '') =>
  `<form>${hidden}<button class="tray-row" name="action" value="${escape(action)}">${content}</button></form>`;
function renderTray(state) {
  const model = trayModel(state),
    shortcut = state.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const coordinator =
    model.coordinator ||
    state.coordinatorName ||
    (state.origin ? new URL(state.origin).hostname : 'Coordinator');
  const connection = `${coordinator}${model.computersOnline === undefined ? '' : ` · ${model.computersOnline} computers online`}`;
  const doing = model.computer?.doing || [];
  const tasks = doing.filter((entry) => entry.kind === 'task');
  const activity = tasks.length
    ? `Running ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`
    : state.worker?.state || 'Unavailable';
  // Apps have their own row above; this one is only about tasks.
  const detail = tasks.map((entry) => entry.name).join(' · ');
  const local =
    state.platform === 'darwin' && state.appWorker?.install !== 'none' ? state.appWorker : null;
  const localApps = local?.apps || [];
  const names = localApps.map((app) => app.name).join(', ');
  const failing = local && local.state !== 'running';
  const localTitle = failing
    ? names
      ? `${names} ${localApps.length === 1 ? 'is' : 'are'} not answering`
      : 'This computer needs repair'
    : `Running ${localApps.length} ${localApps.length === 1 ? 'app' : 'apps'}`;
  const localDetail = failing
    ? local.sentence
    : `${names}${names ? ' · ' : ''}${localApps.every((app) => app.state === 'healthy') ? 'healthy' : 'needs attention'}`;
  return `<header class="tray-row tray-heading"><span class="mark">d</span>${trayText('deploy.local', connection)}${status(state.online ? 'Connected' : 'Offline', state.online ? '' : 'offline')}</header>
<hr><div class="label"><span>Waiting on you</span><span>${model.count}</span></div>
${model.items.map((item) => trayAction(`${icon('attention')}${trayText(item.title, [item.from, item.text].filter(Boolean).join(' · '))}<time class="key" datetime="${escape(item.createdAt)}">${escape(item.time)}</time>`, 'review', `<input type="hidden" name="itemId" value="${escape(item.id)}">`)).join('') || '<div class="tray-row muted">No decisions waiting</div>'}
<hr><div class="label"><span>Live</span><span>${escape(model.running)}</span></div>
${model.apps.map((entry) => trayAction(`${icon('apps')}${trayText(entry.name, entry.summary)}${status(entry.label, entry.state)}`, 'live-app', `<input type="hidden" name="appId" value="${escape(entry.appId)}">`)).join('') || trayAction(trayText('Open Live', model.live), 'live')}
<hr><div class="label"><span>This computer</span><form><button class="roles-link" name="action" value="roles" aria-label="Computer roles">${escape(state.name || 'This computer')}</button></form></div>
${local ? `<div class="tray-row worker-health">${icon('apps')}${trayText(localTitle, localDetail)}${failing ? status('Failing', 'failing') : ''}</div>${failing ? `${local.state === 'docker-not-answering' ? trayAction(trayText('Restart Docker', local.docker.runtime === 'colima' ? `Stops and starts Colima. ${names || 'Your apps'} ${localApps.length === 1 ? 'comes' : 'come'} back by ${localApps.length === 1 ? 'itself' : 'themselves'}.` : 'Docker on this computer has to be restarted by hand.'), 'restart-docker') : ''}${trayAction(trayText('Repair the worker', `Installs it again from ${coordinator}. Apps and addresses stay.`), 'repair-worker')}` : `<form><label class="tray-row task-switch">${icon('computer')}${trayText('Run apps', local.sentence)}<input class="switch" type="checkbox" role="switch" name="runApps" data-action="run-apps" aria-label="Run apps" ${local.enabled ? 'checked' : ''} ${!state.online || local.install !== 'desktop' ? 'disabled' : ''}></label></form>`}` : ''}
${
  !local || tasks.length || state.worker?.roles?.takeTasks
    ? `<div class="tray-row">${icon(tasks.length ? 'running' : 'computer')}${trayText(activity, detail)}</div>
<form><label class="tray-row task-switch">${icon('computer')}${trayText('Take new tasks', 'Current tasks keep running')}<input class="switch" type="checkbox" role="switch" name="takeTasks" data-action="take-tasks" aria-label="Take new tasks" ${model.computer?.roles.includes('take-tasks') ? 'checked' : ''} ${!state.online || !model.computer ? 'disabled' : ''}></label></form>`
    : ''
}
<hr>${trayAction(`${icon('new')}${trayText('New task')}<span class="key">${shortcut}N</span>`, 'new-task')}
${trayAction(`${icon('open')}${trayText('Open deploy.local')}<span class="key">${shortcut}O</span>`, 'home')}
${trayAction(`${trayText('Quit', local ? 'Apps keep running. Tasks wait until you open the app again.' : 'The worker stops until you open the app again')}<span class="key">${shortcut}Q</span>`, 'quit')}`;
}
