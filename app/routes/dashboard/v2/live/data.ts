'use client';
import { useEffect, useState } from 'react';
import type { InboxItem, LiveAppResponse, LiveResponse } from '../../../../../shared/v2/contracts';
import type { V2EventsResponse } from '../../../../../shared/v2/api';
import { getAuth } from '../../detail/shared';

export async function liveRequest<T>(
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const auth = getAuth();
  const response = await fetch(`/api/v2${path}`, {
    signal,
    headers: {
      ...(auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in again to see Live.'
        : (result.error ?? 'Live is unavailable.'),
    );
  return result;
}

export function useLive(appId?: string) {
  const [live, setLive] = useState<LiveResponse>();
  const [detail, setDetail] = useState<LiveAppResponse>();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    let stopped = false;
    setLive(undefined);
    setDetail(undefined);
    async function refresh() {
      if (loading || stopped) return;
      loading = true;
      try {
        const [next, inbox, app] = await Promise.all([
          liveRequest<LiveResponse>('/live', controller.signal),
          liveRequest<{ items: InboxItem[] }>('/inbox?state=waiting', controller.signal),
          appId
            ? liveRequest<LiveAppResponse>(`/live/${encodeURIComponent(appId)}`, controller.signal)
            : undefined,
        ]);
        if (stopped) return;
        setLive(next);
        setItems(inbox.items);
        setDetail(app);
        setError('');
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : 'Live is unavailable.');
      } finally {
        loading = false;
      }
    }
    let retryTimer: ReturnType<typeof setTimeout>;
    async function poll(cursor = 0) {
      try {
        const result = await liveRequest<V2EventsResponse>(
          `/events?after=${cursor}&waitMs=10000`,
          controller.signal,
        );
        if (stopped) return;
        if (result.events.some((event) => event.type === 'health' || event.type === 'inbox'))
          await refresh();
        retryTimer = setTimeout(() => void poll(result.cursor), 100);
      } catch {
        if (!stopped) {
          setError('Live updates disconnected. Retrying…');
          retryTimer = setTimeout(() => void poll(cursor), 3000);
        }
      }
    }
    void refresh();
    void poll();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      clearTimeout(retryTimer);
    };
  }, [appId, attempt]);
  return { live, detail, items, error, retry: () => setAttempt((value) => value + 1) };
}
