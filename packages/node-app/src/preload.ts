import { contextBridge, ipcRenderer } from 'electron';
import type { NodeBridge } from './bridge.ts';
const bridge: NodeBridge = {
  status: () => ipcRenderer.invoke('node:status'),
  enroll: (url, code) => ipcRenderer.invoke('node:enroll', url, code),
  helper: (action) => ipcRenderer.invoke('node:helper', action),
  autostart: (enabled) => ipcRenderer.invoke('node:autostart', enabled),
  permissions: () => ipcRenderer.invoke('node:permissions'),
};
contextBridge.exposeInMainWorld('deployNode', bridge);
