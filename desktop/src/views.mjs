import { liveLabel } from './model.mjs';
export const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const button = (label, action, primary = false) =>
  `<button name="action" value="${action}" class="${primary ? 'primary' : ''}">${escape(label)}</button>`;
const row = (title, detail, end = '') =>
  `<div class="row"><span><b>${escape(title)}</b><small>${escape(detail)}</small></span>${end}</div>`;
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
    content = `${steps(1)}<h1>Let ${name} help?</h1><p>You're signed in to deploy.local on ${escape(state.coordinatorName || new URL(state.origin).hostname)}. ${name} can also do work for your agents. It joins Computers, and you can change this here anytime.</p><section>${row(state.name, state.hardware, '<small>This computer</small>')}${row('Claude', 'Availability is checked by the worker after joining')}${row('Codex', 'Availability is checked by the worker after joining')}</section><form><section>${role('takeTasks', 'Take tasks', 'Coding agents work here in their own folders, with your local accounts.')}${role('runApps', 'Run apps', 'Not available through the workspace worker yet.', true)}${role('serveModels', 'Serve models', 'Not available through the workspace worker yet.', true)}${role('useScreen', 'Use the screen', state.screenSupported ? 'Asks you each time. Needs Screen Recording and Accessibility.' : state.platform === 'darwin' ? 'The macOS control helper is not included in this build.' : 'Not supported on Windows or Linux yet.', !state.screenSupported)}</section><small class="footnote">The worker keeps running when you close the window. Pause or quit it from the tray.</small><footer>${button('Just use the app', 'skip')}${button(`Add ${state.name}`, 'join', true)}</footer></form>`;
  } else if (state.page === 'permissions')
    content = `${steps(2)}<h1>Let agents use the screen?</h1><p>Optional. macOS needs two permissions before an agent can see and control an app on this Mac, such as Simulator for checking an iPhone build.</p><form><section>${row('Screen Recording', 'See the one app a task is allowed to use', button('Open System Settings', 'screen-settings'))}${row('Accessibility', 'Click and type in that app', button('Open System Settings', 'accessibility-settings'))}</section><p class="notice">deploy.local can't turn these on itself, and they don't let agents in on their own. Each task still asks you, for one app at a time.</p><footer>${button('Skip for now', 'finish')}${button('Finish', 'finish', true)}</footer></form>`;
  else if (state.page === 'offline')
    content = `<div class="empty"><span class="glyph">☁</span><h2>Can't reach ${escape(state.coordinatorName || new URL(state.origin).hostname)}</h2><p>${escape(state.origin)} stopped answering${state.lastSeen ? ` at ${escape(new Date(state.lastSeen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}. Retrying every 10 s.</p><form>${button('Try now', 'retry', true)}${button('Use another coordinator', 'switch')}</form></div><h2>On this computer</h2><section>${row('Worker', state.worker?.state || 'Unavailable')}${row('Last known', state.lastSeen ? `${state.inbox?.length || 0} waiting on you · ${liveLabel(state.summary)}` : 'Unavailable', '<small>Saved</small>')}${row('Drafts', 'Return to the web app when the coordinator reconnects.')}</section><small>If it stays down, check its power and network, or run deploy status on the coordinator.</small>`;
  else if (state.page === 'tray')
    content = `<div class="tray-heading"><b><span class="mark">d</span> deploy.local</b><small>${state.online ? '● Connected' : '○ Offline'}</small></div><div class="label">Waiting on you <span>${state.inbox?.length || 0}</span></div>${(state.inbox || []).map((item) => `<form class="tray-item"><input type="hidden" name="itemId" value="${escape(item.id)}">${button(`!  ${item.title}`, 'review')}<small>${escape(item.from)}</small></form>`).join('') || '<p>No decisions waiting</p>'}<hr><div class="label">Live <span>${escape(liveLabel(state.summary))}</span></div><form>${button('Open Live', 'live')}</form><hr><div class="label">This computer <span>${name}</span></div>${row(state.worker?.state || 'Stopped', 'The worker stops when you quit.')}<form>${button('Computer roles', 'roles')}${button('New task', 'home')}${button('Open deploy.local', 'home')}${button('Quit', 'quit')}</form>`;
  else if (state.page === 'decision')
    content = `<h1>${escape(state.item?.title)}</h1><p>${escape(state.item?.text)}</p><small>From ${escape(state.item?.from)} · Waiting on you</small><form><input type="hidden" name="itemId" value="${escape(state.item?.id)}">${state.item?.kind === 'question' ? '<label>Your answer<textarea name="note"></textarea></label>' : ''}<footer>${(state.item?.actions || []).map((action) => `<button name="action" value="answer:${escape(action.id)}" class="${action.primary ? 'primary' : ''}">${escape(action.label)}</button>`).join('')}${button('Back', 'home')}</footer></form>`;
  else if (state.page === 'watch')
    content = `<div class="control-bar"><span class="recording"></span><span>${escape(state.control?.label || 'Agent is using the screen')}</span><span>${escape(state.control?.elapsed || '')}</span><form>${button('Pause', 'pause-control')}${button('Stop', 'stop-control', true)}</form></div>`;
  return `<main class="${state.page === 'tray' ? 'tray' : state.page === 'watch' ? 'watch' : ''}">${content || ''}${error}</main>`;
}
