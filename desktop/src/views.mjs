import { liveLabel, trayModel } from './model.mjs';
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
  else if (state.page === 'setup') {
    const selection = state.roles || { takeTasks: true };
    const role = (key, title, detail, disabled = false) =>
      row(
        title,
        detail,
        `<input class="switch" type="checkbox" role="switch" aria-label="${title}" name="${key}" ${selection[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`,
      );
    content = `${steps(1)}<h1>Let ${name} help?</h1><p>You're signed in to deploy.local on ${escape(state.coordinatorName || new URL(state.origin).hostname)}. ${name} can also do work for your agents. It joins Computers, and you can change this here anytime.</p><section>${row(state.name, state.hardware, '<small>This computer</small>')}${row('Claude', 'Availability is checked by the worker after joining')}${row('Codex', 'Availability is checked by the worker after joining')}</section><form><section>${role('takeTasks', 'Take tasks', 'Coding agents work here in their own folders, with your local accounts.')}${role('runApps', 'Run apps', 'Needs runtime setup; the coordinator cannot enable this role yet.', true)}${role('serveModels', 'Serve models', 'Needs runtime setup; the coordinator cannot enable this role yet.', true)}${role('useScreen', 'Use the screen', state.screenSupported ? 'Asks you each time. Needs Screen Recording and Accessibility.' : state.platform === 'darwin' ? 'The macOS control helper is not included in this build.' : 'Not supported on Windows or Linux yet.', !state.screenSupported)}</section><small class="footnote">The worker keeps running when you close the window. Pause or quit it from the tray.</small><footer>${button('Just use the app', 'skip')}${button(`Add ${state.name}`, 'join', true)}</footer></form>`;
  } else if (state.page === 'permissions')
    content = `${steps(2)}<h1>Let agents use the screen?</h1><p>Optional. macOS needs two permissions before an agent can see and control an app on this Mac, such as Simulator for checking an iPhone build.</p><form><section>${row('Screen Recording', 'See the one app a task is allowed to use', button('Open System Settings', 'screen-settings'))}${row('Accessibility', 'Click and type in that app', button('Open System Settings', 'accessibility-settings'))}</section><p class="notice">deploy.local can't turn these on itself, and they don't let agents in on their own. Each task still asks you, for one app at a time.</p><footer>${button('Skip for now', 'finish')}${button('Finish', 'finish', true)}</footer></form>`;
  else if (state.page === 'offline')
    content = `<div class="empty"><span class="glyph">☁</span><h2>Can't reach ${escape(state.coordinatorName || new URL(state.origin).hostname)}</h2><p>${escape(state.origin)} stopped answering${state.lastSeen ? ` at ${escape(new Date(state.lastSeen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}. Retrying every 10 s.</p><form>${button('Try now', 'retry', true)}${button('Use another coordinator', 'switch')}</form></div><h2>On this computer</h2><section>${row('Worker', state.worker?.state || 'Unavailable')}${row('Last known', state.lastSeen ? `${state.inbox?.length || 0} waiting on you · ${liveLabel(state.summary)}` : 'Unavailable', '<small>Saved</small>')}${row('Drafts', 'Return to the web app when the coordinator reconnects.')}</section><small>If it stays down, check its power and network, or run deploy status on the coordinator.</small>`;
  else if (state.page === 'tray') content = renderTray(state);
  else if (state.page === 'decision')
    content = `<h1>${escape(state.item?.title)}</h1><p>${escape(state.item?.text)}</p><small>From ${escape(state.item?.from)} · Waiting on you</small><form><input type="hidden" name="itemId" value="${escape(state.item?.id)}">${state.item?.kind === 'question' ? '<label>Your answer<textarea name="note"></textarea></label>' : ''}<footer>${(state.item?.actions || []).map((action) => `<button name="action" value="answer:${escape(action.id)}" class="${action.primary ? 'primary' : ''}">${escape(action.label)}</button>`).join('')}${button('Back', 'home')}</footer></form>`;
  else if (state.page === 'watch')
    content = `<div class="control-bar"><span class="recording"></span><span>${escape(state.control?.label || 'Agent is using the screen')}</span><span>${escape(state.control?.elapsed || '')}</span><form>${button('Pause', 'pause-control')}${button('Stop', 'stop-control', true)}</form></div>`;
  return `<main class="${state.page === 'tray' ? 'tray' : state.page === 'watch' ? 'watch' : ''}">${content || ''}${error}</main>`;
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
    : doing.length
      ? `Running ${doing.length} items`
      : state.worker?.state || 'Unavailable';
  const detail = doing.map((entry) => entry.name).join(' · ');
  return `<header class="tray-row tray-heading"><span class="mark">d</span>${trayText('deploy.local', connection)}${status(state.online ? 'Connected' : 'Offline', state.online ? '' : 'offline')}</header>
<hr><div class="label"><span>Waiting on you</span><span>${model.count}</span></div>
${model.items.map((item) => trayAction(`${icon('attention')}${trayText(item.title, [item.from, item.text].filter(Boolean).join(' · '))}<time class="key" datetime="${escape(item.createdAt)}">${escape(item.time)}</time>`, 'review', `<input type="hidden" name="itemId" value="${escape(item.id)}">`)).join('') || '<div class="tray-row muted">No decisions waiting</div>'}
<hr><div class="label"><span>Live</span><span>${escape(model.running)}</span></div>
${model.apps.map((entry) => trayAction(`${icon('apps')}${trayText(entry.name, entry.summary)}${status(entry.label, entry.state)}`, 'live-app', `<input type="hidden" name="appId" value="${escape(entry.appId)}">`)).join('') || trayAction(trayText('Open Live', model.live), 'live')}
<hr><div class="label"><span>This computer</span><form><button class="roles-link" name="action" value="roles" aria-label="Computer roles">${escape(state.name || 'This computer')}</button></form></div>
<div class="tray-row">${icon(tasks.length ? 'running' : 'computer')}${trayText(activity, detail)}</div>
<form><label class="tray-row task-switch">${icon('computer')}${trayText('Take new tasks', 'Current tasks keep running')}<input class="switch" type="checkbox" role="switch" name="takeTasks" data-action="take-tasks" aria-label="Take new tasks" ${model.computer?.roles.includes('take-tasks') ? 'checked' : ''} ${!state.online || !model.computer ? 'disabled' : ''}></label></form>
<hr>${trayAction(`${icon('new')}${trayText('New task')}<span class="key">${shortcut}N</span>`, 'new-task')}
${trayAction(`${icon('open')}${trayText('Open deploy.local')}<span class="key">${shortcut}O</span>`, 'home')}
${trayAction(`${trayText('Quit', 'The worker stops until you open the app again')}<span class="key">${shortcut}Q</span>`, 'quit')}`;
}
