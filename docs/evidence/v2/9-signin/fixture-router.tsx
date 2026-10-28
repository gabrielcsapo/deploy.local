import type { ReactNode } from 'react';
export const useLocation = () => ({
  pathname: new URLSearchParams(location.search).get('path') || '/dashboard/start',
});
export const useSearchParams = () => [new URLSearchParams(location.search), () => {}];
export const Link = ({ to, children }: { to: string; children: ReactNode }) => (
  <a href={to}>{children}</a>
);
export const Outlet = () => null;
