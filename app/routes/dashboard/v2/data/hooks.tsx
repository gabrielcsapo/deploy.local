'use client';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getAuth } from '../../detail/shared';
import { createInboxStore } from './inbox-store';
import { readResource } from './sidebar';
import { agentName } from '../inbox/presentation';

const AgentNames = createContext<Record<string, string>>({});
/** The sidebar's agents, so decisions and replies show an agent's name instead of its id. */
export function AgentNamesProvider({
  agents = [],
  children,
}: {
  agents?: { id: string; name: string }[];
  children: ReactNode;
}) {
  const names = Object.fromEntries(agents.map((agent) => [agent.id, agent.name]));
  return <AgentNames.Provider value={names}>{children}</AgentNames.Provider>;
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
  return useContext(CoordinatorName);
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
      !response.url.endsWith('/api/v2/auth/account') &&
      window.location.pathname.startsWith('/dashboard')
    )
      window.dispatchEvent(new Event('deploy:session-expired'));
    return response;
  });
};
const InboxContext = createContext<ReturnType<typeof createInboxStore> | null>(null);
export function InboxProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createInboxStore(authenticatedFetch));
  useEffect(() => {
    const reset = (event: StorageEvent) => {
      if (event.key === 'deploy-sh-auth' || event.key === null) store.reset();
    };
    window.addEventListener('storage', reset);
    return () => window.removeEventListener('storage', reset);
  }, [store]);
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

export function useResource<T>(path: string, optional = false) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false,
  });
  useEffect(() => {
    let controller: AbortController;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const data = await readResource<T>(authenticatedFetch, path, signal, optional);
        if (!signal.aborted) setState({ data, loading: false, error: false });
      } catch {
        if (!signal.aborted) setState({ data: null, loading: false, error: true });
      }
      if (!signal.aborted) timer = setTimeout(() => void refresh(), 10000);
    };
    const reset = (event: StorageEvent) => {
      if (event.key !== 'deploy-sh-auth' && event.key !== null) return;
      controller?.abort();
      clearTimeout(timer);
      setState({ data: null, loading: true, error: false });
      void refresh();
    };
    void refresh();
    window.addEventListener('storage', reset);
    return () => {
      controller?.abort();
      clearTimeout(timer);
      window.removeEventListener('storage', reset);
    };
  }, [path, optional]);
  return state;
}
