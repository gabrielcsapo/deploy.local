import type { Interaction } from '../../../../../packages/trace/interaction';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { authenticatedFetch, remember, remembered, onAuthReset, eventFeed } from '../data/hooks';
import { useDataSeed, freshSeed, resourceKey } from '../data/seeds';
import type { Project } from '../../../../../shared/v2/contracts';
export { authenticatedFetch };
export async function request<T = any>(
  path: string,
  init: RequestInit = {},
  interaction?: Interaction,
): Promise<T> {
  const options = {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  };
  const response = await (interaction
    ? interaction.fetch(path, options, authenticatedFetch)
    : authenticatedFetch(path, options));
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}
/**
 * Whether an event can change what a page reads. A running step's progress ticks every second
 * and changes nothing on it; refreshing on each made every open page fetch again, every second.
 */
export function changesData(event: { type?: string; event?: { kind?: string; live?: boolean } }) {
  return !(event.type === 'conversation' && event.event?.kind === 'worklog' && event.event.live);
}
/**
 * Data for a path; a path read before shows its last answer at once while it refreshes.
 * `immutable` is for a path that names fixed revisions: its answer cannot change, so one read
 * is reused and events do not fetch it again. Health events otherwise redrew every preview.
 */
export function useData<T>(
  path: string | undefined,
  {
    immutable = false,
    open,
  }: { immutable?: boolean; open?: { current: Interaction | undefined } } = {},
) {
  const seed = useDataSeed();
  const lastVersion = useRef(0);
  const [answer, setAnswer] = useState<{
    path: string | undefined;
    data: T | undefined;
    seed: typeof seed;
  }>(() => ({
    path,
    seed,
    data: path ? remembered<T>(path, seed) : undefined,
  }));
  const data =
    answer.path === path && answer.seed === seed
      ? answer.data
      : path
        ? remembered<T>(path, seed)
        : undefined;
  const seededError = path ? (seed?.errors?.[resourceKey(path)] ?? '') : '';
  const [error, setError] = useState(seededError);
  const [version, refresh] = useState(0);
  useEffect(() => {
    const forced = version !== lastVersion.current;
    lastVersion.current = version;
    // A refresh retains the current answer even if the shared cache was evicted.
    setAnswer((previous) =>
      previous.path === path && previous.seed === seed
        ? previous
        : { path, seed, data: path ? remembered<T>(path, seed) : undefined },
    );
    setError(!forced ? seededError : '');
    if (!path || (!forced && freshSeed(seed, path))) return;
    if (!forced && immutable && remembered<T>(path, seed) !== undefined) return;
    const controller = new AbortController();
    request<T>(path, { signal: controller.signal }, open?.current)
      .then((value) => {
        if (controller.signal.aborted) return;
        remember(path, value);
        setAnswer({ path, seed, data: value });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [path, version, seed, seededError, immutable, open]);
  useEffect(
    () =>
      onAuthReset(() => {
        setAnswer({ path, seed: undefined, data: undefined });
        refresh((n) => n + 1);
      }),
    [path],
  );
  useEffect(() => {
    if (!seed || !path || immutable) return;
    let first = true;
    return eventFeed.subscribe({
      async snapshot(_signal, boundary) {
        if (
          !first ||
          (boundary !== undefined && seed.cursor !== undefined && boundary > seed.cursor)
        )
          refresh((n) => n + 1);
        first = false;
      },
      events(events) {
        if (events.some(changesData)) refresh((n) => n + 1);
      },
      error() {},
    });
  }, [seed, path, immutable]);
  const reload = useCallback(() => refresh((n) => n + 1), []);
  return { data, error, refresh: reload };
}
export type Work = {
  id: string;
  title: string;
  state?: string;
  status?: string;
  taskId?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type Overview = {
  project: Project;
  repository: null | {
    deployment?: { configured: boolean; pipeline?: boolean };
    defaultBranch?: string;
    head?: string;
    status: string;
    source?: {
      url?: string;
      path?: string;
      location?: string;
      kind?: string;
      syncPolicy?: string;
    };
    clonePath?: string;
    /** `/<address>.git` on this server's SSH port; the port is null when SSH is off. */
    sshClonePath?: string;
    sshPort?: number | null;
    /** No code on the default branch yet. */
    empty?: boolean;
    sync?: { state: string; at: string; changedAt: string; error?: string | null } | null;
    operation?: { id: string; kind: string; status: string; error?: string | null } | null;
  };
  repositoryError: boolean;
  tasks: Work[];
  issues: Work[];
  pulls: Work[];
  apps: Array<Project['apps'][number] & { computer?: string; memoryLimit?: string }>;
};

// The host never changes while a page is open, so there is nothing to subscribe to.
const subscribeToNothing = () => () => {};

/** The address bar's host, or nothing on the server, which has no window to read it from. */
export function useBrowserHost() {
  const origin = useBrowserOrigin();
  return origin ? new URL(origin).host : '';
}
export function useBrowserOrigin() {
  const seed = useDataSeed();
  return useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => seed?.origin ?? '',
  );
}
