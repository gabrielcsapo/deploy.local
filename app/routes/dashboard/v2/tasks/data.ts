'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Release } from '../../../../../shared/v2/contracts';
import { authenticatedFetch, eventFeed } from '../data/hooks';
import { requestJson, updateTaskFromEvents } from './api';
import type { TaskView } from './types';

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
    async function start(signal: AbortSignal) {
      try {
        const data = await requestJson<TaskView>(
          authenticatedFetch,
          `/api/v2/tasks/${encodeURIComponent(id)}`,
          { signal },
        );
        if (signal.aborted) return;
        setView((old) => ({
          ...data,
          releases: old?.task.id === id ? old.releases : data.releases,
        }));
        setError('');
        const project = data.project;
        async function loadReleases() {
          if (!project) return;
          const response = await authenticatedFetch(
            `/api/v2/projects/${encodeURIComponent(project.id)}/releases`,
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
        void loadReleases().catch((reason) => {
          if (!signal.aborted)
            setError(reason instanceof Error ? reason.message : 'Task unavailable.');
        });
      } catch (reason) {
        if (!signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Task unavailable.');
        return false;
      }
    }
    const unsubscribe = eventFeed.subscribe({
      snapshot: start,
      events(events) {
        setView((old) =>
          old
            ? updateTaskFromEvents(
                old,
                events.filter(
                  (event) =>
                    event.type === 'conversation' ||
                    event.type === 'inbox' ||
                    event.type === 'release',
                ),
              )
            : old,
        );
        setError('');
      },
      error(_reason, phase) {
        if (phase !== 'snapshot') setError('Live updates interrupted. Reconnecting…');
      },
      reset() {
        setView(null);
        setError('');
      },
    });
    const interval = setInterval(refresh, 15000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [id, version, refresh]);
  return { view: view?.task.id === id ? view : null, error, refresh, updateRelease };
}
