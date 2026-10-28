const { contextBridge, ipcRenderer } = require('electron');
const api = {
  notify: (itemId) => ipcRenderer.invoke('desktop:notify', itemId),
  setBadge: (count) => ipcRenderer.invoke('desktop:badge', count),
  worker: {
    status: () => ipcRenderer.invoke('desktop:worker-status'),
    setRoles: (roles) => ipcRenderer.invoke('desktop:worker-roles', roles),
  },
  control: { request: (itemId) => ipcRenderer.invoke('desktop:control', itemId) },
  openExternal: (url) => ipcRenderer.invoke('desktop:external', url),
};
contextBridge.exposeInMainWorld('deployDesktop', api);

// The web app uses a local marker for its signed-in UI. The real token never leaves main.
const marker = ipcRenderer.sendSync('desktop:session-marker');
if (marker) localStorage.setItem('deploy-sh-auth', JSON.stringify(marker));
