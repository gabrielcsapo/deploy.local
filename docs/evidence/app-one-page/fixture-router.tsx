import type { ReactNode } from 'react';
export const useLocation = () => ({ pathname: location.pathname });
export const useSearchParams = () =>
  [
    new URLSearchParams(location.search),
    (value: URLSearchParams) => {
      location.search = value.toString();
    },
  ] as const;
export const useRouter = () => ({
  navigate: (url: string) => location.assign(url),
  push: (url: string) => location.assign(url),
  replace: (url: string) => location.replace(url),
});
export const Link = ({ to, children }: { to: string; children: ReactNode }) => (
  <a href={to}>{children}</a>
);
export const Outlet = () => null;
// The app has since started using these; the fixture has no router to prefetch or restore.
export const clearPrefetchCache = () => {};
export const prefetchRSC = () => {};
export const useNavigation = () => ({ state: 'idle' as const });
export const useParams = () => ({});
export const ScrollRestoration = () => null;
export const RouterProvider = ({ children }: { children?: ReactNode }) => <>{children}</>;
export const ErrorBoundary = ({ children }: { children?: ReactNode }) => <>{children}</>;
