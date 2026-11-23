const { contextBridge, ipcRenderer } = require('electron');
const { electronProfile } = require('../../packages/trace/electron.js');
const measure = electronProfile({
  service: 'deploy.electron.renderer',
  process: 'renderer',
  send: (body) =>
    fetch('/api/control/otel/v1/traces', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
});
const invoke = (channel, ...args) =>
  measure(channel.replace(':', '.'), null, (parent) =>
    ipcRenderer.invoke(channel, parent, ...args),
  );
const api = {
  notify: (itemId) => invoke('desktop:notify', itemId),
  setBadge: (count) => invoke('desktop:badge', count),
  worker: {
    status: () => invoke('desktop:worker-status'),
    setRoles: (roles) => invoke('desktop:worker-roles', roles),
  },
  control: { request: (itemId) => invoke('desktop:control', itemId) },
  openExternal: (url) => invoke('desktop:external', url),
};
if (process.platform === 'darwin')
  api.update = {
    status: () => invoke('desktop:update-status'),
    start: () => invoke('desktop:update-start'),
    cancel: () => invoke('desktop:update-cancel'),
    restart: () => invoke('desktop:update-restart'),
    onChange: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('desktop:update', listener);
      return () => ipcRenderer.removeListener('desktop:update', listener);
    },
  };
contextBridge.exposeInMainWorld('deployDesktop', api);

// The web app uses a local marker for its signed-in UI. The real token never leaves main.
const marker = ipcRenderer.sendSync('desktop:session-marker');
if (marker) localStorage.setItem('deploy-sh-auth', JSON.stringify(marker));

// While the coordinator is unreachable the page you are on stays, with this notice over it, so a
// lost connection never takes your work away. The desktop app sends the state; nothing is read back.
ipcRenderer.on('desktop:connection', (_event, { online, name }) => {
  const apply = () => {
    let notice = document.getElementById('deploy-desktop-connection');
    if (online) return notice?.remove();
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'deploy-desktop-connection';
      notice.setAttribute('role', 'status');
      Object.assign(notice.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        maxWidth: 'calc(100vw - 32px)',
        padding: '8px 14px',
        borderRadius: 'var(--ds-radius-full, 999px)',
        border: '1px solid var(--ds-line, #2e2c33)',
        background: 'var(--ds-surface, #211f25)',
        color: 'var(--ds-warning, #f2cd91)',
        font: '500 13px/1.4 var(--ds-font, system-ui, sans-serif)',
        boxShadow: '0 4px 16px rgb(0 0 0 / 0.18)',
        pointerEvents: 'none',
      });
      document.body.append(notice);
    }
    notice.textContent = `Can't reach ${name}. Your page stays here; reconnecting…`;
  };
  if (document.body) apply();
  else window.addEventListener('DOMContentLoaded', apply, { once: true });
});

// The Mac app has no title bar. The page leaves room for the traffic lights and drags the window
// from its sidebar top row and headers (styles keyed on these classes); full screen drops both.
ipcRenderer.on('desktop:chrome', (_event, { mac, fullScreen }) => {
  const root = document.documentElement;
  root.classList.toggle('deploy-desktop-mac', !!mac);
  root.classList.toggle('deploy-desktop-fullscreen', !!fullScreen);
});
