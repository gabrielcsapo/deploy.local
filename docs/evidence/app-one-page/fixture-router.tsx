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
