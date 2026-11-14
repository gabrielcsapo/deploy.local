'use client';
import { useEffect, useState } from 'react';
import type { SelfUpdateStatus } from '../../../../../shared/v2/contracts';
import { authenticatedFetch, remember, remembered } from './hooks';

const path = '/api/self-update';
const changed = 'deploy:self-update';
/**
 * The coordinator's own update. Polls slowly, every 3 s while an update runs or the coordinator
 * is unreachable (it restarts mid-update), and keeps the last answer while it is.
 */
export function useSelfUpdate() {
  const [status, setStatus] = useState(() => remembered<SelfUpdateStatus>(path));
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let delay = 60_000;
      try {
        const response = await authenticatedFetch(path, { signal: controller.signal });
        if (response.status >= 500) throw new Error('unavailable');
        if (response.ok) {
          const next = (await response.json()) as SelfUpdateStatus;
          remember(path, next);
          setStatus(next);
          if (next.supported && next.run?.state === 'running') delay = 3000;
        }
        setOffline(false);
      } catch {
        if (controller.signal.aborted) return;
        setOffline(true);
        delay = 3000;
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), delay);
    };
    void load();
    const again = () => setAttempt((value) => value + 1);
    window.addEventListener(changed, again);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener(changed, again);
    };
  }, [attempt]);
  return { status, offline };
}

async function send(method: string, body?: unknown) {
  const response = await authenticatedFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The update could not start.');
  remember(path, result);
  window.dispatchEvent(new Event(changed));
  return result as SelfUpdateStatus;
}
export const startSelfUpdate = (to: string) => send('POST', { to });
export async function selfUpdateLog() {
  const response = await authenticatedFetch(`${path}/log`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The log is unavailable.');
  return (result as { text: string }).text;
}
