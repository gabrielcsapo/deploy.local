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
