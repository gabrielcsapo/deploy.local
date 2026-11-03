import { useEffect, useState } from 'react';
import { rememberSidebar } from './sidebar-preference';

export interface DesktopUpdateStatus {
  phase: 'idle' | 'available' | 'downloading' | 'checking' | 'ready' | 'installing' | 'failed';
  version?: string;
  commit?: string;
  bytes?: number;
  total?: number;
  percent?: number;
  error?: 'verification' | 'network';
}
export interface DesktopUpdateApi {
  status(): Promise<DesktopUpdateStatus>;
  onChange(callback: (status: DesktopUpdateStatus) => void): () => void;
  start(): Promise<void>;
  cancel(): Promise<void>;
  restart(): Promise<void>;
}
export function desktopUpdate() {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & { deployDesktop?: { update?: DesktopUpdateApi } }).deployDesktop?.update;
}
export function useDesktopUpdate() {
  const api = desktopUpdate();
  const [status, setStatus] = useState<DesktopUpdateStatus>({ phase: 'idle' });
  useEffect(() => {
    if (!api) return;
    let active = true,
      changed = false;
    const stop = api.onChange((next) => {
      changed = true;
      if (active) setStatus(next);
    });
    void api
      .status()
      .then((next) => {
        if (active && !changed) setStatus(next);
      })
      .catch(() => {});
    return () => {
      active = false;
      stop();
    };
  }, [api]);
  return { api, status };
}
export function updateLabel(status: DesktopUpdateStatus) {
  switch (status.phase) {
    case 'available':
      return 'Update available';
    case 'downloading':
      return `Updating · ${status.percent ?? 0}%`;
    case 'checking':
      return 'Checking download…';
    case 'ready':
      return 'Restart to update';
    case 'installing':
      return 'Installing…';
    case 'failed':
      return 'Update failed';
    default:
      return '';
  }
}

export interface DesktopUpdateNavigation {
  collapsed: boolean;
  updateOpen: boolean;
}

/** Only an explicit sidebar toggle writes the preference, never update details. */
export function changeDesktopUpdateNavigation(
  state: DesktopUpdateNavigation,
  action: 'open-update' | 'close-update' | 'toggle-sidebar',
  savePreference = rememberSidebar,
): DesktopUpdateNavigation {
  if (action === 'open-update') return { ...state, updateOpen: true };
  if (action === 'close-update') return { ...state, updateOpen: false };
  if (state.collapsed && state.updateOpen) return { ...state, updateOpen: false };
  const collapsed = !state.collapsed;
  savePreference(collapsed);
  return { collapsed, updateOpen: false };
}

/** The trigger is inside the boundary, so its own click can toggle details. */
export function listenForUpdateDismissal(boundary: HTMLElement, close: () => void) {
  const doc = boundary.ownerDocument;
  const click = (event: MouseEvent) => {
    if (!event.composedPath().includes(boundary)) close();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  doc.addEventListener('click', click);
  doc.addEventListener('keydown', keydown);
  return () => {
    doc.removeEventListener('click', click);
    doc.removeEventListener('keydown', keydown);
  };
}
