'use client';
import { useEffect, useState } from 'react';
import type { InboxItem, LiveAppResponse, LiveResponse } from '../../../../../shared/v2/contracts';
import { authenticatedFetch, eventFeed, remember, remembered } from '../data/hooks';
import { useDataSeed, freshSeed } from '../data/seeds';

export async function liveRequest<T>(
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await authenticatedFetch(`/api/v2${path}`, {
    signal,
    headers: {
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
  const seed = useDataSeed();
  const detailKey = appId && `/api/v2/live/${encodeURIComponent(appId)}`;
  const initialLive = () => remembered<LiveResponse>('/api/v2/live', seed);
  const initialDetail = () =>
    detailKey ? remembered<LiveAppResponse>(detailKey, seed) : undefined;
  const initialItems = () =>
    remembered<{ items: InboxItem[] }>('/api/v2/inbox?state=waiting', seed)?.items ?? [];
  const [loadedSeed, setLoadedSeed] = useState(seed);
  const [live, setLive] = useState(initialLive);
  const [detail, setDetail] = useState(() =>
    detailKey ? remembered<LiveAppResponse>(detailKey, seed) : undefined,
  );
  const [items, setItems] = useState<InboxItem[]>(() => (seed ? initialItems() : []));
  const [error, setError] = useState(
    () => seed?.errors?.[detailKey || '/api/v2/live'] ?? seed?.errors?.['/api/v2/live'] ?? '',
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let controller = new AbortController();
    let loading: Promise<boolean> | undefined;
    let stopped = false;
    let loaded =
      !!seed &&
      !!remembered<LiveResponse>('/api/v2/live', seed) &&
      (!detailKey || !!remembered<LiveAppResponse>(detailKey, seed));
    let skipSnapshot =
      attempt === 0 &&
      freshSeed(seed, '/api/v2/live') &&
      freshSeed(seed, '/api/v2/inbox?state=waiting') &&
      (!detailKey || freshSeed(seed, detailKey));
    // What Live showed last stays on screen while it refreshes.
    setLoadedSeed(seed);
    setLive(remembered<LiveResponse>('/api/v2/live', seed));
    setDetail(detailKey ? remembered<LiveAppResponse>(detailKey, seed) : undefined);
    if (seed)
      setItems(
        remembered<{ items: InboxItem[] }>('/api/v2/inbox?state=waiting', seed)?.items ?? [],
      );
    async function refresh(signal = controller.signal): Promise<boolean> {
      // An event may arrive during a periodic read. Finish that read, then take another
      // snapshot; merely sharing its promise could miss the event that triggered us.
      if (loading) await loading;
      signal = AbortSignal.any([signal, controller.signal]);
      if (stopped || signal.aborted) return false;
      const pending = load(signal);
      loading = pending;
      try {
        return await pending;
      } finally {
        if (loading === pending) loading = undefined;
      }
    }
    async function load(signal: AbortSignal) {
      try {
        const [next, inbox, app] = await Promise.all([
          liveRequest<LiveResponse>('/live', signal),
          liveRequest<{ items: InboxItem[] }>('/inbox?state=waiting', signal),
          appId
            ? liveRequest<LiveAppResponse>(`/live/${encodeURIComponent(appId)}`, signal)
            : undefined,
        ]);
        if (stopped || signal.aborted) return false;
        remember('/api/v2/live', next);
        if (detailKey) remember(detailKey, app);
        setLive(next);
        setItems(inbox.items);
        setDetail(app);
        setError('');
        loaded = true;
        return true;
      } catch (reason) {
        if (!stopped && !signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Live is unavailable.');
        return false;
      }
    }
    const unsubscribe = eventFeed.subscribe({
      async snapshot(signal, boundary) {
        const skip = skipSnapshot;
        skipSnapshot = false;
        if (
          skip &&
          !(boundary !== undefined && seed?.cursor !== undefined && boundary > seed.cursor)
        )
          return;
        await refresh(signal);
      },
      async events(events, signal) {
        if (events.some((event) => ['health', 'inbox', 'release', 'rollback'].includes(event.type)))
          if (!(await refresh(signal))) throw new Error('Snapshot unavailable');
      },
      error(_reason, phase) {
        if (phase === 'connection' || !loaded) setError('Live updates disconnected. Retrying…');
      },
      reset() {
        loaded = false;
        controller.abort();
        controller = new AbortController();
        loading = undefined;
        setLive(undefined);
        setDetail(undefined);
        setItems([]);
        setError('');
      },
    });
    const timer = setInterval(() => {
      if (!loading) void refresh();
    }, 15_000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      unsubscribe();
    };
  }, [appId, detailKey, attempt, seed]);
  return {
    live: loadedSeed === seed ? live : initialLive(),
    detail: loadedSeed === seed ? detail : initialDetail(),
    items: loadedSeed === seed ? items : initialItems(),
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}
