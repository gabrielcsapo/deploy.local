'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Release } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
import { requestJson, updateTaskFromEvents, type TaskStreamEvent } from './api';
import type { TaskView } from './types';

type Stream = { cursor: number; events: TaskStreamEvent[] };
export function useTask(id: string) {
  const [view, setView] = useState<TaskView | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const updateRelease = useCallback(
    (release: Release) =>
      setView((old) =>
        old
          ? {
              ...old,
              releases: [...old.releases.filter((item) => item.id !== release.id), release],
            }
          : old,
      ),
    [],
  );
  useEffect(() => {
    const reset = (event: StorageEvent) => {
      if (event.key !== 'deploy-sh-auth' && event.key !== null) return;
      setView(null);
      setError('');
      refresh();
    };
    window.addEventListener('storage', reset);
    return () => window.removeEventListener('storage', reset);
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    async function start() {
      try {
        const data = await requestJson<TaskView>(
          authenticatedFetch,
          `/api/v2/tasks/${encodeURIComponent(id)}`,
          { signal },
        );
        if (signal.aborted) return;
        cursor = data.cursor;
        setView((old) => ({
          ...data,
          releases: old?.task.id === id ? old.releases : data.releases,
        }));
        setError('');
        void poll();
        if (data.project) {
          const response = await authenticatedFetch(
            `/api/v2/projects/${encodeURIComponent(data.project.id)}/releases`,
            { signal },
          );
          if (response.ok) {
            const body = await response.json();
            const releases = Array.isArray(body) ? body : body.releases;
            if (Array.isArray(releases) && !signal.aborted)
              setView((old) =>
                old
                  ? {
                      ...old,
                      releases: [
                        ...new Map(
                          [...old.releases, ...releases].map((release) => [release.id, release]),
                        ).values(),
                      ],
                    }
                  : old,
              );
          }
        }
      } catch (reason) {
        if (!signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Task unavailable.');
      }
    }
    async function poll() {
      try {
        const page = await requestJson<Stream>(
          authenticatedFetch,
          `/api/v2/events?after=${cursor}&waitMs=10000`,
          { signal },
        );
        if (signal.aborted) return;
        cursor = page.cursor;
        setView((old) => (old ? updateTaskFromEvents(old, page.events) : old));
        setError('');
      } catch {
        if (!signal.aborted) setError('Live updates interrupted. Reconnecting…');
      }
      if (!signal.aborted) timer = setTimeout(() => void poll(), 1000);
    }
    void start();
    const interval = setInterval(refresh, 15000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [id, version, refresh]);
  return { view: view?.task.id === id ? view : null, error, refresh, updateRelease };
}
