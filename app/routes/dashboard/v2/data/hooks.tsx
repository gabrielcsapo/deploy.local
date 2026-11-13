'use client';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useDataSeed, freshSeed, resourceKey, type DataSeed } from './seeds';
import { getAuth } from '../../detail/shared';
import { createEventFeed } from './event-feed';
import { createInboxStore } from './inbox-store';
import { readResource } from './sidebar';
import { agentName } from '../inbox/presentation';

const AgentIdentities = createContext<
  Record<string, import('../../../../../shared/v2/contracts').AgentAvatar | undefined>
>({});
export const useAgentIdentity = () => useContext(AgentIdentities);
const AgentNames = createContext<Record<string, string>>({});
/** The sidebar's agents, so decisions and replies show an agent's name instead of its id. */
export function AgentNamesProvider({
  agents = [],
  children,
}: {
  agents?: {
    id: string;
    name: string;
    avatar?: import('../../../../../shared/v2/contracts').AgentAvatar;
  }[];
  children: ReactNode;
}) {
  const names = Object.fromEntries(agents.map((agent) => [agent.id, agent.name]));
  return (
    <AgentIdentities.Provider value={Object.fromEntries(agents.map((a) => [a.id, a.avatar]))}>
      <AgentNames.Provider value={names}>{children}</AgentNames.Provider>
    </AgentIdentities.Provider>
  );
}
export function useAgentName() {
  const names = useContext(AgentNames);
  return (id: string) => names[id] || agentName(id);
}

const CoordinatorName = createContext('the coordinator');
/** The coordinator's own name, as its owner set it, so copy never assumes what it is called. */
export function CoordinatorNameProvider({
  nodes = [],
  children,
}: {
  nodes?: { id: string; name?: string }[];
  children: ReactNode;
}) {
  const name = nodes.find((node) => node.id === 'coordinator')?.name || 'the coordinator';
  return <CoordinatorName.Provider value={name}>{children}</CoordinatorName.Provider>;
}
export function useCoordinatorName() {
  const seed = useDataSeed();
  const name = useContext(CoordinatorName);
  return seed?.coordinatorName ?? name;
}

export const authenticatedFetch: typeof fetch = (input, init) => {
  const auth = getAuth();
  const headers = new Headers(init?.headers);
  if (auth) {
    headers.set('x-deploy-username', auth.username);
    headers.set('x-deploy-token', auth.token);
  }
  return fetch(input, { ...init, headers, credentials: 'same-origin' }).then((response) => {
    if (
      response.status === 401 &&
      !init?.signal?.aborted &&
      !response.url.endsWith('/api/v2/auth/account') &&
      window.location.pathname.startsWith('/dashboard')
    )
      window.dispatchEvent(new Event('deploy:session-expired'));
    return response;
  });
};
export const eventFeed = createEventFeed(authenticatedFetch);
const authResetListeners = new Set<() => void>();
export function onAuthReset(listener: () => void) {
  authResetListeners.add(listener);
  return () => {
    authResetListeners.delete(listener);
  };
}

const InboxContext = createContext<ReturnType<typeof createInboxStore> | null>(null);
export function InboxProvider({ children }: { children: ReactNode }) {
  const seed = useDataSeed();
  const [store] = useState(() => createInboxStore(authenticatedFetch, eventFeed, seed));
  return <InboxContext.Provider value={store}>{children}</InboxContext.Provider>;
}
export function useInbox() {
  const store = useContext(InboxContext);
  if (!store) throw new Error('InboxProvider is required');
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return { ...snapshot, answer: store.answer, retry: store.retry };
}

/**
 * The last answer for each path, so a page that mounts again (switching tabs, going back) shows
 * what it had at once and refreshes behind it instead of blanking to a loading state.
 */
const resources = new Map<string, { data: unknown; at: number }>();
let resourceIdentity: string | undefined;
function browserResources() {
  if (typeof window === 'undefined') return undefined;
  const identity = JSON.stringify(getAuth());
  if (identity !== resourceIdentity) {
    resources.clear();
    resourceIdentity = identity;
  }
  return resources;
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key !== 'deploy-sh-auth' && event.key !== null) return;
    resources.clear();
    eventFeed.reset();
    for (const reset of authResetListeners) reset();
  });
export const remembered = <T,>(path: string, seed?: DataSeed): T | undefined => {
  path = resourceKey(path);
  const cached = browserResources()?.get(path);
  if (seed && Object.hasOwn(seed.data, path) && (!cached || cached.at <= seed.at))
    return seed.data[path] as T;
  return cached?.data as T | undefined;
};
export const remember = (path: string, data: unknown) =>
  browserResources()?.set(resourceKey(path), { data, at: Date.now() });

export const EVENT_REFRESH_SPACING_MS = 5000;
export function useResource<T>(
  path: string,
  optional = false,
): { data: T | null; loading: boolean; error: boolean } {
  const seed = useDataSeed();
  const initial = (): {
    path: string;
    seed: DataSeed | undefined;
    data: T | null;
    loading: boolean;
    error: boolean;
  } => {
    const data = remembered<T | null>(path, seed);
    return {
      path,
      seed,
      data: data ?? null,
      loading: data === undefined && !seed?.errors?.[resourceKey(path)],
      error: !!seed?.errors?.[resourceKey(path)],
    };
  };
  const [state, setState] = useState(initial);
  useEffect(() => {
    const data = remembered<T | null>(path, seed);
    setState({
      path,
      seed,
      data: data ?? null,
      loading: data === undefined && !seed?.errors?.[resourceKey(path)],
      error: !!seed?.errors?.[resourceKey(path)],
    });
    let controller: AbortController;
    let timer: ReturnType<typeof setTimeout>;
    // Health checks and work progress arrive every few seconds on a busy server. They refresh a
    // seeded resource at most this often; releases, rollbacks, inbox and agent changes are immediate.
    let last = freshSeed(seed, path) ? seed!.at : 0;
    let spaced = false;
    const refresh = async () => {
      last = Date.now();
      spaced = false;
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const data = await readResource<T>(authenticatedFetch, path, signal, optional);
        if (!signal.aborted) {
          remember(path, data);
          setState({ path, seed, data, loading: false, error: false });
        }
      } catch {
        if (!signal.aborted) setState((previous) => ({ ...previous, loading: false, error: true }));
      }
      if (!signal.aborted) timer = setTimeout(() => void refresh(), 10000);
    };
    const changed = () => {
      controller?.abort();
      clearTimeout(timer);
      void refresh();
    };
    const soon = () => {
      if (spaced) return;
      const wait = last + EVENT_REFRESH_SPACING_MS - Date.now();
      if (wait <= 0) return changed();
      spaced = true;
      controller?.abort();
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), wait);
    };
    const reset = () => {
      setState({ path, seed: undefined, data: null, loading: true, error: false });
      changed();
    };
    if (freshSeed(seed, path))
      timer = setTimeout(() => void refresh(), Math.max(0, 10000 - (Date.now() - seed!.at)));
    else void refresh();
    let first = true;
    const offEvents = seed
      ? eventFeed.subscribe({
          async snapshot(_signal, boundary) {
            // A reconnect may have missed anything. The first catch-up is seconds old at most.
            if (!first) changed();
            else if (boundary !== undefined && seed.cursor !== undefined && boundary > seed.cursor)
              soon();
            first = false;
          },
          events(events) {
            if (events.some((event) => event.type !== 'health' && event.type !== 'conversation'))
              changed();
            else if (events.length) soon();
          },
          error() {},
        })
      : undefined;
    window.addEventListener('deploy:agents-changed', changed);
    const offReset = onAuthReset(reset);
    return () => {
      controller?.abort();
      clearTimeout(timer);
      offReset();
      offEvents?.();
      window.removeEventListener('deploy:agents-changed', changed);
    };
  }, [path, optional, seed]);
  return state.path === path && state.seed === seed ? state : initial();
}
