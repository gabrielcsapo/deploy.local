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
// The app's tabs pass Link a function of the link's state and their own attributes.
export const Link = ({
  to,
  children,
  ...rest
}: {
  to: string;
  children: ReactNode | ((state: { isActive: boolean; isPending: boolean }) => ReactNode);
  [attribute: string]: unknown;
}) => (
  <a href={to} {...(rest as object)}>
    {typeof children === 'function'
      ? children({ isActive: location.pathname === to, isPending: false })
      : children}
  </a>
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
