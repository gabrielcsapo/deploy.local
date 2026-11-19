// The Design page served by `deploy design dev` has no router: one page, its place in the address.
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
};
export function useSearchParams(): [URLSearchParams, (next: URLSearchParams) => void] {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => '',
  );
  const set = useCallback((next: URLSearchParams) => {
    window.history.pushState(null, '', `?${next}`);
    for (const listener of listeners) listener();
  }, []);
  return [new URLSearchParams(search), set];
}
export function useLocation() {
  return { pathname: window.location.pathname, search: window.location.search };
}
export function useRouter() {
  return { navigate: (to: string) => window.location.assign(to), refresh: () => {} };
}
export function Link({ to, href, children, ...rest }: any): ReactNode {
  return (
    <a href={to ?? href} {...rest}>
      {children}
    </a>
  );
}
