'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Release } from '../../../../../shared/v2/contracts';
import { useDataSeed, readSeeded } from '../data/seeds';
import { authenticatedFetch, eventFeed } from '../data/hooks';
import { requestJson, updateTaskFromEvents } from './api';
import type { TaskView } from './types';

export function useTask(id: string) {
  const seed = useDataSeed();
  const path = `/api/task-snapshots/${encodeURIComponent(id)}`;
  const [view, setView] = useState<TaskView | null>(() => (seed?.data[path] as TaskView) ?? null);
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
    let first = version === 0;
    async function start(signal: AbortSignal, boundary?: number) {
      const initial = first && (boundary ?? 0) <= (seed?.cursor ?? -1);
      first = false;
      try {
        const data = await readSeeded(initial ? seed : undefined, path, () =>
          requestJson<TaskView>(authenticatedFetch, path, { signal }),
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
          const releasePath = `/api/projects/${encodeURIComponent(project.id)}/releases`;
          const body = await readSeeded(version === 0 ? seed : undefined, releasePath, async () => {
            const response = await authenticatedFetch(releasePath, { signal });
            return response.ok ? response.json() : { releases: [] };
          });
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
        // Deleted elsewhere: the page is Not found, as a fresh load of it would be.
        if (events.some((event) => event.type === 'task-deleted' && event.taskId === id)) {
          setView(null);
          setError('Not found');
          return;
        }
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
  }, [id, path, seed, version, refresh]);
  return { view: view?.task.id === id ? view : null, error, refresh, updateRelease };
}
