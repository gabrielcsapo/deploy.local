import type { ReactNode } from 'react';
let content: ReactNode;
export const setContent = (next: ReactNode) => {
  content = next;
};
export const Outlet = () => content;
export const useLocation = () => ({ pathname: location.pathname, search: location.search });
export const useSearchParams = () => [new URLSearchParams(location.search), () => {}] as const;
export const useRouter = () => ({ navigate: (path: string) => location.assign(path) });
export const Link = ({ to, children }: { to: string; children: ReactNode }) => (
  <a href={to}>{children}</a>
);
