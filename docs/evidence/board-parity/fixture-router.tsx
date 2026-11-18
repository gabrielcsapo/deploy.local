// Stand-in for react-flight-router/client: the page is mounted directly, and links reload.
// It provides every name the app imports from the router, because a missing one stops the whole
// page from loading. scripts/evidence-fixture-router.test.mjs checks that.
import type { ReactNode } from 'react';
let content: ReactNode;
export const setContent = (next: ReactNode) => {
  content = next;
};
export const Outlet = () => content;
export const useLocation = () => ({ pathname: location.pathname, search: location.search });
export const useSearchParams = () => [new URLSearchParams(location.search), () => {}] as const;
export const useRouter = () => ({ navigate: (path: string) => location.assign(path) });
export const useNavigation = () => ({ state: 'idle' as const });
export const useParams = () => ({});
export const Link = ({ to, children }: { to: string; children: ReactNode }) => (
  <a href={to}>{children}</a>
);
export const ScrollRestoration = () => null;
export const ErrorBoundary = ({ children }: { children: ReactNode }) => children;
// There is nothing to prefetch or to forget: every navigation is a full page load.
export const clearPrefetchCache = () => {};
export const prefetchRSC = () => {};
