import { useEffect, useState } from 'react';

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
      return `Downloading update · ${status.percent ?? 0}%`;
    case 'checking':
      return 'Checking download…';
    case 'ready':
      return 'Restart to update';
    case 'installing':
      return 'Installing…';
    case 'failed':
      return status.error === 'verification'
        ? 'Download could not be verified'
        : 'The download stopped.';
    default:
      return '';
  }
}
